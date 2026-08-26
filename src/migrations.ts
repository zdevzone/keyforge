import { sql, type Kysely } from "kysely";

import { tableColumns, tableExists, type Engine } from "./database.js";
import type { Database } from "./schema.js";

/**
 * Schema migrations, run at boot.
 *
 * Deliberately hand-rolled rather than Kysely's file-based Migrator: the
 * service ships as a single compiled bundle (and a Docker image), where a
 * migrations *folder* to discover at runtime is a deployment footgun. Each
 * step is idempotent and recorded in `schema_migrations`, so booting an old
 * database or a fresh one both converge.
 */

interface Migration {
  name: string;
  up: (db: Kysely<Database>, engine: Engine) => Promise<void>;
}

/** `INTEGER PRIMARY KEY AUTOINCREMENT` has no portable spelling. */
function autoIncrementId(engine: Engine) {
  return engine === "postgres"
    ? sql`bigserial PRIMARY KEY`
    : sql`integer PRIMARY KEY AUTOINCREMENT`;
}

const migrations: Migration[] = [
  {
    name: "001_core_tables",
    up: async (db, engine) => {
      if (!(await tableExists(db, engine, "licenses"))) {
        await db.schema
          .createTable("licenses")
          .addColumn("id", "text", (column) => column.primaryKey())
          .addColumn("key_hash", "text", (column) => column.notNull().unique())
          .addColumn("plan", "text", (column) => column.notNull())
          .addColumn("entitlements", "text", (column) => column.notNull().defaultTo("{}"))
          .addColumn("issued_to", "text", (column) => column.notNull().defaultTo(""))
          .addColumn("status", "text", (column) => column.notNull().defaultTo("active"))
          .addColumn("activation_limit", "integer", (column) => column.notNull().defaultTo(1))
          .addColumn("issued_at", "text", (column) => column.notNull())
          .addColumn("expires_at", "text")
          .addColumn("revoked_at", "text")
          .addCheckConstraint("licenses_status_check", sql`status IN ('active', 'revoked')`)
          .execute();
      }

      if (!(await tableExists(db, engine, "activations"))) {
        await db.schema
          .createTable("activations")
          .addColumn("license_id", "text", (column) =>
            column.notNull().references("licenses.id").onDelete("cascade"),
          )
          .addColumn("installation_id", "text", (column) => column.notNull())
          .addColumn("activated_at", "text", (column) => column.notNull())
          .addColumn("deactivated_at", "text")
          .addPrimaryKeyConstraint("activations_pkey", ["license_id", "installation_id"])
          .execute();
      }

      if (!(await tableExists(db, engine, "installations"))) {
        await db.schema
          .createTable("installations")
          .addColumn("installation_id", "text", (column) => column.primaryKey())
          .addColumn("registered_at", "text", (column) => column.notNull())
          .addColumn("last_seen_at", "text", (column) => column.notNull())
          .addColumn("app_version", "text", (column) => column.notNull().defaultTo(""))
          .addColumn("platform", "text", (column) => column.notNull().defaultTo(""))
          .addColumn("user_name", "text", (column) => column.notNull().defaultTo(""))
          .addColumn("user_email", "text", (column) => column.notNull().defaultTo(""))
          .addColumn("license_id", "text", (column) => column.references("licenses.id"))
          .execute();
      }

      if (!(await tableExists(db, engine, "audit_log"))) {
        await db.schema
          .createTable("audit_log")
          .addColumn("id", sql`${autoIncrementId(engine)}` as never)
          .addColumn("at", "text", (column) => column.notNull())
          .addColumn("actor", "text", (column) => column.notNull())
          .addColumn("action", "text", (column) => column.notNull())
          .addColumn("license_id", "text")
          .addColumn("detail", "text", (column) => column.notNull().defaultTo("{}"))
          .execute();
        await db.schema
          .createIndex("idx_audit_log_license")
          .on("audit_log")
          .column("license_id")
          .execute();
      }
    },
  },
  {
    name: "002_entitlements",
    up: async (db, engine) => {
      // Databases created before entitlements existed carry an `allowance`
      // integer column instead. Add the new column, fold the old values in,
      // and leave the legacy column alone — dropping a column a rolled-back
      // deployment might still write to is not worth the risk.
      const columns = await tableColumns(db, engine, "licenses");
      if (!columns.has("entitlements")) {
        await db.schema
          .alterTable("licenses")
          .addColumn("entitlements", "text", (column) => column.notNull().defaultTo("{}"))
          .execute();
      }
      if (columns.has("allowance")) {
        // json_set (SQLite) and jsonb juggling (Postgres) both exist, but a
        // plain string build works on both and this runs once.
        await sql`
          UPDATE licenses
          SET entitlements = '{"allowance":' || CAST(allowance AS ${sql.raw(
            engine === "postgres" ? "text" : "TEXT",
          )}) || '}'
          WHERE entitlements = '{}' AND allowance IS NOT NULL AND allowance > 0
        `.execute(db);
      }
    },
  },
  {
    name: "003_drop_legacy_allowance",
    up: async (db, engine) => {
      // The legacy column is NOT NULL with no default, so leaving it in place
      // makes every new insert fail once inserts stopped mentioning it. Its
      // values were folded into entitlements by 002, so dropping it loses
      // nothing — and it keeps the insert path free of legacy special cases.
      const columns = await tableColumns(db, engine, "licenses");
      if (columns.has("allowance")) {
        await db.schema.alterTable("licenses").dropColumn("allowance").execute();
      }
    },
  },
];

async function ensureMigrationsTable(db: Kysely<Database>, engine: Engine): Promise<void> {
  if (await tableExists(db, engine, "schema_migrations")) return;
  await sql`
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `.execute(db);
}

/**
 * A fixed, arbitrary key identifying "Keyforge is migrating this database".
 * Any two instances that agree on the number serialize against each other.
 */
const MIGRATION_LOCK_KEY = 4_919_071_113;

/**
 * Apply every migration that has not run yet. Safe to call on every boot.
 *
 * On Postgres this runs inside a transaction holding an advisory lock, because
 * a managed database is usually shared by more than one instance: two starting
 * together would otherwise both see a migration as unapplied and both run it.
 * The lock is transaction-scoped rather than session-scoped on purpose — it is
 * released by the commit, which keeps it correct through a connection pooler
 * (Neon's `-pooler` endpoint, PgBouncer) where a session can move between
 * backends. The instance that waits then finds nothing left to do.
 */
export async function migrateToLatest(db: Kysely<Database>, engine: Engine): Promise<string[]> {
  if (engine !== "postgres") return applyMigrations(db, engine);
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`.execute(trx);
    return applyMigrations(trx, engine);
  });
}

async function applyMigrations(db: Kysely<Database>, engine: Engine): Promise<string[]> {
  await ensureMigrationsTable(db, engine);
  const applied = await sql<{ name: string }>`SELECT name FROM schema_migrations`.execute(db);
  const done = new Set(applied.rows.map((row) => row.name));
  const ran: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    await migration.up(db, engine);
    await sql`
      INSERT INTO schema_migrations (name, applied_at)
      VALUES (${migration.name}, ${new Date().toISOString()})
    `.execute(db);
    ran.push(migration.name);
  }
  return ran;
}
