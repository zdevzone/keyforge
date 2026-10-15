/**
 * Create (or re-create the password of) an admin console operator.
 *
 * Sign-up is disabled on the running service; this script is the only door,
 * the same way LICENSE_ADMIN_TOKEN is provisioned by hand. It writes to the
 * auth database directly, so run it on the machine that hosts the service —
 * build first (`vp run build`), then:
 *
 *   vp run admin:create --email you@example.com --password "long secret" [--name "You"]
 *
 * Reads LICENSE_AUTH_SECRET, LICENSE_DB_PATH from the
 * environment exactly as the server does.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { seedOperator } from "../dist/src/auth.js";
import { resolveRuntime } from "../dist/src/runtime.js";

const rest = process.argv.slice(2);

function flag(name) {
  const index = rest.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = rest[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

const email = flag("email");
const password = flag("password");
const name = flag("name") ?? email;

if (!email || !password) {
  console.error(
    'Usage: vp run admin:create --email you@example.com --password "long secret" [--name "You"]',
  );
  process.exit(1);
}
if (!process.env.LICENSE_AUTH_SECRET) {
  console.error("Set LICENSE_AUTH_SECRET (a long random string) in the environment first.");
  process.exit(1);
}

const { url, authDbPath } = resolveRuntime();
if (!url) {
  mkdirSync(dirname(authDbPath), { recursive: true });
}

try {
  const outcome = await seedOperator({
    dbPath: authDbPath,
    url,
    secret: process.env.LICENSE_AUTH_SECRET,
    // Silences Better Auth's base-URL warning when the env provides one; the
    // value is irrelevant for direct server-side user creation.
    baseURL: (process.env.LICENSE_SERVER_URL || process.env.RENDER_EXTERNAL_URL)?.replace(
      /\/$/,
      "",
    ),
    email,
    password,
    name,
  });
  if (outcome === "created") {
    console.log(`Admin user ${email} created in ${url ? "Postgres" : authDbPath}.`);
  } else {
    console.log(`Admin user ${email} already exists in ${authDbPath} — nothing changed.`);
  }
} catch (error) {
  const message = error?.body?.message ?? error?.message ?? String(error);
  console.error(`Could not create ${email}: ${message}`);
  process.exit(1);
}
