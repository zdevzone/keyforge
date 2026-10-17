import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import type { BackupJob, BackupService } from "./backups.js";
import { clearApplicationRows, lockResetTables, seededAdministrator } from "./maintenance.js";
import { atomic, DomainError, type RecordValue } from "./platform-store.js";
import { WORKSPACE, type Platform } from "./platform.js";

interface ResetReceipt extends RecordValue {
  completedAt: string;
  preservedAdmin: { id: string; email: string };
  backupId: string | null;
}
const inputSchema = z
  .object({
    confirmation: z.literal("DELETE ALL"),
    backup: z.boolean(),
    requestId: z.string().uuid(),
  })
  .strict();

/** Drain this server's requests before taking database writer locks. Database
 * locks also exclude other instances' writes throughout capture/verification. */
export function resetRequestBarrier(app: FastifyInstance) {
  let resetting = false;
  const active = new Set<FastifyRequest>();
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.split("?")[0] === "/healthz") return;
    if (resetting)
      return reply.code(503).header("Retry-After", "5").send({
        error: "reset_in_progress",
        message: "Application reset is in progress. Try again shortly.",
        retryable: true,
      });
    active.add(req);
    // Browser navigation can close a response before Fastify's onResponse hook.
    reply.raw.once("close", () => active.delete(req));
  });
  app.addHook("onResponse", async (req) => {
    active.delete(req);
  });
  app.addHook("onRequestAbort", async (req) => {
    active.delete(req);
  });
  return async <T>(req: FastifyRequest, work: () => Promise<T>) => {
    if (resetting)
      throw new DomainError("reset_in_progress", "Another reset is already in progress.", 409);
    resetting = true;
    try {
      const deadline = Date.now() + 30000;
      while ([...active].some((request) => request !== req)) {
        if (Date.now() >= deadline)
          throw new DomainError(
            "reset_busy",
            "Requests are still running. Wait for them to finish before resetting.",
            409,
          );
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return await work();
    } finally {
      resetting = false;
    }
  };
}

export function registerSystemReset(
  app: FastifyInstance,
  platform: Platform,
  backups: BackupService,
  gate: Platform["options"]["gate"],
  barrier: ReturnType<typeof resetRequestBarrier>,
) {
  const handler =
    (work: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = await gate(req, reply);
      if (!actor) return;
      if (actor.role !== "admin")
        return reply
          .code(403)
          .send({ error: "insufficient_role", message: "Admin access required." });
      if (
        req.method !== "GET" &&
        actor.actor !== "cli" &&
        req.headers.origin &&
        !["http://" + req.headers.host, "https://" + req.headers.host].includes(req.headers.origin)
      )
        return reply
          .code(403)
          .send({ error: "invalid_origin", message: "Origin does not match this console." });
      try {
        return await work(req, reply);
      } catch (error) {
        return reply
          .code(
            error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500,
          )
          .send({
            error:
              error instanceof DomainError
                ? error.code
                : error instanceof z.ZodError
                  ? "bad_request"
                  : "reset_failed",
            message:
              error instanceof DomainError
                ? error.message
                : error instanceof z.ZodError
                  ? "Type DELETE ALL and choose whether to create a backup."
                  : "Reset failed. No partial reset was applied. You can retry this confirmation.",
            retryable: false,
          });
      }
    };
  app.get(
    "/admin/system/reset",
    handler(async () => {
      const admin = platform.options.auth
        ? await seededAdministrator(platform.options.database)
        : null;
      return {
        preservedAdmin: admin,
        available: Boolean(admin),
        reason: admin
          ? null
          : "The first seeded administrator could not be identified. Configure the original LICENSE_SEED_ADMIN_EMAIL and LICENSE_SEED_ADMIN_PASSWORD and restart; existing credentials are never overwritten.",
        backupAvailable: Boolean(backups.options.enabled && backups.options.keyring),
        backupRequirement:
          platform.options.database.engine === "postgres"
            ? backups.options.portablePostgres
              ? "An encrypted external archive is restored and checked in a separate, initialized verification database before any reset."
              : "Encrypted archive verification requires pg_dump, pg_restore and a separate LICENSE_BACKUP_VERIFY_DATABASE_URL with temporary-database permission."
            : "An encrypted archive requires LICENSE_BACKUP_KEYRING and enabled backups.",
      };
    }),
  );
  app.post(
    "/admin/system/reset",
    handler(async (req) => {
      const input = inputSchema.parse(req.body);
      if (!platform.options.auth)
        throw new DomainError(
          "reset_unavailable",
          "Operator authentication must be enabled before resetting.",
          503,
        );
      return barrier(req, async () => {
        backups.paused = true;
        let backup: BackupJob | undefined;
        try {
          const completed = await platform.records.get<ResetReceipt>(
            WORKSPACE,
            "system-reset",
            input.requestId,
          );
          if (completed) return { ...completed, replayed: true };
          if (input.backup) {
            if (!backups.options.enabled)
              throw new DomainError(
                "backups_disabled",
                "Enable backups before requesting a reset backup.",
                503,
              );
            // Configuration lookup uses the main connection, before the reset
            // transaction reserves it (SQLite has a single Kysely connection).
            await backups.preflight(await backups.defaultDestination());
          }
          return await atomic(platform.options.database, async (records) => {
            const prior = await records.get<ResetReceipt>(
              WORKSPACE,
              "system-reset",
              input.requestId,
            );
            if (prior) return { ...prior, replayed: true };
            const owned = await lockResetTables(platform.options.database, records);
            const admin = await seededAdministrator(platform.options.database, records);
            if (!admin)
              throw new DomainError(
                "reset_unavailable",
                "The first seeded administrator is missing, banned or no longer an admin. No data was reset.",
                409,
              );
            const jobs = await records.list<BackupJob>(WORKSPACE, "backup");
            if (jobs.some((job) => job.status === "running"))
              throw new DomainError(
                "reset_busy",
                "A backup is running. Wait for it to finish before resetting.",
                409,
              );
            if (input.backup) {
              if (!backups.options.enabled)
                throw new DomainError(
                  "backups_disabled",
                  "Enable backups before requesting a reset backup.",
                  503,
                );
              backup = await backups.verifiedResetBackup(false, records);
            }
            await clearApplicationRows(platform.options.database, records, owned, admin.id);
            await platform.bootstrap(records);
            if (backup) await records.put(WORKSPACE, "backup", backup);
            const receipt: ResetReceipt = {
              id: input.requestId,
              completedAt: platform.time(),
              preservedAdmin: admin,
              backupId: backup?.id ?? null,
            };
            await records.put(WORKSPACE, "system-reset", receipt);
            return { ...receipt, replayed: false };
          });
        } catch (error) {
          // A verified archive remains downloadable even if the delete transaction fails.
          if (backup)
            await atomic(platform.options.database, (r) => r.put(WORKSPACE, "backup", backup!));
          throw error;
        } finally {
          backups.paused = false;
        }
      });
    }),
  );
}
