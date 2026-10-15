import { existsSync, readFileSync } from "node:fs";

import { z } from "zod";

import { durationMs } from "./duration.js";

/**
 * Deployment configuration. Everything that used to be a hardcoded policy —
 * key format, grace windows, rate limits, plan presets, which features are
 * on — lives here, so a deployer customizes a JSON file instead of the code.
 *
 * Precedence: keyforge.config.json (path via LICENSE_CONFIG) over built-in
 * defaults. Secrets never live here — they stay in the environment
 * (LICENSE_SIGNING_KEY, LICENSE_ADMIN_TOKEN, LICENSE_AUTH_SECRET, ...).
 */

/** Values a license can entitle its holder to; the server signs, never interprets. */
export const entitlementValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export type EntitlementValue = z.infer<typeof entitlementValueSchema>;
export type Entitlements = Record<string, EntitlementValue>;
export const entitlementsSchema = z.record(z.string().min(1).max(64), entitlementValueSchema);

const rateLimitSchema = z.object({
  max: z.number().int().positive(),
  timeWindow: z
    .string()
    .refine(
      (value) => Number.isFinite(durationMs(value)) && durationMs(value) > 0,
      "Use a positive duration such as 1 minute or 1 hour.",
    ),
});

const planPresetSchema = z.object({
  /** Preset entitlements the issue form starts from; all editable per license. */
  entitlements: entitlementsSchema.prefault({}),
  /** Days until expiry, from issue time. Omit for perpetual. */
  durationDays: z.number().int().positive().optional(),
  activationLimit: z.number().int().positive().optional(),
});

export const configSchema = z.object({
  branding: z
    .object({
      /** Product name shown in the console, CLI, and logs. */
      name: z.string().min(1).max(60).default("Keyforge"),
    })
    .prefault({}),
  key: z
    .object({
      /** Prefix on generated product keys, e.g. KEY-XXXXX-... */
      prefix: z
        .string()
        .regex(/^[A-Z0-9]{1,10}$/, "prefix must be 1-10 uppercase letters/digits")
        .default("KEY"),
      /** Unambiguous by default: no 0/O or 1/I — keys get read over the phone. */
      alphabet: z.string().min(10).max(64).default("23456789ABCDEFGHJKLMNPQRSTUVWXYZ"),
      groupLength: z.number().int().min(3).max(8).default(5),
      groups: z.number().int().min(2).max(8).default(4),
    })
    .prefault({}),
  signingKeys: z
    .object({
      /**
       * Public halves of keys this service no longer signs with.
       *
       * Tokens carry a `kid`, and a verifier selects its key by that id — so a
       * key that has been rotated away from still needs to be *findable* for as
       * long as tokens it signed are in the field. Listed here (public material,
       * hence config rather than the environment) and served from GET /v1/keys
       * for tooling. The active key comes from LICENSE_SIGNING_KEY; it is never
       * described here, because its private half must not be.
       */
      retired: z
        .array(
          z.object({
            kid: z
              .string()
              .regex(/^[A-Za-z0-9._-]{1,64}$/, "kid must be 1-64 of A-Z a-z 0-9 . _ -"),
            publicKeyPem: z.string().min(1),
            retiredAt: z.string().min(1),
          }),
        )
        .prefault([]),
    })
    .prefault({}),
  tokens: z
    .object({
      /** How long an issued token keeps working offline before revalidation. */
      offlineGraceDays: z.number().int().positive().default(30),
    })
    .prefault({}),
  limits: z
    .object({
      enabled: z.boolean().default(true),
      activate: rateLimitSchema.prefault({ max: 20, timeWindow: "1 minute" }),
      validate: rateLimitSchema.prefault({ max: 20, timeWindow: "1 minute" }),
      register: rateLimitSchema.prefault({ max: 30, timeWindow: "1 minute" }),
      support: rateLimitSchema.prefault({ max: 10, timeWindow: "1 hour" }),
    })
    .prefault({}),
  licenses: z
    .object({
      defaultPlan: z.string().min(1).default("standard"),
      defaultActivationLimit: z.number().int().positive().default(1),
      /** Plan name -> preset. Drives the issue form; not an enforcement list. */
      planPresets: z.record(z.string().min(1), planPresetSchema).prefault({
        standard: { entitlements: {} },
      }),
    })
    .prefault({}),
  registry: z
    .object({
      /** The install census (/v1/register + Installations page). */
      enabled: z.boolean().default(true),
      /** Whether register accepts user name/email. Off = anonymous census. */
      collectUserInfo: z.boolean().default(true),
    })
    .prefault({}),
  features: z
    .object({
      audit: z.boolean().default(true),
      backups: z.boolean().default(true),
    })
    .prefault({}),
  auth: z
    .object({
      /**
       * Better Auth admin-plugin surface (used from M3 on):
       * "core" = operator CRUD, roles, session revocation;
       * "full" = core + impersonation + ban windows;
       * or an explicit feature list.
       */
      admin: z
        .union([z.literal("core"), z.literal("full"), z.array(z.string().min(1))])
        .prefault("core"),
    })
    .prefault({}),
});

export type AppConfig = z.infer<typeof configSchema>;

/**
 * The port to listen on. Most platform-as-a-service hosts (Fly, Railway,
 * Koyeb, and anything Heroku-shaped) assign a port and pass it as PORT; a
 * service that ignores it binds 4100, fails every health check, and gives no
 * hint why. LICENSE_PORT still wins when it is set explicitly — an operator's
 * own choice outranks the host's convention.
 */
export function resolveListenPort(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env.LICENSE_PORT ?? env.PORT;
  const port = Number(configured);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 4100;
}

/** The built-in defaults, with no config file involved. */
export function defaultConfig(): AppConfig {
  return configSchema.parse({});
}

/**
 * Load the deployment config. A missing file means pure defaults; a present
 * but invalid file is a startup error — a licensing service running with half
 * of its policy silently dropped would be worse than one that refuses to boot.
 */
export function loadConfig(path = process.env.LICENSE_CONFIG ?? "keyforge.config.json"): AppConfig {
  if (!existsSync(path)) return defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${(error as Error).message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid config in ${path}:\n${issues}`);
  }
  return parsed.data;
}
