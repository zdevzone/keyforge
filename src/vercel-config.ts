import type { parseEnv } from "./env.js";

/** Refuse ephemeral SQLite, missing encryption, and local-only backups. */
export function validateVercelEnvironment(env: ReturnType<typeof parseEnv>) {
  const required = [
    "DATABASE_URL",
    "LICENSE_AUTH_SECRET",
    "LICENSE_SERVER_URL",
    "CRON_SECRET",
    "LICENSE_BACKUP_VERIFY_DATABASE_URL",
  ] as const;
  const missing: string[] = required.filter((name) => !env[name]);
  if (!env.LICENSE_SIGNING_KEY && !env.LICENSE_SIGNING_KEY_FILE)
    missing.push("LICENSE_SIGNING_KEY");
  if (!env.LICENSE_DATA_KEYRING && !env.LICENSE_DATA_KEYRING_FILE)
    missing.push("LICENSE_DATA_KEYRING");
  if (!env.LICENSE_BACKUP_KEYRING && !env.LICENSE_BACKUP_KEYRING_FILE)
    missing.push("LICENSE_BACKUP_KEYRING");
  if (missing.length) throw Error("Vercel requires server configuration: " + missing.join(", "));
}
