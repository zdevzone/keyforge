import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin as adminPlugin } from "better-auth/plugins";
import Database from "better-sqlite3";
import { z } from "zod";

import { createPostgresPool, isPostgresUrl } from "./database.js";
import { ac, roles } from "./permissions.js";

export const AUTH_PREFIX = "keyforge_auth_";
export const BOOTSTRAP_ADMIN_TABLE = "keyforge_bootstrap_admin";

const authHandles = new WeakMap<object, ReturnType<typeof openAuthDatabase>>();
export async function closeAuth(auth: AuthInstance): Promise<void> {
  const handle = authHandles.get(auth);
  if (!handle) return;
  authHandles.delete(auth);
  if ("end" in handle) await handle.end();
  else handle.close();
}

/**
 * Identity for the admin console, stored beside the license ledger.
 * Unified SQLite uses prefixed auth tables; PostgreSQL retains its schema. The CLI keeps using the bearer token; the browser
 * signs in here and carries a session cookie instead.
 *
 * Sign-up is disabled on the running service — operators are created with
 * `vp run admin:create`, the same way the admin token is provisioned by hand.
 */

export interface CreateAuthOptions {
  /** SQLite file for users and sessions; runtime uses the unified license file. */
  dbPath: string;
  /**
   * postgres:// URL. When set, operators live in that database beside the
   * ledger (Better Auth creates its own tables) and dbPath is ignored.
   */
  url?: string;
  /** Secret for session cookies and hashes. Absent secret = no admin console. */
  secret: string;
  /** Public origin of the service, so cookie origin checks line up. */
  baseURL?: string;
  /** Extra origins allowed to call the auth endpoints (the Vite dev server). */
  trustedOrigins?: string[];
  /** Only the create-admin script turns this on; the service never does. */
  allowSignUp?: boolean;
  /** Seconds an impersonated session lasts, when impersonation is enabled. */
  impersonationSessionDuration?: number;
}

function openAuthDatabase(options: CreateAuthOptions) {
  if (isPostgresUrl(options.url)) {
    // Same pool policy as the ledger: verified TLS, bounded size, and an
    // error listener so a dropped idle client cannot take the process down.
    return createPostgresPool(options.url);
  }
  const database = new Database(options.dbPath);
  database.pragma("journal_mode = WAL");
  return database;
}

export function createAuth(options: CreateAuthOptions) {
  const database = openAuthDatabase(options);
  const unified = !isPostgresUrl(options.url);
  const auth = betterAuth({
    database,
    // Boot explicitly migrates and checks the schema before serving requests.
    // Avoid Better Auth racing that migration with its eager preflight check.
    advanced: { database: { validateSchema: false } },
    secret: options.secret,
    session: { modelName: unified ? AUTH_PREFIX + "session" : "session" },
    account: { modelName: unified ? AUTH_PREFIX + "account" : "account" },
    verification: { modelName: unified ? AUTH_PREFIX + "verification" : "verification" },
    user: {
      modelName: unified ? AUTH_PREFIX + "user" : "user",
      additionalFields: {
        phone: { type: "string", required: false, validator: { input: z.string().max(50) } },
        jobTitle: { type: "string", required: false, validator: { input: z.string().max(100) } },
        timezone: {
          type: "string",
          required: false,
          validator: {
            input: z.string().refine((value) => {
              try {
                new Intl.DateTimeFormat("en", { timeZone: value });
                return true;
              } catch {
                return false;
              }
            }, "Choose a valid timezone"),
          },
        },
      },
    },
    baseURL: options.baseURL,
    // The console is same-origin by construction — the SPA is served by this
    // very process — so the host the browser is talking to is always a
    // legitimate origin. Deriving it per-request keeps logins working when
    // LICENSE_SERVER_URL is unset or drifts from the real deployment URL
    // (otherwise Better Auth answers "Invalid origin"). This stays CSRF-safe:
    // a forged cross-site request still carries the attacker's Origin header,
    // which never matches the host being requested.
    trustedOrigins: (request?: Request) => {
      const origins = [...(options.trustedOrigins ?? [])];
      const host = request?.headers.get("host");
      if (host) origins.push(`https://${host}`, `http://${host}`);
      return origins;
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.allowSignUp,
    },
    plugins: [
      adminPlugin({
        ac,
        roles,
        // New operators start with the lesser role: adding someone to the
        // console should not hand them the keys by accident.
        defaultRole: "support",
        adminRoles: ["admin"],
        ...(options.impersonationSessionDuration
          ? { impersonationSessionDuration: options.impersonationSessionDuration }
          : {}),
      }),
    ],
  });
  authHandles.set(auth, database);
  return auth;
}

export type AuthInstance = ReturnType<typeof createAuth>;

/**
 * Create or update Better Auth's tables, then make sure every operator has a
 * role.
 *
 * The admin plugin adds a `role` column whose default is the lesser role, so a
 * database written before roles existed would come back with its operators
 * demoted — locking the vendor out of their own console on the first upgrade.
 * Those operators had full access by definition (there was nothing else), so
 * they are restored to `admin`. Idempotent: only null/empty roles are touched.
 */
