import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { waitUntil } from "@vercel/functions";

import { buildLicenseApp } from "./app.js";
import {
  closeAuth,
  createAuth,
  ensureAuthSchema,
  seedOperator,
  type AuthInstance,
} from "./auth.js";
import { storageOptionsFromEnv } from "./backup-destinations.js";
import { loadConfig, resolveListenPort } from "./config.js";
import { isPostgresUrl } from "./database.js";
import { LicenseDatabase } from "./db.js";
import { parseEnv } from "./env.js";
import { describeSigningKey, resolveKid, resolveSigningKey } from "./keypair.js";
import { resolveRuntime } from "./runtime.js";
import { loadKeyRing } from "./secrets.js";
import { validateVercelEnvironment } from "./vercel-config.js";

/** One boot path for persistent hosts and Vercel Functions. */
export async function createLicenseServer(serverless = false) {
  // First thing, before a file is opened or a port is claimed: every variable
  // this service reads, checked for shape. Absence is fine almost everywhere --
  // no DATABASE_URL means SQLite, no LICENSE_AUTH_SECRET means no console -- but
  // a value that is present and malformed stops the boot here, naming itself,
  // rather than becoming a confusing failure later or a silent wrong default.
  const env = parseEnv(process.env);
  if (serverless) validateVercelEnvironment(env);
  if (process.env.NODE_ENV === "production" && env.LICENSE_AUTH_SECRET && !env.LICENSE_SERVER_URL)
    throw new Error(
      "LICENSE_SERVER_URL or a platform public URL is required for the production console.",
    );

  const privateKey = resolveSigningKey(process.env);
  // Throws with a diagnosis when the key is unusable, before anything binds a
  // port. See src/keypair.ts for the cases this catches.
  const signingKey = describeSigningKey(privateKey);
  // Named here rather than inside the app so the boot log below prints the same
  // id the tokens will carry — "which key is production signing with?" and "what
  // kid should the app pin?" are the same question, and this is the answer.
  const kid = resolveKid(signingKey, process.env);

  const config = loadConfig();
  const port = resolveListenPort();
  const runtime = resolveRuntime(process.env);
  const dbPath = runtime.sqlitePath;
  // DATABASE_URL is the switch: a postgres:// URL selects Postgres, absence
  // keeps the zero-setup SQLite file.
  const databaseUrl = runtime.url;
  const usingPostgres = isPostgresUrl(databaseUrl);

  // Create the containing directory when a nested DB path is configured.
  if (!usingPostgres) mkdirSync(dirname(dbPath), { recursive: true });

  const database = await LicenseDatabase.open({ url: databaseUrl, sqlitePath: dbPath });

  // The admin console needs a cookie secret; without one it stays off and the
  // service keeps its CLI-only shape. Auth and licensing share one database.
  let auth: AuthInstance | undefined;
  try {
    if (env.LICENSE_AUTH_SECRET) {
      const authDbPath = runtime.authDbPath;
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
      // Vercel's deployment preparation initializes auth once. Do not race
      // Better Auth DDL from concurrently starting function instances.
      if (!serverless) await ensureAuthSchema(auth);

      // Boot-time operator seeding, for hosts without shell access and hosts that
      // wipe their disk on deploy. Idempotent: an existing user (and password) is
      // never touched, so a failed seed should warn, not take the service down.
      const seedEmail = env.LICENSE_SEED_ADMIN_EMAIL;
      const seedPassword = env.LICENSE_SEED_ADMIN_PASSWORD;
      if (!serverless && seedEmail && seedPassword) {
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
      } else if (!serverless && (seedEmail || seedPassword)) {
        console.warn(
          "[license-server] Set both LICENSE_SEED_ADMIN_EMAIL and LICENSE_SEED_ADMIN_PASSWORD to seed an operator — one alone does nothing.",
        );
      }
    }

    const app = await buildLicenseApp({
      serveStaticAssets: !serverless,
      privateKey,
      signingKey,
      kid,
      adminToken: env.LICENSE_ADMIN_TOKEN,
      database,
      config,
      auth,
      keyring: loadKeyRing("LICENSE_DATA_KEYRING"),
      backups: {
        ...storageOptionsFromEnv(process.env),
        keyring: loadKeyRing("LICENSE_BACKUP_KEYRING"),
        directory: serverless ? join(tmpdir(), "keyforge-backups") : env.LICENSE_BACKUP_DIR,
        ...(serverless
          ? {
              remoteOnly: true,
              portablePostgres: true,
              defaultDestination: "blob",
              background: waitUntil,
              cronSecret: env.CRON_SECRET,
            }
          : {}),
        databaseUrl,
        verificationUrl: env.LICENSE_BACKUP_VERIFY_DATABASE_URL,
      },
      // The unified SQLite snapshot includes auth and licensing.
      authDbPath: auth && !usingPostgres ? runtime.authDbPath : undefined,
    });

    app.addHook("onClose", async () => {
      if (auth) await closeAuth(auth);
      await database.close();
    });

    return { app, config, database, signingKey, kid, env };
  } catch (error) {
    if (auth) await closeAuth(auth);
    await database.close();
    throw error;
  }
}
