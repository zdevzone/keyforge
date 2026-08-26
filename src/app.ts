import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { fromNodeHeaders } from "better-auth/node";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import { type AuthInstance } from "./auth.js";
import { defaultConfig, entitlementsSchema, type AppConfig, type Entitlements } from "./config.js";
import { LicenseDatabase, type LicenseRow } from "./db.js";
import { describeSigningKey, type SigningKeyInfo } from "./keypair.js";
import { isAdminEndpointEnabled, resolveAdminFeatures, type OperatorRole } from "./permissions.js";
import { signLicenseToken, type LicenseTokenPayload } from "./sign.js";

/**
 * The vendor's licensing service. Small on purpose: three public verbs an
 * installation calls — activate, refresh, deactivate — and an admin surface the
 * vendor tool drives. It knows which keys exist and where they are activated;
 * it never learns how many photos anyone imported.
 */

export interface BuildLicenseAppOptions {
  /** An open ledger. Required — open one with `LicenseDatabase.open()`. */
  database: LicenseDatabase;
  /** Ed25519 private key, PKCS8 PEM. The only copy of it lives with this service. */
  privateKey: string;
  /**
   * The public half and its fingerprint, already validated at boot. Passed in
   * rather than derived here so the console reports exactly the key the entry
   * point checked. Omitted, it is derived from privateKey — tests build apps
   * directly, and a console that cannot name its key is the gap this closes.
   */
  signingKey?: SigningKeyInfo;
  /**
   * Bearer token for the admin routes. Absent means the admin surface answers
   * 503 rather than being open — misconfiguration should fail closed.
   */
  adminToken?: string;
  /** Deployment policy (key format, limits, presets, features). Defaults apply. */
  config?: AppConfig;
  /** Overrides config.tokens.offlineGraceDays when set (test convenience). */
  graceDays?: number;
  /** Injected by tests so both sides of the wire share one walkable clock. */
  now?: () => Date;
  /**
   * Better Auth instance for the admin console. Absent means no session login:
   * admin routes accept only the bearer token, and /api/auth answers 503.
   */
  auth?: AuthInstance;
  /** Path of the auth database, so /admin/backup/auth can snapshot it. */
  authDbPath?: string;
  /** Directory holding the built admin UI. Defaults to dist/public. */
  uiDir?: string;
}

function errorResponse(reply: FastifyReply, status: number, error: string, message: string) {
  return reply.code(status).send({ error, message });
}

/** Constant-time comparison, because the admin token is the whole admin gate. */
function tokenMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function licenseStatusNow(license: LicenseRow, now: Date): "active" | "revoked" | "expired" {
  if (license.status === "revoked") return "revoked";
  if (license.expiresAt && now > new Date(license.expiresAt)) return "expired";
  return "active";
}

