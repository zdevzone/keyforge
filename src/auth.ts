import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { admin as adminPlugin } from "better-auth/plugins";
import Database from "better-sqlite3";

import { createPostgresPool, isPostgresUrl } from "./database.js";
import { ac, roles } from "./permissions.js";

/**
 * Identity for the admin console. Kept apart from the license ledger on
 * purpose: `licenses.sqlite` records what was sold, this database records who
 * may operate the counter. The CLI keeps using the bearer token; the browser
 * signs in here and carries a session cookie instead.
 *
 * Sign-up is disabled on the running service — operators are created with
 * `npm run admin:create`, the same way the admin token is provisioned by hand.
 */

export interface CreateAuthOptions {
  /** SQLite file for users and sessions, e.g. ./db/auth.sqlite. */
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
  return betterAuth({
    database,
    secret: options.secret,
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
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return backfillOperatorRoles(auth);
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
  await ensureAuthSchema(auth);
  try {
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
    return "created";
  } catch (error) {
    const code = (error as { body?: { code?: string } })?.body?.code ?? "";
    const message = (error as Error)?.message ?? "";
    if (code === "USER_ALREADY_EXISTS" || /already exists/i.test(message)) return "exists";
    throw error;
  }
}