export async function ensureAuthSchema(auth: AuthInstance): Promise<number> {
  await migrateLegacyPostgresAccountIssuer(auth);
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  const checked = await getMigrations(auth.options);
  if (
    checked.toBeCreated.length ||
    checked.toBeAdded.length ||
    checked.schemaProblems.length ||
    checked.unsafeChanges.length
  )
    throw new Error(
      "Operator schema validation failed after migrations. " +
        [...checked.schemaProblems, ...checked.unsafeChanges].join(" "),
    );
  const promoted = await backfillOperatorRoles(auth);
  const handle = authHandles.get(auth)!;
  const statement = `CREATE TABLE IF NOT EXISTS ${BOOTSTRAP_ADMIN_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL)`;
  if ("connect" in handle) {
    const client = await handle.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4919071115)");
      await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } else handle.exec(statement);
  return promoted;
}

/** Better Auth 1.7.0–1.7.2 required account.issuer; 1.7.3+ no longer writes it.
 * Follow the upstream upgrade guide without dropping historical account data.
 * The transaction lock works through managed transaction poolers too. */
async function migrateLegacyPostgresAccountIssuer(auth: AuthInstance): Promise<void> {
  const handle = authHandles.get(auth);
  if (!handle || !("connect" in handle)) return;
  const client = await handle.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(4919071115)");
    const { rows } = await client.query<{ table_schema: string }>(
      "SELECT table_schema FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'account' AND column_name = 'issuer'",
    );
    if (rows.length) {
      const schema = '"' + rows[0].table_schema.replaceAll('"', '""') + '"';
      const duplicates = await client.query(
        `SELECT 1 FROM ${schema}."account" GROUP BY "providerId", "accountId" HAVING count(*) > 1 LIMIT 1`,
      );
      if (duplicates.rows.length)
        throw new Error(
          "Operator account provider/account keys are duplicated. Resolve those identities before upgrading Better Auth; no issuer compatibility changes were applied.",
        );
      await client.query(`ALTER TABLE ${schema}."account" ALTER COLUMN "issuer" DROP NOT NULL`);
      await client.query(`DROP INDEX IF EXISTS ${schema}."account_issuer_accountId_uidx"`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function backfillOperatorRoles(auth: AuthInstance): Promise<number> {
  const adapter = await auth.$context.then((context) => context.adapter);
  const operators = (await adapter.findMany({
    model: "user",
    limit: 1000,
  })) as Array<{ id: string; role?: string | null }>;
  let promoted = 0;
  for (const operator of operators) {
    if (operator.role) continue;
    await adapter.update({
      model: "user",
      where: [{ field: "id", value: operator.id }],
      update: { role: "admin" },
    });
    promoted += 1;
  }
  return promoted;
}

export interface SeedOperatorOptions {
  dbPath: string;
  /** postgres:// URL, when operators live in Postgres. */
  url?: string;
  secret: string;
  baseURL?: string;
  email: string;
  password: string;
  name?: string;
}

/**
 * Create an operator if that email does not exist yet. Idempotent on purpose:
 * an existing user — and, critically, their password — is never touched, so
 * this is safe to run on every boot. This is how operators survive hosts
 * without shell access and hosts that wipe their disk on deploy (Render free
 * tier): set LICENSE_SEED_ADMIN_EMAIL / LICENSE_SEED_ADMIN_PASSWORD and the
 * operator is recreated whenever it is missing.
 */
export async function seedOperator(options: SeedOperatorOptions): Promise<"created" | "exists"> {
  // A private instance with sign-up enabled, pointed at the same database.
  // The instance the service exposes never allows sign-up.
  const auth = createAuth({
    dbPath: options.dbPath,
    url: options.url,
    secret: options.secret,
    baseURL: options.baseURL,
    allowSignUp: true,
  });
  try {
    await ensureAuthSchema(auth);
    await auth.api.signUpEmail({
      body: {
        email: options.email,
        password: options.password,
        name: options.name ?? options.email,
      },
    });
    // Sign-up applies the default (lesser) role; the bootstrap operator is the
    // one account that must be able to run everything, including adding others.
    const context = await auth.$context;
    const created = (await context.adapter.findOne({
      model: "user",
      where: [{ field: "email", value: options.email }],
    })) as { id: string } | null;
    if (created) {
      await context.adapter.update({
        model: "user",
        where: [{ field: "id", value: created.id }],
        update: { role: "admin" },
      });
    }
    await rememberBootstrapAdmin(auth, options.email);
    return "created";
  } catch (error) {
    const code = (error as { body?: { code?: string } })?.body?.code ?? "";
    const message = (error as Error)?.message ?? "";
    if (code === "USER_ALREADY_EXISTS" || /already exists/i.test(message)) {
      await rememberBootstrapAdmin(auth, options.email);
      return "exists";
    }
    throw error;
  } finally {
    await closeAuth(auth);
  }
}

async function rememberBootstrapAdmin(auth: AuthInstance, email: string) {
  const handle = authHandles.get(auth)!;
  const users = "connect" in handle ? '"user"' : AUTH_PREFIX + "user";
  const statement = `INSERT INTO ${BOOTSTRAP_ADMIN_TABLE} (id, user_id) SELECT 1, id FROM ${users} WHERE email = ${"connect" in handle ? "$1" : "?"} AND role = 'admin' ON CONFLICT (id) DO NOTHING`;
  if ("query" in handle) await handle.query(statement, [email]);
  else handle.prepare(statement).run(email);
}
