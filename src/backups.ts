import { execFile } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import SQLite from "better-sqlite3";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";

import {
  BackupDestinations,
  customDestinationSchema,
  nextBackupTime,
  type CustomDestination,
  type StorageOptions,
  type RemoteFile,
} from "./backup-destinations.js";
import { BackupStorage, storageProvider, storageSettingsSchema } from "./backup-storage.js";
import { createPostgresPool } from "./database.js";
import {
  atomic,
  DomainError,
  Vault,
  type KeyRing,
  type RecordValue,
  type Records,
} from "./platform-store.js";
import { WORKSPACE, type Platform } from "./platform.js";
import {
  capturePostgresSnapshot,
  parsePostgresSnapshot,
  restorePostgresSnapshot,
} from "./postgres-archive.js";
import { postgresCliConnection } from "./postgres-cli.js";

const execute = promisify(execFile);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export interface BackupOptions extends StorageOptions {
  portablePostgres?: boolean;
  defaultDestination?: string;
  /** Hosted invocations keep this work alive until completion. */
  background?: (work: Promise<void>) => void;
  cronSecret?: string;
  enabled?: boolean;
  authDbPath?: string;
  directory?: string;
  databaseUrl?: string;
  keyring?: KeyRing;
  verificationUrl?: string;
}
export interface BackupJob extends RecordValue {
  status: "queued" | "running" | "completed" | "failed";
  phase?: "snapshot" | "upload" | "complete";
  createdAt: string;
  completedAt?: string;
  engine: string;
  destination: string;
  destinationName?: string;
  destinationConfig?: CustomDestination;
  storageVersion?: string;
  remoteFile?: RemoteFile;
  size?: number;
  checksum?: string;
  error?: string;
  errorCode?: string;
  verifiedAt?: string;
  leaseUntil?: string;
  pruned?: boolean;
  cacheAvailable?: boolean;
  retentionError?: string;
  remoteRetained?: boolean;
}
export interface Schedule extends RecordValue {
  enabled: boolean;
  hourUTC: number;
  minuteUTC?: number;
  retentionDays: number;
  destination: string;
  nextAt: string;
  migratedTo?: string;
}
export const backupScheduleSchema = z
  .object({
    enabled: z.boolean(),
    hourUTC: z.number().int().min(0).max(23),
    minuteUTC: z.number().int().min(0).max(59).default(0),
    retentionDays: z.number().int().min(1).max(3650),
    revision: z.number().int().optional(),
  })
  .strict();
