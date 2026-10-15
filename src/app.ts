import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import { type AuthInstance } from "./auth.js";
import { registerBackups, type BackupOptions } from "./backups.js";
import { defaultConfig, type AppConfig } from "./config.js";
import { LicenseDatabase } from "./db.js";
import {
  describeSigningKey,
  fingerprintPublicKey,
  resolveKid,
  type SigningKeyInfo,
} from "./keypair.js";
import { isAdminEndpointEnabled, resolveAdminFeatures } from "./permissions.js";
import type { KeyRing } from "./platform-store.js";
import { registerPlatform } from "./platform.js";
import { isProfileImage } from "./profile-image.js";
import { resolveRuntime } from "./runtime.js";
import { registerSystemReset, resetRequestBarrier } from "./system-reset.js";

export interface BuildLicenseAppOptions {
  database: LicenseDatabase;
  privateKey: string;
  signingKey?: SigningKeyInfo;
  adminToken?: string;
  config?: AppConfig;
  graceDays?: number;
  now?: () => Date;
  auth?: AuthInstance;
  authDbPath?: string;
  uiDir?: string;
  kid?: string;
  keyring?: KeyRing;
  backups?: BackupOptions;
  onRoute?: (method: string, url: string) => void;
}
export async function buildLicenseApp(options: BuildLicenseAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const resetBarrier = resetRequestBarrier(app);
  if (options.onRoute)
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method])
        if (method !== "HEAD") options.onRoute!(method, route.url);
    });
  const config = options.config ?? defaultConfig();
  const now = options.now ?? (() => new Date());
  const signingKey = options.signingKey ?? describeSigningKey(options.privateKey);
  const kid = options.kid ?? resolveKid(signingKey);
  const fail = (reply: any, status: number, code: string, message: string) =>
    reply.code(status).send({
      error: code,
      message,
      retryable: [429, 502, 503, 504].includes(status),
      serverTime: now().toISOString(),
    });
  const gate = async (req: any, reply: any) => {
    if (!options.adminToken && !options.auth) {
      fail(reply, 503, "admin_disabled", "Configure an operator session or admin token.");
      return null;
    }
    const header = String(req.headers.authorization ?? "");
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (options.adminToken && candidate) {
      const a = Buffer.from(candidate),
        b = Buffer.from(options.adminToken);
      if (a.length === b.length && timingSafeEqual(a, b))
        return { actor: "cli", role: "admin" as const };
    }
    if (!candidate && options.auth) {
      const session = await options.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (session)
        return {
          actor: session.user.email,
          role:
            (session.user as { role?: string }).role === "admin"
              ? ("admin" as const)
              : ("support" as const),
        };
    }
    fail(reply, 401, "admin_unauthorized", "A valid admin token or operator session is required.");
    return null;
  };
  app.addHook("onSend", async (req, reply, payload) => {
    if (/^\/(admin|v1|api)\//.test(req.url)) reply.header("Cache-Control", "no-store");
    return payload;
  });
  await app.register(rateLimit, {
    global: false,
    hook: "preHandler",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "rate_limited",
      message: "Too many requests.",
      retryable: true,
      retryAfter: Math.ceil(context.ttl / 1000),
      serverTime: now().toISOString(),
    }),
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error.statusCode === 429) {
      const seconds = error.retryAfter ?? 60;
      reply.header("Retry-After", String(seconds));
      return reply.code(429).send({
        error: "rate_limited",
        message: "Too many requests.",
        retryable: true,
        retryAfter: seconds,
        serverTime: now().toISOString(),
      });
    }
    return fail(
      reply,
      error.statusCode ?? 500,
      error.statusCode && error.statusCode < 500 ? "bad_request" : "internal_error",
      error.statusCode && error.statusCode < 500 ? error.message : "The service failed to answer.",
    );
  });
  app.get("/healthz", async () => ({
    ok: true,
    serverTime: now().toISOString(),
    tokenVersions: { min: 4, max: 4 },
    trialTokenVersions: { min: 2, max: 2 },
  }));
  const meta = async () => ({ name: config.branding.name, serverTime: now().toISOString() });
  app.get("/v1/meta", meta);
  app.get("/api/meta", meta);
  const features = resolveAdminFeatures(config.auth.admin);
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(req, reply) {
      if (!options.auth)
        return fail(reply, 503, "auth_disabled", "No operator authentication is configured.");
      const endpoint = /^\/api\/auth\/admin\/([^/?]+)/.exec(req.url)?.[1];
      if (endpoint && !isAdminEndpointEnabled(endpoint, features))
        return fail(
          reply,
          404,
          "admin_feature_disabled",
          "This operator-management feature is disabled.",
        );
      if (req.url.split("?")[0] === "/api/auth/update-user" && req.method === "POST") {
        const profile = z
          .object({
            name: z.string().trim().min(1).max(100).optional(),
            image: z.string().refine(isProfileImage).nullable().optional(),
            phone: z.string().max(50).optional(),
            jobTitle: z.string().max(100).optional(),
            timezone: z
              .string()
              .refine((v) => {
                try {
                  new Intl.DateTimeFormat("en", { timeZone: v });
                  return true;
                } catch {
                  return false;
                }
              })
              .optional(),
          })
          .strict()
          .safeParse(req.body);
        if (!profile.success)
          return fail(
            reply,
            400,
            "bad_profile",
            "Check name, profile image and timezone. Images must be HTTPS URLs or PNG, JPEG or WebP uploads up to 256 KiB. Email and role cannot be edited here.",
          );
      }
      const response = await options.auth.handler(
        new Request(new URL(req.url, "http://" + req.headers.host), {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          ...(req.body ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      if (endpoint && req.method === "POST" && response.ok && config.features.audit) {
        const session = await options.auth.api.getSession({
          headers: fromNodeHeaders(req.headers),
        });
        const body = req.body as Record<string, unknown>;
        await options.database.appendAudit({
          actor: session?.user.email ?? "operator",
          action: "operator." + endpoint,
          detail: {
            ...(body.userId ? { userId: String(body.userId) } : {}),
            ...(body.role ? { role: String(body.role) } : {}),
          },
        });
      }
      reply.status(response.status);
      const cookies = response.headers.getSetCookie();
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(await response.text());
    },
  });
  const platform = await registerPlatform(app, {
    database: options.database,
    config,
    privateKey: options.privateKey,
    kid,
    keyring: options.keyring,
    auth: options.auth,
    now,
    gate,
  });
  app.get("/admin/config", async (req, reply) => {
    const viewer = await gate(req, reply);
    if (!viewer) return;
    const catalog = await platform.records.list<any>("product:default", "plan");
    return {
      viewer,
      adminScope: [...features],
      branding: config.branding,
      engine: options.database.engine,
      features: {
        ...config.features,
        registry: config.registry.enabled,
        ledgerBackup: options.database.supportsBackup,
      },
      licenses: {
        defaultPlan: config.licenses.defaultPlan,
        defaultActivationLimit: config.licenses.defaultActivationLimit,
        planPresets: Object.fromEntries(
          catalog.map((p) => [
            p.id,
            {
              entitlements: p.entitlements,
              durationDays: p.durationDays ?? undefined,
              activationLimit: p.activationLimit,
            },
          ]),
        ),
      },
      signingKeys: (await platform.product("default")).keys.map((key) => ({
        kid: key.kid,
        publicKeyPem: key.publicKeyPem,
        keyType: "ed25519",
        fingerprint: fingerprintPublicKey(key.publicKeyPem),
        retiredAt: key.retiredAt,
        pending: key.pending,
      })),
      keyStorageEnabled: Boolean(options.keyring),
    };
  });
  app.get("/admin/system", async (req, reply) => {
    const operator = await gate(req, reply);
    if (!operator) return;
    if (operator.role !== "admin")
      return fail(reply, 403, "insufficient_role", "This page requires an admin.");
    const runtime = resolveRuntime();
    return {
      engine: options.database.engine,
      authEnabled: Boolean(options.auth),
      adminBearerEnabled: Boolean(options.adminToken),
      encryptionConfigured: Boolean(options.keyring),
      databaseSource:
        options.database.engine === "postgres" ? "DATABASE_URL" : "LICENSE_DB_PATH / default",
      authSource:
        options.database.engine === "postgres"
          ? "DATABASE_URL"
          : "LICENSE_DB_PATH / unified SQLite",
      ignoredSqlitePaths: options.database.engine === "postgres",
      publicOriginConfigured: Boolean(
        process.env.LICENSE_SERVER_URL || process.env.RENDER_EXTERNAL_URL,
      ),
      warnings: [
        ...(process.env.BETTER_AUTH_URL
          ? ["BETTER_AUTH_URL is not needed; use LICENSE_SERVER_URL."]
          : []),
        ...(!options.keyring
          ? ["Configure LICENSE_DATA_KEYRING to create products and retain product keys."]
          : []),
      ],
      sqlitePaths:
        options.database.engine === "sqlite"
          ? { ledger: runtime.sqlitePath, auth: runtime.authDbPath }
          : null,
    };
  });
  app.get("/admin/audit", async (req: any, reply) => {
    if (!(await gate(req, reply))) return;
    if (!config.features.audit) return fail(reply, 404, "audit_disabled", "Audit is disabled.");
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.coerce.number().int().positive().optional(),
        licenseId: z.string().optional(),
      })
      .parse(req.query);
    const rows = await options.database.listAudit({ ...query, limit: query.limit + 1 });
    const entries = rows.slice(0, query.limit);
    return { entries, nextBefore: rows.length > query.limit ? entries.at(-1)?.id : null };
  });
  const backups = await registerBackups(
    app,
    platform,
    { ...options.backups, authDbPath: options.authDbPath, enabled: config.features.backups },
    gate,
  );
  registerSystemReset(app, platform, backups, gate, resetBarrier);
  const uiDir = options.uiDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  if (existsSync(join(uiDir, "index.html"))) {
    await app.register(staticFiles, { root: uiDir });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === "GET" && !/^\/(v1|admin|api)\//.test(req.url))
        return reply.type("text/html").sendFile("index.html");
      return fail(reply, 404, "not_found", "No such route.");
    });
  } else app.setNotFoundHandler((_req, reply) => fail(reply, 404, "not_found", "No such route."));
  return app;
}
