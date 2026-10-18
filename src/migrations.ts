import { sql, type Kysely } from "kysely";

import { tableExists, type Engine } from "./database.js";
import type { Database } from "./schema.js";
interface Migration {
  name: string;
  up: (db: Kysely<Database>, engine: Engine) => Promise<void>;
}
const migrations: Migration[] = [
  {
    name: "001_v1",
    up: async (db, engine) => {
      await db.schema
        .createTable("platform_records")
        .addColumn("scope", "text", (c) => c.notNull())
        .addColumn("kind", "text", (c) => c.notNull())
        .addColumn("id", "text", (c) => c.notNull())
        .addColumn("data", "text", (c) => c.notNull())
        .addColumn("revision", "integer", (c) => c.notNull())
        .addPrimaryKeyConstraint("platform_records_pk", ["scope", "kind", "id"])
        .execute();
      await db.schema
        .createTable("platform_lock")
        .addColumn("id", "integer", (c) => c.primaryKey())
        .addColumn("value", "integer", (c) => c.notNull())
        .execute();
      await db.insertInto("platform_lock").values({ id: 1, value: 0 }).execute();
      await sql`CREATE TABLE audit_log (id ${sql.raw(engine === "postgres" ? "bigserial PRIMARY KEY" : "integer PRIMARY KEY AUTOINCREMENT")}, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, license_id TEXT, detail TEXT NOT NULL)`.execute(
        db,
      );
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
  return db.transaction().execute(async (trx) => {
    if (engine === "postgres")
      await sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`.execute(trx);
    return applyMigrations(trx, engine);
  });
}

async function applyMigrations(db: Kysely<Database>, engine: Engine): Promise<string[]> {
  await ensureMigrationsTable(db, engine);
  const applied = await sql<{ name: string }>`SELECT name FROM schema_migrations`.execute(db);
  const done = new Set(applied.rows.map((row) => row.name));
  if ([...done].some((name) => name !== "001_v1"))
    throw new Error(
      "This build requires a fresh v1 database. Create/reset the development database; no older schema is imported.",
    );
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
