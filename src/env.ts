import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Every environment variable this service reads, validated in one place.
 *
 * `keyforge.config.json` has been schema-checked since M1, but the environment
 * — which holds the *secrets* and the deployment wiring — was read ad hoc from
 * a dozen call sites with no validation at all. The failure mode is the one M8
 * fixed for the signing key, generalised: a typo'd or malformed value is
 * accepted at boot and surfaces later as a confusing runtime error, or worse,
 * as a silently wrong default.
 *
 * `LICENSE_DB_POOL_MAX=ten` was exactly that: `Number("ten")` is NaN, the guard
 * in resolvePostgresOptions rejected it, and the deployment quietly ran on 5
 * connections while the operator believed they had configured something.
 * Wrong-but-plausible is worse than broken, because nobody investigates it.
 *
 * ## Almost everything here is optional, on purpose
 *
 * This is not the usual T3 Env shape, where absent variables are errors. Most
 * of Keyforge's configuration is *absence-driven*, and those defaults are
 * promises the README makes:
 *
 * - no `DATABASE_URL` → SQLite, the zero-setup default
 * - no `LICENSE_AUTH_SECRET` → the admin console stays off, CLI-only
 * - no `LICENSE_ADMIN_TOKEN` → the admin API answers 503 rather than opening
 *
 * Making any of those required would turn a working deployment into a failed
 * boot on upgrade. So this module validates *shape* — that what is present is
 * usable — and leaves *presence* to the code that knows what each subsystem
 * needs. Where a value is required, it is required at the point of use, with a
 * message naming what it unlocks.
 */

/** A PEM or a path, kept as free text: keypair.ts does the real diagnosis. */
const nonEmpty = z.string().min(1);

export const envSchema = {
  // --- database ---------------------------------------------------------
  /** postgres:// or postgresql:// selects Postgres. Absent means SQLite. */
  DATABASE_URL: z
    .string()
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      "DATABASE_URL must start with postgres:// or postgresql:// (leave it unset for SQLite)",
    )
    .optional(),
  /** SQLite file path. Ignored when DATABASE_URL is set. */
  LICENSE_DB_PATH: nonEmpty.optional(),
  /**
   * Postgres pool size. Coerced and bounded here rather than in the connection
   * helper, so "ten" is a boot failure naming the variable instead of a silent
   * fallback to the default.
   */
  LICENSE_DB_POOL_MAX: z.coerce.number().int().positive().max(100).optional(),

  // --- signing ----------------------------------------------------------
  /** Ed25519 private key as PEM text. Validated properly by keypair.ts. */
  LICENSE_SIGNING_KEY: nonEmpty.optional(),
  /** Path to the PEM, as an alternative to inlining it. */
  LICENSE_SIGNING_KEY_FILE: nonEmpty.optional(),

  // --- admin surfaces ---------------------------------------------------
  /**
   * Bearer token for the admin API. Absent means the admin surface answers
   * 503 — misconfiguration fails closed. A short one is worse than none,
   * because it looks like security, so the floor is deliberate.
   */
  LICENSE_ADMIN_TOKEN: z
    .string()
    .min(16, "LICENSE_ADMIN_TOKEN should be at least 16 characters — it is the whole admin gate")
    .optional(),
  /** Cookie secret for the console. Absent means no console at all. */
  LICENSE_AUTH_SECRET: z
    .string()
    .min(16, "LICENSE_AUTH_SECRET should be at least 16 characters; it signs session cookies")
    .optional(),
  /** Auth sidecar path. Only used on SQLite deployments. */
  LICENSE_AUTH_DB_PATH: nonEmpty.optional(),

  // --- boot-time operator seeding ---------------------------------------
  /** Both or neither; one alone does nothing, and index.ts says so. */
  LICENSE_SEED_ADMIN_EMAIL: z.string().email().optional(),
  LICENSE_SEED_ADMIN_PASSWORD: nonEmpty.optional(),

  // --- networking -------------------------------------------------------
  /**
   * Public URL of this deployment. Also the CLI's target. Validated as a URL
   * because a bare hostname here produces Better Auth redirects that fail in
   * a way nobody traces back to this variable.
   */
  LICENSE_SERVER_URL: z.string().url().optional(),
  LICENSE_HOST: nonEmpty.optional(),
  /**
   * LICENSE_PORT wins over PORT; both are optional and the fallback is 4100.
   * Kept as strings here — resolveListenPort() owns the precedence, and
   * duplicating it would create two answers to one question.
   */
  LICENSE_PORT: z.coerce.number().int().positive().max(65535).optional(),
  PORT: z.coerce.number().int().positive().max(65535).optional(),

  // --- config file ------------------------------------------------------
  LICENSE_CONFIG: nonEmpty.optional(),
};

/**
 * Validate the environment and return it typed.
 *
 * Takes the source object rather than closing over `process.env`, matching
 * resolvePostgresOptions and resolveSigningKey — tests pass a literal, and no
 * test is at the mercy of the shell it runs in.
 *
 * `emptyStringAsUndefined` matters more here than it looks: a dashboard env
 * field cleared to "" is the most common way an operator "unsets" a variable,
 * and without this it would arrive as a present-but-empty value that passes a
 * presence check and fails everything after it.
 */
export function parseEnv(runtimeEnv: Record<string, string | undefined> = process.env) {
  return createEnv({
    server: envSchema,
    runtimeEnv,
    emptyStringAsUndefined: true,
    onValidationError: (issues) => {
      const lines = issues.map((issue) => {
        const name = issue.path?.join(".") ?? "(unknown)";
        return `  ${name}: ${issue.message}`;
      });
      throw new Error(
        `Environment is not usable:\n${lines.join("\n")}\n\n` +
          "See docs/deploy.md for what each variable does. Most are optional — " +
          "an unset variable is fine, a malformed one is not.",
      );
    },
  });
}

export type Env = ReturnType<typeof parseEnv>;
