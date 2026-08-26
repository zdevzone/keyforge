import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildLicenseApp } from "./app.js";
import { createAuth, ensureAuthSchema, seedOperator, type AuthInstance } from "./auth.js";
import { loadConfig, resolveListenPort } from "./config.js";
import { isPostgresUrl } from "./database.js";
import { LicenseDatabase } from "./db.js";
import { parseEnv } from "./env.js";
import { describeSigningKey, resolveSigningKey } from "./keypair.js";

/**
 * Deployment entry for the vendor's host. The signing key arrives via the
 * environment — as PEM text, or as a path to a PEM file — and is required:
 * a licensing service that cannot sign is not degraded, it is useless, so it
 * refuses to start rather than answering unsigned.
 *
 * The same reasoning covers a key that is present but wrong. An RSA key, a
 * public key pasted by mistake, or a PEM flattened onto one line all load
 * fine and then throw on the first activation — a service that answers health
 * checks while failing every customer. So the key is validated here, at boot,
 * where the failure is one deploy log line instead of a support queue.
 */
function resolvePrivateKey(): string {
  return resolveSigningKey(process.env);
}

// First thing, before a file is opened or a port is claimed: every variable
// this service reads, checked for shape. Absence is fine almost everywhere --
// no DATABASE_URL means SQLite, no LICENSE_AUTH_SECRET means no console -- but
// a value that is present and malformed stops the boot here, naming itself,
// rather than becoming a confusing failure later or a silent wrong default.
const env = parseEnv(process.env);

const config = loadConfig();
const port = resolveListenPort();
const host = env.LICENSE_HOST ?? "0.0.0.0";
const dbPath = env.LICENSE_DB_PATH ?? "licenses.sqlite";
// DATABASE_URL is the switch: a postgres:// URL selects Postgres, absence
// keeps the zero-setup SQLite file.
const databaseUrl = env.DATABASE_URL;
const usingPostgres = isPostgresUrl(databaseUrl);

// Create the containing directory when a nested DB path is configured.
if (!usingPostgres) mkdirSync(dirname(dbPath), { recursive: true });

const database = await LicenseDatabase.open({ url: databaseUrl, sqlitePath: dbPath });

// The admin console needs a cookie secret; without one it stays off and the
// service keeps its CLI-only shape. Auth data lives beside the license ledger:
// in the same Postgres database, or in a sqlite sidecar file.
let auth: AuthInstance | undefined;
if (env.LICENSE_AUTH_SECRET) {
  const authDbPath = env.LICENSE_AUTH_DB_PATH ?? join(dirname(dbPath), "auth.sqlite");
  const baseURL = env.LICENSE_SERVER_URL?.replace(/\/$/, "") ?? `http://localhost:${port}`;
  auth = createAuth({
    dbPath: authDbPath,
    url: databaseUrl,
    secret: env.LICENSE_AUTH_SECRET,
    baseURL,
    trustedOrigins: [
      // Local access works under either loopback spelling.
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      // The Vite dev server proxies to this process during UI development.
      "http://localhost:5173",
    ],
  });
  await ensureAuthSchema(auth);

  // Boot-time operator seeding, for hosts without shell access and hosts that
  // wipe their disk on deploy. Idempotent: an existing user (and password) is
  // never touched, so a failed seed should warn, not take the service down.
  const seedEmail = env.LICENSE_SEED_ADMIN_EMAIL;
  const seedPassword = env.LICENSE_SEED_ADMIN_PASSWORD;
  if (seedEmail && seedPassword) {
    try {
      const outcome = await seedOperator({
        dbPath: authDbPath,
        url: databaseUrl,
        secret: env.LICENSE_AUTH_SECRET,
        baseURL,
        email: seedEmail,
        password: seedPassword,
      });
      console.log(
        outcome === "created"
          ? `[license-server] Seeded admin operator ${seedEmail}.`
          : `[license-server] Admin operator ${seedEmail} already exists — seed skipped.`,
      );
    } catch (error) {
      console.warn(`[license-server] Could not seed admin operator ${seedEmail}:`, error);
    }
  } else if (seedEmail || seedPassword) {
    console.warn(
      "[license-server] Set both LICENSE_SEED_ADMIN_EMAIL and LICENSE_SEED_ADMIN_PASSWORD to seed an operator — one alone does nothing.",
    );
  }
}

const privateKey = resolvePrivateKey();
// Throws with a diagnosis when the key is unusable, before anything binds a
// port. See src/keypair.ts for the cases this catches.
const signingKey = describeSigningKey(privateKey);

const app = await buildLicenseApp({
  privateKey,
  signingKey,
  adminToken: env.LICENSE_ADMIN_TOKEN,
  database,
  config,
  auth,
  // Only a sqlite sidecar can be snapshotted through the backup endpoint.
  authDbPath:
    auth && !usingPostgres
      ? (env.LICENSE_AUTH_DB_PATH ?? join(dirname(dbPath), "auth.sqlite"))
      : undefined,
});

await app.listen({ port, host });
console.log(
  `${config.branding.name} license service listening on ${host}:${port} (${database.engine})`,
);
// Printed every boot so "which key is production actually signing with?" is
// answerable from the platform's log tail. The public half only.
console.log(`[license-server] signing key ${signingKey.keyType} ${signingKey.fingerprint}`);
if (!env.LICENSE_ADMIN_TOKEN) {
  console.warn("[license-server] LICENSE_ADMIN_TOKEN is not set — CLI admin access is disabled.");
}
if (!auth) {
  console.warn("[license-server] LICENSE_AUTH_SECRET is not set — the admin console is disabled.");
}