interface Archive {
  version: 1 | 2;
  engine: "sqlite" | "postgres";
  capturedAt: string;
  files: { name: string; checksum: string; capturedAt: string; data: string }[];
}
export class BackupService {
  paused = false;
  vault: Vault;
  directory: string;
  destinations: BackupDestinations;
  storage: BackupStorage;
  workerError?: string;
  constructor(
    public platform: Platform,
    public options: BackupOptions,
  ) {
    this.vault = new Vault(options.keyring);
    this.directory = resolve(options.directory ?? "./backups");
    this.destinations = new BackupDestinations(options);
    this.storage = new BackupStorage(platform, options);
  }
  async custom() {
    return this.platform.records.list<CustomDestination>(WORKSPACE, "backup-destination");
  }
  async defaultDestination(records = this.platform.records) {
    return (
      (
        await records.get<{ id: string; destination: string }>(
          WORKSPACE,
          "backup-settings",
          "default",
        )
      )?.destination ??
      this.options.defaultDestination ??
      "local"
    );
  }
  async statuses() {
    await this.storage.migrate();
    const statuses = await this.destinations.statuses(await this.custom());
    for (const provider of storageProvider.options) {
      if (!(await this.storage.version(provider))) continue;
      const manager = new BackupDestinations(await this.storage.resolve(provider));
      try {
        const status = (await manager.statuses([])).find((d) => d.id === provider)!;
        Object.assign(
          statuses.find((d) => d.id === provider)!,
          status,
        );
      } finally {
        manager.close();
      }
    }
    return statuses;
  }
  async driver(
    job: Pick<BackupJob, "destination" | "storageVersion" | "destinationConfig">,
    records?: Records,
  ) {
    if (job.storageVersion || (await this.storage.version(job.destination, records)))
      return this.storage.driver(job.destination, job.storageVersion, records);
    if (job.destinationConfig?.encryptedHeaderValue) {
      const value = this.platform.vault.decrypt(
        job.destinationConfig.encryptedHeaderValue,
        "backup-custom:" + job.destination,
      );
      const manager = new BackupDestinations({}, { LICENSE_BACKUP_CUSTOM_DATABASE: value });
      return manager.driver(job.destination, {
        ...job.destinationConfig,
        headerValueEnv: "LICENSE_BACKUP_CUSTOM_DATABASE",
      });
    }
    return this.destinations.driver(job.destination, job.destinationConfig);
  }
  async preflight(destination: string) {
    if (!this.vault.ring)
      throw new DomainError(
        "backup_encryption_unconfigured",
        "Configure LICENSE_BACKUP_KEYRING before running archive jobs.",
        503,
      );
    const status = (await this.statuses()).find((d) => d.id === destination);
    if (!status)
      throw new DomainError("unknown_backup_destination", "No such backup destination.", 404);
    if (!status.configured)
      throw new DomainError(
        "backup_destination_unconfigured",
        status.reason ?? "This destination is archived or unconfigured.",
        503,
      );
    if (this.platform.options.database.engine === "postgres") {
      if (!this.options.databaseUrl)
        throw new DomainError(
          "backup_database_unconfigured",
          "Postgres connection is unavailable.",
          503,
        );
      if (!this.options.portablePostgres)
        try {
          await execute("pg_dump", ["--version"], { windowsHide: true, timeout: 15000 });
        } catch {
          throw new DomainError(
            "backup_tool_unavailable",
            "Install pg_dump on the server to create Postgres backups.",
            503,
          );
        }
    }
    if (!this.options.remoteOnly) await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  async migrateSchedules() {
    await atomic(this.platform.options.database, async (r) => {
      const legacy = await r.get<Schedule>(WORKSPACE, "backup-schedule", "default");
      if (!legacy || legacy.migratedTo) return;
      if (!(await r.get(WORKSPACE, "backup-schedule", legacy.destination)))
        await r.put(WORKSPACE, "backup-schedule", {
          ...legacy,
          id: legacy.destination,
          minuteUTC: legacy.minuteUTC ?? 0,
        });
      await r.put(WORKSPACE, "backup-schedule", {
        ...legacy,
        enabled: false,
        migratedTo: legacy.destination,
      });
    });
  }
  async saveSchedule(destination: string, input: z.infer<typeof backupScheduleSchema>) {
    const status = (await this.statuses()).find((d) => d.id === destination);
    if (!status || status.archived)
      throw new DomainError(
        "unknown_backup_destination",
        "No such active backup destination.",
        404,
      );
    if (input.enabled) await this.preflight(destination);
    await atomic(this.platform.options.database, async (r) => {
      const prior = await r.get<Schedule>(WORKSPACE, "backup-schedule", destination);
      if (prior && input.revision === undefined)
        throw new DomainError("revision_required", "Reload the schedule before saving.", 409);
      await r.put(
        WORKSPACE,
        "backup-schedule",
        {
          ...input,
          id: destination,
          destination,
          nextAt: nextBackupTime(this.platform.options.now(), input.hourUTC, input.minuteUTC),
        },
        input.revision,
      );
    });
  }
  async enqueue(destination: string) {
    await this.preflight(destination);
    const status = (await this.statuses()).find((d) => d.id === destination)!;
    const job: BackupJob = {
      id: randomUUID(),
      status: "queued",
      phase: "snapshot",
      engine: this.platform.options.database.engine,
      destination,
      destinationName: status.name,
      storageVersion: await this.storage.version(destination),
      createdAt: this.platform.time(),
      ...(status.config ? { destinationConfig: status.config } : {}),
    };
    await atomic(this.platform.options.database, (r) => r.put(WORKSPACE, "backup", job));
    return job;
  }
  path(id: string) {
    if (!z.string().uuid().safeParse(id).success)
      throw new DomainError("unknown_backup", "No such backup.", 404);
    return join(this.directory, id + ".kfbackup");
  }
  async bytes(job: BackupJob, records?: Records) {
    if (job.pruned || (!job.checksum && job.status !== "completed"))
      throw new DomainError("backup_unavailable", "This backup is not available.", 409);
    let bytes: Buffer | undefined;
    try {
      bytes = await readFile(this.path(job.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!bytes) {
      if (job.destination === "local" || job.destination.startsWith("custom-"))
        throw new DomainError(
          "backup_cache_missing",
          "The local archive is missing. Custom upload-only endpoints require the retained local copy for downloads.",
          404,
        );
      const driver = await this.driver(job, records);
      let file = job.remoteFile;
      if (!file && job.destination === "s3" && this.options.s3?.bucket)
        file = {
          type: "object",
          bucket: this.options.s3.bucket,
          key: "keyforge/" + job.id + ".kfbackup",
          region: this.options.s3.region ?? "us-east-1",
          endpoint: this.options.s3.endpoint,
        };
      if (!file || !driver.download)
        throw new DomainError(
          "backup_unavailable",
          "No remote archive reference is available.",
          404,
        );
      bytes = await driver.download(file);
    }
    if (job.checksum && digest(bytes) !== job.checksum)
      throw new DomainError("backup_corrupt", "Archive checksum mismatch.");
    return bytes;
  }
  async capture(isolatedSqlite = false): Promise<Archive> {
    if (this.options.portablePostgres && this.platform.options.database.engine === "postgres") {
      const bytes = await capturePostgresSnapshot(this.options.databaseUrl!);
      return {
        version: 2,
        engine: "postgres",
        capturedAt: this.platform.time(),
        files: [
          {
            name: "database.json",
            checksum: digest(bytes),
            capturedAt: this.platform.time(),
            data: bytes.toString("base64"),
          },
        ],
      };
    }
    const temp = await mkdtemp(join(tmpdir(), "keyforge-backup-"));
    try {
      const files: Archive["files"] = [];
      if (this.platform.options.database.engine === "sqlite") {
        const filename = "database.sqlite";
        const path = this.platform.options.database.sqlitePath;
        if (isolatedSqlite) {
          if (!path || path === ":memory:")
            throw new DomainError(
              "backup_unavailable",
              "A file-backed database is required for a reset backup.",
              503,
            );
          // The reset transaction holds the writer lock. A separate WAL reader
          // captures committed data without using the connection holding it.
          const reader = new SQLite(path, { readonly: true, fileMustExist: true });
          try {
            await reader.backup(join(temp, filename));
          } finally {
            reader.close();
          }
        } else await this.platform.options.database.backupTo(join(temp, filename));
        const bytes = await readFile(join(temp, filename));
        files.push({
          name: filename,
          capturedAt: this.platform.time(),
          checksum: digest(bytes),
          data: bytes.toString("base64"),
        });
      } else {
        const connection = postgresCliConnection(this.options.databaseUrl!);
        await execute(
          "pg_dump",
          [
            "--no-password",
            "--dbname",
            connection.database,
            "--format=custom",
            "--file",
            join(temp, "database.dump"),
          ],
          {
            windowsHide: true,
            timeout: 300000,
            maxBuffer: 1024 * 1024,
            env: connection.env,
          },
        );
        const size = (await stat(join(temp, "database.dump"))).size;
        if (size > 128 * 1024 * 1024)
          throw new Error("Use external streaming backups for databases larger than 128 MiB.");
        const bytes = await readFile(join(temp, "database.dump"));
        files.push({
          name: "database.dump",
          capturedAt: this.platform.time(),
          checksum: digest(bytes),
          data: bytes.toString("base64"),
        });
      }
      return {
        version: 1,
        engine: this.platform.options.database.engine,
        capturedAt: this.platform.time(),
        files,
      };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async tick() {
    await this.migrateSchedules();
    const now = this.platform.time();
    let claim: BackupJob | null = null;
    const statuses = await this.statuses();
    await atomic(this.platform.options.database, async (r) => {
      for (const schedule of await r.list<Schedule>(WORKSPACE, "backup-schedule")) {
        if (schedule.id === "default" || !schedule.enabled || schedule.nextAt > now) continue;
        const destination = statuses.find((d) => d.id === schedule.destination);
        const available = destination?.configured;
        await r.put(WORKSPACE, "backup", {
          id: randomUUID(),
          status: available ? "queued" : "failed",
          phase: "snapshot",
          destination: schedule.destination,
          destinationName: destination?.name ?? schedule.destination,
          storageVersion: (
            await r.get<{ id: string; version: string }>(
              WORKSPACE,
              "backup-storage-current",
              schedule.destination,
            )
          )?.version,
          engine: this.platform.options.database.engine,
          createdAt: now,
          ...(destination?.config ? { destinationConfig: destination.config } : {}),
          ...(!available
            ? {
                completedAt: now,
                errorCode: "backup_destination_unconfigured",
                error: destination?.reason ?? "The scheduled destination is no longer available.",
              }
            : {}),
        } as BackupJob);
        await r.put(WORKSPACE, "backup-schedule", {
          ...schedule,
          nextAt: nextBackupTime(
            this.platform.options.now(),
            schedule.hourUTC,
            schedule.minuteUTC ?? 0,
          ),
        });
      }
      const jobs = await r.list<BackupJob>(WORKSPACE, "backup");
      for (const job of jobs)
        if (job.status === "running" && job.leaseUntil! <= now)
          await r.put(WORKSPACE, "backup", {
            ...job,
            status: "failed",
            errorCode: "backup_lease_expired",
            error: "Worker lease expired; run a new backup.",
          });
      const job = jobs
        .filter((j) => j.status === "queued")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (job) {
        claim = {
          ...job,
          status: "running",
          leaseUntil: new Date(this.platform.options.now().getTime() + 600000).toISOString(),
        };
        await r.put(WORKSPACE, "backup", claim);
      }
    });
    if (claim) await this.run(claim);
    await this.prune();
    return Boolean(claim);
  }
  async run(job: BackupJob) {
    let updated = { ...job };
    try {
      await this.preflight(job.destination);
      const archive = await this.capture();
      const bytes = Buffer.from(this.vault.encrypt(JSON.stringify(archive), "backup:" + job.id));
      if (!this.options.remoteOnly) await writeFile(this.path(job.id), bytes, { mode: 0o600 });
      updated = {
        ...updated,
        size: bytes.length,
        checksum: digest(bytes),
        cacheAvailable: !this.options.remoteOnly,
        phase: "upload",
      };
      // Preserve a downloadable archive and progress even if the remote upload fails.
      await atomic(this.platform.options.database, async (r) => {
        const current = await r.get<BackupJob>(WORKSPACE, "backup", job.id);
        if (current?.status === "running" && current.leaseUntil === job.leaseUntil)
          await r.put(WORKSPACE, "backup", updated);
      });
      if (job.destination !== "local") {
        const driver = await this.driver(job);
        updated.remoteFile = await driver.upload(job.id, bytes);
      }
      updated = {
        ...updated,
        status: "completed",
        phase: "complete",
        completedAt: this.platform.time(),
      };
    } catch (error) {
      updated = {
        ...updated,
        status: "failed",
        completedAt: this.platform.time(),
        errorCode: error instanceof DomainError ? error.code : "backup_failed",
        error:
          error instanceof DomainError
            ? error.message
            : "Backup snapshot failed. Check database tools, destination access and available disk space.",
      };
    }
    await atomic(this.platform.options.database, async (r) => {
      const current = await r.get<BackupJob>(WORKSPACE, "backup", job.id);
      if (current?.status === "running" && current.leaseUntil === job.leaseUntil)
        await r.put(WORKSPACE, "backup", updated);
    });
  }
  async prune() {
    const schedules = await this.platform.records.list<Schedule>(WORKSPACE, "backup-schedule");
    for (const job of await this.platform.records.list<BackupJob>(WORKSPACE, "backup")) {
      const schedule = schedules.find((s) => s.id === job.destination);
      const cutoff = new Date(
        this.platform.options.now().getTime() - (schedule?.retentionDays ?? 30) * 86400000,
      ).toISOString();
      if (
        job.pruned ||
        !job.checksum ||
        job.createdAt > cutoff ||
        ["queued", "running"].includes(job.status)
      )
        continue;
      try {
        let remoteRetained = false;
        if (job.destination !== "local" && !job.destination.startsWith("custom-")) {
          const driver = await this.driver(job);
          let file = job.remoteFile;
          if (!file && job.destination === "s3" && this.options.s3?.bucket)
            file = {
              type: "object",
              bucket: this.options.s3.bucket,
              key: "keyforge/" + job.id + ".kfbackup",
              region: this.options.s3.region ?? "us-east-1",
              endpoint: this.options.s3.endpoint,
            };
          if (file) {
            if (!driver.remove)
              throw new DomainError(
                "backup_retention_failed",
                "This destination does not support remote deletion.",
              );
            await driver.remove(file);
          }
        } else if (job.destination.startsWith("custom-") && job.status === "completed")
          remoteRetained = true;
        await rm(this.path(job.id), { force: true });
        await atomic(this.platform.options.database, async (r) => {
          const current = await r.get<BackupJob>(WORKSPACE, "backup", job.id);
          if (current)
            await r.put(WORKSPACE, "backup", {
              ...current,
              pruned: true,
              cacheAvailable: false,
              remoteRetained,
              retentionError: undefined,
            });
        });
      } catch (error) {
        await atomic(this.platform.options.database, async (r) => {
          const current = await r.get<BackupJob>(WORKSPACE, "backup", job.id);
          if (current)
            await r.put(WORKSPACE, "backup", {
              ...current,
              retentionError:
                error instanceof DomainError
                  ? error.message
                  : "Retention cleanup failed. Check storage delete permissions.",
            });
        });
      }
    }
  }
  async verify(job: BackupJob, persist = true, records?: Records) {
    const bytes = await this.bytes(job, records);
    if (digest(bytes) !== job.checksum)
      throw new DomainError("backup_corrupt", "Archive checksum mismatch.");
    const archive = JSON.parse(this.vault.decrypt(bytes.toString(), "backup:" + job.id)) as Archive;
    const temp = await mkdtemp(join(tmpdir(), "keyforge-verify-"));
    try {
      if (
        ![1, 2].includes(archive.version) ||
        archive.engine !== job.engine ||
        (archive.version === 2 && archive.engine !== "postgres")
      )
        throw new DomainError("backup_corrupt", "Unsupported archive manifest.");
      if (!Array.isArray(archive.files) || archive.files.length !== 1)
        throw new DomainError("backup_corrupt", "Archive must contain one database.");
      for (const file of archive.files) {
        if (
          file.name !==
          (archive.engine === "sqlite"
            ? "database.sqlite"
            : archive.version === 2
              ? "database.json"
              : "database.dump")
        )
          throw new DomainError("backup_corrupt", "Invalid archive filename.");
        const data = Buffer.from(file.data, "base64");
        if (digest(data) !== file.checksum)
          throw new DomainError("backup_corrupt", "Snapshot checksum mismatch.");
        await writeFile(join(temp, file.name), data, { mode: 0o600 });
        if (archive.engine === "sqlite") {
          const db = new SQLite(join(temp, file.name), { readonly: true });
          try {
            if (
              db.pragma("integrity_check", { simple: true }) !== "ok" ||
              (db.pragma("foreign_key_check") as unknown[]).length
            )
              throw new DomainError("backup_corrupt", "SQLite integrity check failed.");
          } finally {
            db.close();
          }
        } else if (archive.version === 2) {
          parsePostgresSnapshot(data);
          if (
            !this.options.verificationUrl ||
            samePostgresDatabase(this.options.verificationUrl, this.options.databaseUrl!)
          )
            throw new DomainError(
              "verification_unconfigured",
              "Configure an independent verification database initialized with this KeyForge release.",
              503,
            );
          await restorePostgresSnapshot(this.options.verificationUrl, data);
        } else await this.verifyPostgres(join(temp, file.name));
      }
      const verified = { ...job, verifiedAt: this.platform.time() };
      if (persist)
        await atomic(this.platform.options.database, (r) => r.put(WORKSPACE, "backup", verified));
      return verified;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async verifiedResetBackup(preflight = true, records?: Records): Promise<BackupJob> {
    const destination = await this.defaultDestination(records);
    if (preflight) await this.preflight(destination);
    const job: BackupJob = {
      id: randomUUID(),
      status: "completed",
      phase: "complete",
      createdAt: this.platform.time(),
      completedAt: this.platform.time(),
      engine: this.platform.options.database.engine,
      destination,
      destinationName: "Before application reset",
      storageVersion: await this.storage.version(destination, records),
      cacheAvailable: !this.options.remoteOnly,
    };
    try {
      const archive = await this.capture(true);
      const bytes = Buffer.from(this.vault.encrypt(JSON.stringify(archive), "backup:" + job.id));
      if (!this.options.remoteOnly) await writeFile(this.path(job.id), bytes, { mode: 0o600 });
      if (destination !== "local") {
        job.remoteFile = await (await this.driver(job, records)).upload(job.id, bytes);
        if (!job.remoteFile)
          throw new Error("Reset backup requires a downloadable remote archive.");
      }
      job.size = bytes.length;
      job.checksum = digest(bytes);
      return await this.verify(job, false, records);
    } catch (error) {
      await rm(this.path(job.id), { force: true });
      throw error;
    }
  }
  async verifyPostgres(file: string) {
    if (!this.options.verificationUrl || this.options.verificationUrl === this.options.databaseUrl)
      throw new DomainError(
        "verification_unconfigured",
        "Configure a separate LICENSE_BACKUP_VERIFY_DATABASE_URL with temporary-database creation permission.",
        503,
      );
    const name = "kf_verify_" + randomUUID().replaceAll("-", "");
    const pool = createPostgresPool(this.options.verificationUrl);
    let created = false;
    try {
      await pool.query('CREATE DATABASE "' + name + '"');
      created = true;
      await execute(
        "pg_restore",
        ["--no-password", "--exit-on-error", "--no-owner", "--no-acl", "--dbname", name, file],
        {
          windowsHide: true,
          timeout: 300000,
          maxBuffer: 1024 * 1024,
          env: postgresCliConnection(this.options.verificationUrl, name).env,
        },
      );
    } finally {
      if (created) await pool.query('DROP DATABASE "' + name + '" WITH (FORCE)');
      await pool.end();
    }
  }
}
export async function registerBackups(
  app: FastifyInstance,
  platform: Platform,
  options: BackupOptions,
  gate: (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<{ actor: string; role: string } | null>,
) {
  const service = new BackupService(platform, options);
  const handler =
    (fn: (req: any, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const actor = await gate(req, reply);
      if (!actor) return;
      if (actor.role !== "admin")
        return reply
          .code(403)
          .send({ error: "insufficient_role", message: "Admin access required." });
      if (!options.enabled)
        return reply
          .code(404)
          .send({ error: "backups_disabled", message: "Backups are disabled." });
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
        (req as any).actor = actor.actor;
        return await fn(req, reply);
      } catch (error) {
        return reply.code(error instanceof DomainError ? error.status : 400).send({
          error:
            error instanceof DomainError
              ? error.code
              : error instanceof z.ZodError
                ? "bad_request"
                : "backup_failed",
          message:
            error instanceof DomainError
              ? error.message
              : error instanceof z.ZodError
                ? "Invalid backup settings: " +
                  error.issues
                    .map((issue) => (issue.path.join(".") || "settings") + ": " + issue.message)
                    .join("; ")
                : "Backup operation failed. Check configuration and destination access.",
          retryable: false,
          serverTime: platform.time(),
        });
      }
    };
  await service.migrateSchedules();
  await service.storage.migrate();
  const publicDestination = (value: CustomDestination) => {
    const { encryptedHeaderValue: _secret, ...safe } = value;
    return { ...safe, hasAuthorization: Boolean(_secret || value.headerValueEnv) };
  };
  const destinationInput = (
    body: unknown,
    id: string,
    prior?: CustomDestination,
  ): CustomDestination => {
    const { headerValue, keepAuthorization, ...fields } = z
      .object({
        headerValue: z.string().max(8192).optional(),
        keepAuthorization: z.boolean().optional(),
      })
      .passthrough()
      .parse(body);
    if (keepAuthorization && !headerValue && !prior?.encryptedHeaderValue)
      throw new DomainError(
        "storage_credentials_required",
        "Enter the complete authorization header value.",
      );
    const input = customDestinationSchema.parse({
      ...fields,
      ...(headerValue || keepAuthorization
        ? { headerValueEnv: "LICENSE_BACKUP_CUSTOM_DATABASE" }
        : {}),
    });
    if (!headerValue && !keepAuthorization) return { ...input, id };
    const { headerValueEnv: _env, ...config } = input;
    return {
      ...config,
      id,
      encryptedHeaderValue: headerValue
        ? platform.vault.encrypt(headerValue, "backup-custom:" + id)
        : prior!.encryptedHeaderValue,
    };
  };
  const publicJob = ({
    destinationConfig: _config,
    storageVersion: _storage,
    remoteFile: _remote,
    ...job
  }: BackupJob) => ({
    ...job,
    canDownload:
      !job.pruned &&
      Boolean(job.checksum || job.status === "completed") &&
      (!options.remoteOnly || Boolean(_remote)),
  });
  app.get(
    "/admin/backups",
    handler(async () => {
      const destinations = await service.statuses();
      const schedules = await platform.records.list<Schedule>(WORKSPACE, "backup-schedule");
      const legacy = await platform.records.get<Schedule>(WORKSPACE, "backup-schedule", "default");
      return {
        jobs: (await platform.records.list<BackupJob>(WORKSPACE, "backup"))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(publicJob),
        destinations: destinations
          .filter((d) => !d.archived)
          .map((d) => ({
            ...d,
            ...(d.config ? { config: publicDestination(d.config) } : {}),
            schedule: schedules.find((s) => s.id === d.id) ?? null,
          })),
        storage: Object.fromEntries(
          await Promise.all(
            storageProvider.options.map(async (id) => [id, await service.storage.metadata(id)]),
          ),
        ),
        schedule: legacy?.migratedTo
          ? (schedules.find((s) => s.id === legacy.migratedTo) ?? null)
          : (schedules.find((s) => s.id === "local") ?? null),
        archiveEncryption: Boolean(options.keyring),
        s3Configured: destinations.find((d) => d.id === "s3")?.configured ?? false,
        engine: platform.options.database.engine,
        authSnapshotAvailable: Boolean(options.authDbPath),
        workerError: service.workerError,
        remoteOnly: Boolean(options.remoteOnly),
        defaultDestination: await service.defaultDestination(),
        scheduleNotice: options.background
          ? "Automatic backups are checked daily around 05:00 UTC. A saved time is the earliest a backup can run. Manual backups start immediately."
          : null,
      };
    }),
  );
  app.post(
    "/admin/backups",
    handler(async (req, reply) => {
      const input = z
        .object({
          destination: z.string().min(1).max(100).optional(),
        })
        .strict()
        .parse(req.body);
      const job = await service.enqueue(input.destination ?? (await service.defaultDestination()));
      await platform.audit(req.actor, "backup.create", "default", {
        jobId: job.id,
        destination: job.destination,
      });
      startTick();
      return reply.code(202).send({ job: publicJob(job) });
    }),
  );
  app.put(
    "/admin/backups/storage-default",
    handler(async (req) => {
      const { destination } = z
        .object({ destination: z.enum(["local", ...storageProvider.options]) })
        .strict()
        .parse(req.body);
      await service.preflight(destination);
      await atomic(platform.options.database, (r) =>
        r.put(WORKSPACE, "backup-settings", { id: "default", destination }),
      );
      await platform.audit(req.actor, "backup.storage.default", "default", { destination });
      return { destination };
    }),
  );
  app.put(
    "/admin/backups/providers/:id",
    handler(async (req) => {
      const provider = storageProvider.parse(req.params.id);
      await service.storage.save(provider, storageSettingsSchema.parse(req.body));
      await platform.audit(req.actor, "backup.storage.update", "default", { provider });
      return { settings: await service.storage.metadata(provider) };
    }),
  );
  app.post(
    "/admin/backups/providers/:id/verify",
    handler(async (req) => {
      const provider = storageProvider.parse(req.params.id);
      await service.storage.verify(provider);
      await platform.audit(req.actor, "backup.storage.verify", "default", { provider });
      return { settings: await service.storage.metadata(provider) };
    }),
  );
  app.post(
    "/admin/backups/destinations",
    handler(async (req, reply) => {
      const input = destinationInput(req.body, "custom-" + randomUUID());
      if (input.revision !== undefined || input.archived)
        throw new DomainError(
          "bad_request",
          "New upload endpoints must be active and cannot carry a revision.",
        );
      const destination: CustomDestination = input;
      await atomic(platform.options.database, (r) =>
        r.put(WORKSPACE, "backup-destination", destination),
      );
      await platform.audit(req.actor, "backup.destination.create", "default", {
        destinationId: destination.id,
      });
      return reply.code(201).send({
        destination: publicDestination(
          (await platform.records.get<CustomDestination>(
            WORKSPACE,
            "backup-destination",
            destination.id,
          ))!,
        ),
      });
    }),
  );
  app.put(
    "/admin/backups/destinations/:id",
    handler(async (req) => {
      if ((req.body as { revision?: number })?.revision === undefined)
        throw new DomainError("revision_required", "Reload the endpoint before saving.", 409);
      await atomic(platform.options.database, async (r) => {
        const prior = await r.get<CustomDestination>(
          WORKSPACE,
          "backup-destination",
          req.params.id,
        );
        if (!prior)
          throw new DomainError(
            "unknown_backup_destination",
            "No such custom upload endpoint.",
            404,
          );
        const input = destinationInput(req.body, prior.id, prior);
        await r.put(WORKSPACE, "backup-destination", { ...input, id: prior.id }, input.revision);
        if (input.archived) {
          const schedule = await r.get<Schedule>(WORKSPACE, "backup-schedule", prior.id);
          if (schedule) await r.put(WORKSPACE, "backup-schedule", { ...schedule, enabled: false });
        }
      });
      await platform.audit(req.actor, "backup.destination.update", "default", {
        destinationId: req.params.id,
        archived: (req.body as { archived?: boolean }).archived,
      });
      return { ok: true };
    }),
  );
  app.put(
    "/admin/backups/destinations/:id/schedule",
    handler(async (req) => {
      const input = backupScheduleSchema.parse(req.body);
      await service.saveSchedule(req.params.id, input);
      await platform.audit(req.actor, "backup.schedule", "default", {
        destination: req.params.id,
        enabled: input.enabled,
      });
      return { ok: true };
    }),
  );
  // Preserve existing callers while every destination now owns its schedule.
  app.put(
    "/admin/backups/schedule",
    handler(async (req) => {
      const { destination, ...input } = z
        .object({ destination: z.string().min(1).max(100), ...backupScheduleSchema.shape })
        .strict()
        .parse(req.body);
      await service.saveSchedule(destination, input);
      await platform.audit(req.actor, "backup.schedule", "default", {
        destination,
        enabled: input.enabled,
      });
      return { ok: true };
    }),
  );
  app.get(
    "/admin/backups/:id/download",
    handler(async (req, reply) => {
      const job = await platform.records.get<BackupJob>(WORKSPACE, "backup", req.params.id);
      if (!job) throw new DomainError("unknown_backup", "No such backup.", 404);
      const bytes = await service.bytes(job);
      await platform.audit(req.actor, "backup.download", "default", { jobId: job.id });
      return (
        reply
          .type("application/octet-stream")
          .header("Content-Disposition", 'attachment; filename="' + job.id + '.kfbackup"')
          // Streaming avoids Vercel's buffered response size limit while the
          // archive itself remains checksum-checked and bounded in memory.
          .send(
            options.remoteOnly
              ? Readable.from(
                  (function* () {
                    for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
                      yield bytes.subarray(offset, offset + 64 * 1024);
                  })(),
                )
              : bytes,
          )
      );
    }),
  );
  app.post(
    "/admin/backups/:id/verify",
    handler(async (req) => {
      const job = await platform.records.get<BackupJob>(WORKSPACE, "backup", req.params.id);
      if (!job) throw new DomainError("unknown_backup", "No such backup.", 404);
      await service.verify(job);
      await platform.audit(req.actor, "backup.verify", "default", { jobId: job.id });
      return { ok: true };
    }),
  );
  app.get(
    "/admin/backup/:database",
    handler(async (req, reply) => {
      if (platform.options.database.engine !== "sqlite")
        throw new DomainError(
          "backup_unsupported",
          "Use Download backup now to create a Postgres archive.",
          501,
        );
      const which = z.enum(["database", "licenses", "auth"]).parse(req.params.database);
      const temp = await mkdtemp(join(tmpdir(), "keyforge-download-"));
      try {
        const path = join(temp, "snapshot.sqlite");
        if (which === "auth" && !options.authDbPath)
          throw new DomainError("auth_disabled", "No SQLite auth database is configured.", 503);
        await platform.options.database.backupTo(path);
        const bytes = await readFile(path);
        await platform.audit(req.actor, "backup.download", "default", { database: which });
        return reply
          .type("application/octet-stream")
          .header("Content-Disposition", 'attachment; filename="' + which + '-backup.sqlite"')
          .send(bytes);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }),
  );
  let running: Promise<void> | null = null;
  let stopping = false;
  const tick = () =>
    stopping || service.paused
      ? Promise.resolve()
      : (running ??= (async () => {
          service.workerError = undefined;
          while (!stopping && (await service.tick())) {
            /* Drain queued providers sequentially to bound snapshot memory. */
          }
        })()
          .catch(() => {
            service.workerError =
              "The backup worker failed. Check database connectivity and storage access.";
          })
          .finally(() => {
            running = null;
          }));
  function startTick() {
    const work = tick();
    if (options.background) options.background(work);
    else void work;
  }
  if (options.background)
    app.get("/api/internal/backups/tick", async (req, reply) => {
      if (!options.cronSecret || !constantTimeBearer(req.headers.authorization, options.cronSecret))
        return reply.code(401).send({ error: "unauthorized" });
      if (!options.enabled) return reply.code(404).send({ error: "backups_disabled" });
      await tick();
      if (service.workerError) return reply.code(503).send({ error: "backup_worker_failed" });
      return { ok: true };
    });
  const timer = options.background
    ? undefined
    : setInterval(() => {
        if (options.enabled) void tick();
      }, 30000);
  timer?.unref();
  app.addHook("preClose", async () => {
    stopping = true;
    if (timer) clearInterval(timer);
    await running;
  });
  app.addHook("onClose", async () => {
    service.destinations.close();
  });
  return service;
}

function samePostgresDatabase(left: string, right: string) {
  const a = new URL(left),
    b = new URL(right);
  return (
    // Verification is deliberately a differently named database, including
    // when pooled/direct URLs or DNS aliases point to the same cluster.
    decodeURIComponent(a.pathname) === decodeURIComponent(b.pathname)
  );
}
function constantTimeBearer(value: string | undefined, secret: string) {
  const hash = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(hash(value ?? ""), hash("Bearer " + secret));
}
