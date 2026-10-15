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
    name: "000_platform_records",
    up: async (db, engine) => {
      if (!(await tableExists(db, engine, "platform_records"))) {
        await db.schema
          .createTable("platform_records")
          .addColumn("scope", "text", (c) => c.notNull())
          .addColumn("kind", "text", (c) => c.notNull())
          .addColumn("id", "text", (c) => c.notNull())
          .addColumn("data", "text", (c) => c.notNull())
          .addColumn("revision", "integer", (c) => c.notNull())
          .addPrimaryKeyConstraint("platform_records_pk", ["scope", "kind", "id"])
          .execute();
      }
      if (!(await tableExists(db, engine, "platform_lock"))) {
        await db.schema
          .createTable("platform_lock")
          .addColumn("id", "integer", (c) => c.primaryKey())
          .addColumn("value", "integer", (c) => c.notNull())
          .execute();
        await db.insertInto("platform_lock").values({ id: 1, value: 0 }).execute();
      }
    },
  },
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
  {
    name: "004_machine_ledger",
    up: async (db, engine) => {
      // The trial ledger. Separate from `installations` on purpose: the census
      // counts installs and answers "who has this build?", while this answers
      // "has this *machine* had its trial?" — one installation id can move
      // between machines (a restored backup), and one machine collects many
      // installation ids over its life.
      if (!(await tableExists(db, engine, "machine_groups"))) {
        await db.schema
          .createTable("machine_groups")
          .addColumn("id", "text", (column) => column.primaryKey())
          .addColumn("support_reference", "text", (column) => column.notNull().unique())
          .addColumn("first_registered_at", "text", (column) => column.notNull())
          .addColumn("last_registered_at", "text", (column) => column.notNull())
          .addColumn("registration_count", "integer", (column) => column.notNull().defaultTo(0))
          .addColumn("recheck_count", "integer", (column) => column.notNull().defaultTo(0))
          .addColumn("trial_spent_reported", "integer", (column) => column.notNull().defaultTo(0))
          .addColumn("cleared_at", "text")
          .addColumn("cleared_at_count", "integer")
          .execute();
      }

      if (!(await tableExists(db, engine, "machine_signals"))) {
        await db.schema
          .createTable("machine_signals")
          .addColumn("group_id", "text", (column) =>
            column.notNull().references("machine_groups.id").onDelete("cascade"),
          )
          .addColumn("kind", "text", (column) => column.notNull())
          .addColumn("hash", "text", (column) => column.notNull())
          .addColumn("first_seen_at", "text", (column) => column.notNull())
          .addColumn("last_seen_at", "text", (column) => column.notNull())
          .addPrimaryKeyConstraint("machine_signals_pkey", ["group_id", "kind", "hash"])
          .execute();
        // Every registration looks its hashes up across all groups; without
        // this the trial check degrades into a table scan per install.
        await db.schema
          .createIndex("idx_machine_signals_hash")
          .on("machine_signals")
          .column("hash")
          .execute();
      }

      if (!(await tableExists(db, engine, "machine_installations"))) {
        await db.schema
          .createTable("machine_installations")
          .addColumn("group_id", "text", (column) =>
            column.notNull().references("machine_groups.id").onDelete("cascade"),
          )
          .addColumn("installation_id", "text", (column) => column.notNull())
          .addColumn("first_seen_at", "text", (column) => column.notNull())
          .addPrimaryKeyConstraint("machine_installations_pkey", ["group_id", "installation_id"])
          .execute();
        await db.schema
          .createIndex("idx_machine_installations_installation")
          .on("machine_installations")
          .column("installation_id")
          .execute();
      }
    },
  },
  {
    name: "005_entitlements_imports",
    up: async (db) => {
      // `allowance` was the one entitlement the server ever named, back when it
      // was a scalar column. It is now `imports`, which says what it counts, and
      // the v1/v2 tokens' scalar `allowance` field is minted from it. Rows
      // written before this carry the old key, so they are rewritten once here
      // rather than special-cased forever at every read.
      //
      // Read-modify-write in JS rather than SQL JSON functions: SQLite's
      // json_set and Postgres' jsonb operators disagree on almost everything,
      // and 002 already established that a portable pass beats a clever one.
      const rows = await db.selectFrom("licenses").select(["id", "entitlements"]).execute();
      for (const row of rows) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.entitlements) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object") continue;
        if (!("allowance" in parsed) || "imports" in parsed) continue;
        const { allowance, ...rest } = parsed;
        await db
          .updateTable("licenses")
          .set({ entitlements: JSON.stringify({ ...rest, imports: allowance }) })
          .where("id", "=", row.id)
          .execute();
      }
    },
  },
  {
    name: "006_support_requests",
    up: async (db, engine) => {
      if (!(await tableExists(db, engine, "support_requests"))) {
        await db.schema
          .createTable("support_requests")
          .addColumn("id", "text", (column) => column.primaryKey())
          .addColumn("client_request_id", "text", (column) => column.notNull())
          .addColumn("license_id", "text", (column) => column.notNull())
          .addColumn("installation_id", "text", (column) => column.notNull())
          .addColumn("category", "text", (column) => column.notNull())
          .addColumn("urgency", "text", (column) => column.notNull())
          .addColumn("subject", "text", (column) => column.notNull())
          .addColumn("message", "text", (column) => column.notNull())
          .addColumn("reporter_name", "text")
          .addColumn("app_version", "text")
          .addColumn("platform", "text")
          .addColumn("status", "text", (column) => column.notNull().defaultTo("queued"))
          .addColumn("client_created_at", "text", (column) => column.notNull())
          .addColumn("received_at", "text", (column) => column.notNull())
          .addColumn("updated_at", "text", (column) => column.notNull())
          .addUniqueConstraint("support_requests_client_key", [
            "license_id",
            "installation_id",
            "client_request_id",
          ])
          .addCheckConstraint(
            "support_requests_category_check",
            sql`category IN ('technical', 'licensing', 'billing', 'feature_request', 'other')`,
          )
          .addCheckConstraint(
            "support_requests_urgency_check",
            sql`urgency IN ('low', 'normal', 'high', 'critical')`,
          )
          .addCheckConstraint("support_requests_status_check", sql`status IN ('queued')`)
          .execute();
      }
      if (!(await tableExists(db, engine, "support_rate_limit_buckets"))) {
        await db.schema
          .createTable("support_rate_limit_buckets")
          .addColumn("license_id", "text", (column) => column.notNull())
          .addColumn("installation_id", "text", (column) => column.notNull())
          .addColumn("window_start", "text", (column) => column.notNull())
          .addColumn("request_count", "integer", (column) => column.notNull())
          .addPrimaryKeyConstraint("support_rate_limit_buckets_pkey", [
            "license_id",
            "installation_id",
            "window_start",
          ])
          .execute();
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