export async function buildLicenseApp(options: BuildLicenseAppOptions): Promise<FastifyInstance> {
  const database = options.database;
  const config = options.config ?? defaultConfig();
  // Computed once: describeSigningKey does a sign/verify round trip, which is
  // not something to repeat per request. A caller that already validated the
  // key passes the result in rather than paying for it twice.
  const signingKey = options.signingKey ?? describeSigningKey(options.privateKey);
  const graceDays = options.graceDays ?? config.tokens.offlineGraceDays;
  const now = options.now ?? (() => new Date());
  const app = Fastify({ logger: false });

  /** Per-route rate-limit config, honoring the global limits.enabled switch. */
  const limited = (limit: { max: number; timeWindow: string }) =>
    config.limits.enabled ? { config: { rateLimit: limit } } : {};

  /**
   * Who is making this call, for the audit log only. Unlike requireAdmin this
   * never rejects: the auth plugin has already decided whether the request is
   * allowed by the time we record it.
   */
  async function requireActorForAudit(request: FastifyRequest): Promise<string> {
    if (!options.auth) return "unknown";
    const session = await options.auth.api
      .getSession({ headers: fromNodeHeaders(request.headers) })
      .catch(() => null);
    return session?.user.email || session?.user.id || "unknown";
  }

  // Lightweight liveness check for deployment health checks.
  app.get("/healthz", async () => ({ ok: true }));

  // Public, harmless deployment identity — the console's login page shows the
  // product name before anyone is signed in.
  app.get("/api/meta", async () => ({ name: config.branding.name }));

  // Tokens, license data and auth responses must never be cached; the UI's
  // hashed static assets are the one thing that should be.
  app.addHook("onSend", async (request, reply, payload) => {
    const url = request.raw.url ?? "";
    if (/^\/(v1|admin|api)\//.test(url)) reply.header("Cache-Control", "no-store");
    return payload;
  });

  // /v1/activate takes an unauthenticated product key: without a limit it is a
  // key-guessing oracle. Legitimate installations activate once, not often.
  await app.register(fastifyRateLimit, { global: false });

  // ------------------------------------------------------------------ auth --

  // Better Auth handles its own routing under /api/auth/* (sign-in, sign-out,
  // session). Without an instance the console fails closed, like admin routes
  // do without a token.
  const adminFeatures = resolveAdminFeatures(config.auth.admin);

  /** Operator-management calls worth a line in the audit log, by endpoint. */
  const AUDITED_ADMIN_ENDPOINTS: Record<string, string> = {
    "create-user": "operator.create",
    "update-user": "operator.update",
    "set-role": "operator.role",
    "set-user-password": "operator.password",
    "remove-user": "operator.remove",
    "ban-user": "operator.ban",
    "unban-user": "operator.unban",
    "revoke-user-session": "operator.session.revoke",
    "revoke-user-sessions": "operator.session.revoke_all",
    "impersonate-user": "operator.impersonate",
  };

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      if (!options.auth) {
        return errorResponse(
          reply,
          503,
          "auth_disabled",
          "No auth secret is configured on this service.",
        );
      }
      const rawUrl = request.raw.url ?? "";
      const adminEndpoint = /^\/api\/auth\/admin\/([^/?]+)/.exec(rawUrl)?.[1];
      // A feature the deployment switched off is refused before the plugin
      // sees it — turning impersonation off actually turns it off.
      if (adminEndpoint && !isAdminEndpointEnabled(adminEndpoint, adminFeatures)) {
        return errorResponse(
          reply,
          404,
          "admin_feature_disabled",
          `This deployment does not enable the admin feature behind /admin/${adminEndpoint}.`,
        );
      }
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      const webRequest = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await options.auth.handler(webRequest);
      // Operator management is an admin action like any other, so it belongs
      // in the same log as license changes. Only successes are recorded.
      const auditAction = adminEndpoint ? AUDITED_ADMIN_ENDPOINTS[adminEndpoint] : undefined;
      if (auditAction && response.status < 400) {
        const actor = await requireActorForAudit(request);
        const body = (request.body ?? {}) as Record<string, unknown>;
        await audit({
          actor,
          action: auditAction,
          detail: {
            ...(typeof body.email === "string" ? { email: body.email } : {}),
            ...(typeof body.userId === "string" ? { userId: body.userId } : {}),
            ...(body.role !== undefined ? { role: String(body.role) } : {}),
          },
        });
      }
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });

  function issueToken(license: LicenseRow, installationId: string): string {
    const issued = now();
    const legacyAllowance = Number(license.entitlements.allowance);
    const payload: LicenseTokenPayload = {
      v: 2,
      licenseId: license.id,
      plan: license.plan,
      entitlements: license.entitlements,
      ...(Number.isFinite(legacyAllowance) ? { allowance: legacyAllowance } : {}),
      issuedTo: license.issuedTo,
      installationId,
      issuedAt: issued.toISOString(),
      expiresAt: license.expiresAt,
      offlineGraceUntil: new Date(issued.getTime() + graceDays * 24 * 60 * 60 * 1000).toISOString(),
      status: licenseStatusNow(license, issued),
    };
    return signLicenseToken(payload, options.privateKey);
  }

  /**
   * Accepts entitlements as an object, with `allowance: <number>` kept working
   * as sugar for `entitlements.allowance` — the v1 API and CLI spoke allowance.
   */
  function parseEntitlementsInput(
    body: { entitlements?: unknown; allowance?: unknown },
    fallback: Entitlements | undefined,
  ): { entitlements: Entitlements } | { error: string } {
    let entitlements: Entitlements | undefined;
    if (body.entitlements !== undefined) {
      const parsed = entitlementsSchema.safeParse(body.entitlements);
      if (!parsed.success) {
        return { error: "entitlements must map names to numbers, strings or booleans." };
      }
      entitlements = parsed.data;
    }
    if (body.allowance !== undefined) {
      const allowance = Number(body.allowance);
      if (!Number.isInteger(allowance) || allowance <= 0) {
        return { error: "allowance must be a positive integer." };
      }
      entitlements = { ...(entitlements ?? fallback ?? {}), allowance };
    }
    return { entitlements: entitlements ?? fallback ?? {} };
  }

  // ---------------------------------------------------------------- public --

  /** Field caps for installer-supplied strings — census data, not essays. */
  const clip = (value: unknown, max = 200): string =>
    String(value ?? "")
      .trim()
      .slice(0, max);

  // The installer calls this on every install, licensed or not (internet is
  // mandatory during installation), so the vendor can compare installs against
  // licenses actually issued. Re-registration is a cheap upsert.
  app.post<{
    Body: {
      installationId?: string;
      appVersion?: string;
      platform?: string;
      userName?: string;
      userEmail?: string;
    };
  }>("/v1/register", limited(config.limits.register), async (request, reply) => {
    // A deployment that opted out of the census answers as if the route does
    // not exist, so old installers fail cleanly rather than half-working.
    if (!config.registry.enabled) {
      return errorResponse(
        reply,
        404,
        "registry_disabled",
        "This deployment does not register installations.",
      );
    }
    const installationId = clip(request.body?.installationId);
    if (!installationId) {
      return errorResponse(reply, 400, "bad_request", "installationId is required.");
    }
    const collect = config.registry.collectUserInfo;
    const installation = await database.registerInstallation({
      installationId,
      appVersion: clip(request.body?.appVersion, 50),
      platform: clip(request.body?.platform, 100),
      userName: collect ? clip(request.body?.userName) : "",
      userEmail: collect ? clip(request.body?.userEmail) : "",
    });
    return reply.send({ ok: true, licensed: installation.licenseId !== null });
  });

  // Instant feedback for the installer's optional key field: is this key any
  // good, and are seats left? Reads only — binding a seat stays activate's
  // job, so validating during install never consumes anything.
  app.post<{ Body: { key?: string } }>(
    "/v1/validate",
    limited(config.limits.validate),
    async (request, reply) => {
      const key = String(request.body?.key ?? "").trim();
      if (!key) {
        return errorResponse(reply, 400, "bad_request", "A product key is required.");
      }
      const license = await database.findByKey(key);
      if (!license) {
        return errorResponse(reply, 404, "unknown_key", "That product key was not recognised.");
      }
      if (license.status === "revoked") {
        return errorResponse(reply, 410, "license_revoked", "This license has been revoked.");
      }
      if (license.expiresAt && now() > new Date(license.expiresAt)) {
        return errorResponse(reply, 410, "license_expired", "This license has expired.");
      }
      const seatsInUse = await database.activeActivationCount(license.id);
      return reply.send({
        valid: true,
        plan: license.plan,
        entitlements: license.entitlements,
        issuedTo: license.issuedTo,
        expiresAt: license.expiresAt,
        activationLimit: license.activationLimit,
        seatsInUse,
        seatsAvailable: Math.max(0, license.activationLimit - seatsInUse),
      });
    },
  );

  app.post<{ Body: { key?: string; installationId?: string } }>(
    "/v1/activate",
    limited(config.limits.activate),
    async (request, reply) => {
      const key = String(request.body?.key ?? "").trim();
      const installationId = String(request.body?.installationId ?? "").trim();
      if (!key || !installationId) {
        return errorResponse(
          reply,
          400,
          "bad_request",
          "A product key and installation are required.",
        );
      }

      const license = await database.findByKey(key);
      // Unknown and revoked keys answer differently on purpose: a customer
      // typing their own key wrong needs to hear that, not a refund question.
      if (!license) {
        return errorResponse(reply, 404, "unknown_key", "That product key was not recognised.");
      }
      if (license.status === "revoked") {
        return errorResponse(reply, 410, "license_revoked", "This license has been revoked.");
      }
      if (license.expiresAt && now() > new Date(license.expiresAt)) {
        return errorResponse(reply, 410, "license_expired", "This license has expired.");
      }

      const existing = await database.getActivation(license.id, installationId);
      // Already activated here: answering with a fresh token makes activation
      // idempotent, which is what a reinstall on the same machine needs.
      if (!existing || existing.deactivatedAt) {
        if ((await database.activeActivationCount(license.id)) >= license.activationLimit) {
          return errorResponse(
            reply,
            409,
            "activation_limit_reached",
            "This key is already activated on another installation. Deactivate it there first, or contact the vendor to transfer it.",
          );
        }
      }
      await database.bindActivation(license.id, installationId);
      await database.linkInstallationToLicense(installationId, license.id);
      return reply.send({ token: issueToken(license, installationId) });
    },
  );

  app.post<{ Body: { licenseId?: string; installationId?: string } }>(
    "/v1/refresh",
    async (request, reply) => {
      const licenseId = String(request.body?.licenseId ?? "").trim();
      const installationId = String(request.body?.installationId ?? "").trim();
      const license = licenseId ? await database.getLicense(licenseId) : null;
      if (!license) {
        return errorResponse(reply, 404, "unknown_license", "This license was not recognised.");
      }
      const activation = await database.getActivation(license.id, installationId);
      if (!activation || activation.deactivatedAt) {
        return errorResponse(
          reply,
          403,
          "not_activated_here",
          "This license is not activated on this installation.",
        );
      }
      // The token carries the verdict — active, revoked or expired — signed, so
      // the installation persists an authenticated answer either way.
      await database.touchInstallation(installationId);
      return reply.send({ token: issueToken(license, installationId) });
    },
  );

  app.post<{ Body: { licenseId?: string; installationId?: string } }>(
    "/v1/deactivate",
    async (request, reply) => {
      const licenseId = String(request.body?.licenseId ?? "").trim();
      const installationId = String(request.body?.installationId ?? "").trim();
      const license = licenseId ? await database.getLicense(licenseId) : null;
      if (!license) {
        return errorResponse(reply, 404, "unknown_license", "This license was not recognised.");
      }
      await database.releaseActivation(license.id, installationId);
      return reply.send({ ok: true });
    },
  );

  // ----------------------------------------------------------------- admin --

  // Audit recording honors the feature switch in one place. Awaited at every
  // call site so an entry is durable before its response goes out, and so the
  // log's order matches the order actions actually happened.
  const audit: LicenseDatabase["appendAudit"] = async (entry) => {
    if (config.features.audit) await database.appendAudit(entry);
  };

  // Two ways in, one gate: the CLI presents the bearer token, the console
  // presents a Better Auth session cookie. Either alone is sufficient; with
  // neither surface configured the admin API answers 503, as before. The
  // returned actor feeds the audit log — an operator is their email, while the
  // shared bearer token can only ever say "cli".
  interface Operator {
    actor: string;
    role: OperatorRole;
  }

  const requireAdmin = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Operator | null> => {
    if (!options.adminToken && !options.auth) {
      errorResponse(reply, 503, "admin_disabled", "No admin token is configured on this service.");
      return null;
    }
    const header = String(request.headers.authorization ?? "");
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    // The CLI token predates roles and is the vendor's own key: it is admin.
    if (options.adminToken && candidate && tokenMatches(candidate, options.adminToken)) {
      return { actor: "cli", role: "admin" };
    }
    if (options.auth && !candidate) {
      const session = await options.auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      if (session) {
        const role = (session.user as { role?: string }).role;
        return {
          actor: session.user.email || session.user.id,
          // An operator with no role at all is treated as the lesser one:
          // unknown authority is never full authority.
          role: role === "admin" ? "admin" : "support",
        };
      }
    }
    errorResponse(reply, 401, "admin_unauthorized", "A valid admin token or session is required.");
    return null;
  };

  /**
   * Gate for actions only an admin may take — issuing, editing and revoking
   * licenses, and downloading the ledger. Enforced here rather than by hiding
   * buttons, so a support operator crafting the request by hand is refused too.
   */
  const requireAdminRole = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<Operator | null> => {
    const operator = await requireAdmin(request, reply);
    if (!operator) return null;
    if (operator.role !== "admin") {
      errorResponse(
        reply,
        403,
        "insufficient_role",
        "This action requires an admin operator; your role is support.",
      );
      return null;
    }
    return operator;
  };

  app.post<{
    Body: {
      plan?: string;
      entitlements?: unknown;
      allowance?: number;
      issuedTo?: string;
      activationLimit?: number;
      expiresAt?: string | null;
    };
  }>("/admin/licenses", async (request, reply) => {
    const admin = await requireAdminRole(request, reply);
    if (!admin) return;
    const plan = String(request.body?.plan ?? config.licenses.defaultPlan);
    // A named preset supplies starting entitlements, duration and seat count;
    // anything sent explicitly wins over the preset.
    const preset = config.licenses.planPresets[plan];
    const parsed = parseEntitlementsInput(request.body ?? {}, preset?.entitlements);
    if ("error" in parsed) {
      return errorResponse(reply, 400, "bad_entitlements", parsed.error);
    }
    let expiresAt = request.body?.expiresAt ?? null;
    if (expiresAt === null && request.body?.expiresAt === undefined && preset?.durationDays) {
      expiresAt = new Date(
        now().getTime() + preset.durationDays * 24 * 60 * 60 * 1000,
      ).toISOString();
    }
    const activationLimit =
      request.body?.activationLimit ??
      preset?.activationLimit ??
      config.licenses.defaultActivationLimit;
    if (!Number.isInteger(Number(activationLimit)) || Number(activationLimit) <= 0) {
      return errorResponse(
        reply,
        400,
        "bad_activation_limit",
        "activationLimit must be a positive integer.",
      );
    }
    const { license, key } = await database.createLicense({
      plan,
      entitlements: parsed.entitlements,
      issuedTo: request.body?.issuedTo,
      activationLimit: Number(activationLimit),
      expiresAt,
      keyFormat: config.key,
    });
    await audit({
      actor: admin.actor,
      action: "license.issue",
      licenseId: license.id,
      detail: {
        plan: license.plan,
        entitlements: license.entitlements,
        issuedTo: license.issuedTo,
        activationLimit: license.activationLimit,
        expiresAt: license.expiresAt,
      },
    });
    // The key appears in this response and nowhere else, ever — the ledger
    // stores only its hash.
    return reply.code(201).send({ license, key });
  });

  app.get<{
    Querystring: { q?: string; status?: string; limit?: string; offset?: string };
  }>("/admin/licenses", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { q, status, limit, offset } = request.query;
    if (status !== undefined && !["active", "expired", "revoked"].includes(status)) {
      return errorResponse(reply, 400, "bad_status", "status must be active, expired or revoked.");
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      return errorResponse(reply, 400, "bad_limit", "limit must be a positive integer.");
    }
    const parsedOffset = offset === undefined ? 0 : Number(offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      return errorResponse(reply, 400, "bad_offset", "offset must be a non-negative integer.");
    }
    // Without a limit the whole ledger comes back — the CLI's `list` relies on
    // that; the console always pages.
    const page = await database.listLicenses({
      q: q?.trim() || undefined,
      status: status as "active" | "expired" | "revoked" | undefined,
      limit: parsedLimit,
      offset: parsedOffset,
      now: now(),
    });
    return reply.send(page);
  });

  app.get<{ Params: { id: string } }>("/admin/licenses/:id", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const license = await database.getLicense(request.params.id);
    if (!license) return errorResponse(reply, 404, "unknown_license", "No such license.");
    return reply.send({ license });
  });

  app.patch<{
    Params: { id: string };
    Body: {
      issuedTo?: string;
      activationLimit?: number;
      expiresAt?: string | null;
      entitlements?: unknown;
      allowance?: number;
    };
  }>("/admin/licenses/:id", async (request, reply) => {
    const admin = await requireAdminRole(request, reply);
    if (!admin) return;
    const existing = await database.getLicense(request.params.id);
    if (!existing) {
      return errorResponse(reply, 404, "unknown_license", "No such license.");
    }
    const body = request.body ?? {};
    const update: {
      issuedTo?: string;
      activationLimit?: number;
      expiresAt?: string | null;
      entitlements?: Entitlements;
    } = {};
    if (body.entitlements !== undefined || body.allowance !== undefined) {
      const parsed = parseEntitlementsInput(body, existing.entitlements);
      if ("error" in parsed) {
        return errorResponse(reply, 400, "bad_entitlements", parsed.error);
      }
      update.entitlements = parsed.entitlements;
    }
    if (body.issuedTo !== undefined) update.issuedTo = String(body.issuedTo);
    if (body.activationLimit !== undefined) {
      const limit = Number(body.activationLimit);
      if (!Number.isInteger(limit) || limit <= 0) {
        return errorResponse(
          reply,
          400,
          "bad_activation_limit",
          "activationLimit must be a positive integer.",
        );
      }
      update.activationLimit = limit;
    }
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        update.expiresAt = null;
      } else {
        const expires = new Date(String(body.expiresAt));
        if (Number.isNaN(expires.getTime())) {
          return errorResponse(reply, 400, "bad_expiry", "expiresAt must be an ISO date or null.");
        }
        update.expiresAt = expires.toISOString();
      }
    }
    const license = await database.updateLicense(request.params.id, update);
    await audit({
      actor: admin.actor,
      action: "license.update",
      licenseId: request.params.id,
      detail: update,
    });
    return reply.send({ license });
  });

  app.post<{ Params: { id: string } }>("/admin/licenses/:id/revoke", async (request, reply) => {
    const admin = await requireAdminRole(request, reply);
    if (!admin) return;
    const license = await database.revokeLicense(request.params.id);
    if (!license) return errorResponse(reply, 404, "unknown_license", "No such license.");
    await audit({
      actor: admin.actor,
      action: "license.revoke",
      licenseId: license.id,
      detail: { issuedTo: license.issuedTo },
    });
    return reply.send({ license });
  });

  app.get<{ Params: { id: string } }>("/admin/licenses/:id/activations", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const license = await database.getLicense(request.params.id);
    if (!license) return errorResponse(reply, 404, "unknown_license", "No such license.");
    return reply.send({ activations: await database.listActivations(license.id) });
  });

  app.post<{ Params: { id: string }; Body: { installationId?: string } }>(
    "/admin/licenses/:id/deactivate",
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const license = await database.getLicense(request.params.id);
      if (!license) return errorResponse(reply, 404, "unknown_license", "No such license.");
      const installationId = String(request.body?.installationId ?? "").trim();
      if (!installationId) {
        return errorResponse(reply, 400, "bad_request", "installationId is required.");
      }
      await database.releaseActivation(license.id, installationId);
      await audit({
        actor: admin.actor,
        action: "activation.release",
        licenseId: license.id,
        detail: { installationId },
      });
      return reply.send({ ok: true });
    },
  );

  app.get<{
    Querystring: { q?: string; licensed?: string; limit?: string; offset?: string };
  }>("/admin/installations", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    if (!config.registry.enabled) {
      return errorResponse(
        reply,
        404,
        "registry_disabled",
        "This deployment does not register installations.",
      );
    }
    const { q, licensed, limit, offset } = request.query;
    if (licensed !== undefined && !["yes", "no"].includes(licensed)) {
      return errorResponse(reply, 400, "bad_licensed", "licensed must be yes or no.");
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit <= 0)) {
      return errorResponse(reply, 400, "bad_limit", "limit must be a positive integer.");
    }
    const parsedOffset = offset === undefined ? 0 : Number(offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      return errorResponse(reply, 400, "bad_offset", "offset must be a non-negative integer.");
    }
    const page = await database.listInstallations({
      q: q?.trim() || undefined,
      licensed: licensed === undefined ? undefined : licensed === "yes",
      limit: parsedLimit,
      offset: parsedOffset,
    });
    return reply.send(page);
  });

  /**
   * Every entitlement key the ledger actually contains.
   *
   * A read, behind the same gate as the other admin listings. It exists because
   * entitlements are free-form: the console can show what was *typed* into
   * licenses, which is the only way to notice that half of them say `seats` and
   * the rest say `seat`.
   */
  app.get("/admin/entitlements", async (request, reply) => {
    const operator = await requireAdmin(request, reply);
    if (!operator) return;
    const { catalog, licensesScanned } = await database.entitlementCatalog();
    return reply.send({ catalog, licensesScanned });
  });

  // What the console needs to render itself: branding, which pages exist,
  // and the issue form's presets. Policy only — never secrets.
  app.get("/admin/config", async (request, reply) => {
    const operator = await requireAdmin(request, reply);
    if (!operator) return;
    return reply.send({
      viewer: { actor: operator.actor, role: operator.role },
      adminScope: [...adminFeatures],
      branding: config.branding,
      features: {
        audit: config.features.audit,
        // The console only offers the ledger download where it can work.
        backups: config.features.backups,
        ledgerBackup: config.features.backups && database.supportsBackup,
        registry: config.registry.enabled,
      },
      engine: database.engine,
      licenses: {
        defaultPlan: config.licenses.defaultPlan,
        defaultActivationLimit: config.licenses.defaultActivationLimit,
        planPresets: config.licenses.planPresets,
      },
      // The PUBLIC half and its fingerprint — never the private key. This is
      // the value the vendor embeds in their app, and the console is the only
      // place it can be recovered once `keygen` has scrolled away. A mismatch
      // between this fingerprint and the app's is why tokens fail in the field
      // while the server reports success.
      signingKey: {
        keyType: signingKey.keyType,
        fingerprint: signingKey.fingerprint,
        publicKeyPem: signingKey.publicKeyPem,
      },
    });
  });

  // On-demand database backups: a consistent snapshot via SQLite's online
  // backup API (safe under WAL and live writes), handed over as a download.
  // The foundation for scheduled/off-site backups later.
  app.get<{ Params: { database: string } }>("/admin/backup/:database", async (request, reply) => {
    const admin = await requireAdminRole(request, reply);
    if (!admin) return;
    if (!config.features.backups) {
      return errorResponse(
        reply,
        404,
        "backups_disabled",
        "Backups are disabled on this deployment.",
      );
    }
    const which = request.params.database;
    if (which !== "licenses" && which !== "auth") {
      return errorResponse(reply, 404, "unknown_database", "Back up 'licenses' or 'auth'.");
    }
    // Postgres deployments back up with their own tooling; claiming to
    // snapshot one from here would be a lie that costs someone their data.
    if (which === "licenses" && !database.supportsBackup) {
      return errorResponse(
        reply,
        501,
        "backup_unsupported",
        "This ledger runs on Postgres — back it up with pg_dump (see docs/backups.md).",
      );
    }
    const snapshotPath = join(tmpdir(), `license-server-backup-${randomUUID()}.sqlite`);
    try {
      if (which === "licenses") {
        await database.backupTo(snapshotPath);
      } else {
        if (!options.authDbPath || !existsSync(options.authDbPath)) {
          return errorResponse(
            reply,
            503,
            "auth_disabled",
            "No auth database is configured on this service.",
          );
        }
        const source = new Database(options.authDbPath, { readonly: true, fileMustExist: true });
        try {
          await source.backup(snapshotPath);
        } finally {
          source.close();
        }
      }
      const snapshot = await readFile(snapshotPath);
      await audit({
        actor: admin.actor,
        action: "backup.download",
        detail: { database: which, bytes: snapshot.byteLength },
      });
      const stamp = now().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${which}-backup-${stamp}.sqlite"`)
        .send(snapshot);
    } finally {
      await rm(snapshotPath, { force: true });
    }
  });

  app.get<{
    Querystring: { limit?: string; before?: string; licenseId?: string };
  }>("/admin/audit", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    if (!config.features.audit) {
      return errorResponse(
        reply,
        404,
        "audit_disabled",
        "The audit log is disabled on this deployment.",
      );
    }
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
    const before = request.query.before === undefined ? undefined : Number(request.query.before);
    if (before !== undefined && (!Number.isInteger(before) || before <= 0)) {
      return errorResponse(reply, 400, "bad_cursor", "before must be a positive integer id.");
    }
    const entries = await database.listAudit({
      limit,
      before,
      licenseId: request.query.licenseId?.trim() || undefined,
    });
    // The cursor is the last id of a full page; a short page means the end.
    const nextBefore = entries.length === limit ? entries[entries.length - 1].id : null;
    return reply.send({ entries, nextBefore });
  });

  // -------------------------------------------------------------------- ui --

  // The admin console is a static SPA built into dist/public and served by
  // this same process — one deploy, one origin, no CORS. When no build exists
  // (tests, CLI-only deployments) the service runs exactly as before.
  const uiDir = options.uiDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  if (existsSync(join(uiDir, "index.html"))) {
    await app.register(fastifyStatic, { root: uiDir });
    app.setNotFoundHandler(async (request, reply) => {
      const url = request.raw.url ?? "";
      if (request.method === "GET" && !/^\/(v1|admin|api)\//.test(url)) {
        return reply.type("text/html").sendFile("index.html");
      }
      return errorResponse(reply, 404, "not_found", "No such route.");
    });
  }

  // The ledger is opened by the caller, so the caller closes it.

  return app;
}
