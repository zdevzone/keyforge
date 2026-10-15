import { access, mkdir, readdir, realpath, lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import SQLite from "better-sqlite3";
import { sql } from "kysely";

import {
  AUTH_PREFIX,
  BOOTSTRAP_ADMIN_TABLE,
  createAuth,
  closeAuth,
  ensureAuthSchema,
  seedOperator,
} from "./auth.js";
import { createPostgresPool } from "./database.js";
import { LicenseDatabase } from "./db.js";
import { DomainError, type Records } from "./platform-store.js";
import { LEDGER_TABLES } from "./replica.js";
import { resolveRuntime } from "./runtime.js";

export const AUTH_TABLES = ["session", "account", "verification", "user"] as const;
export const APP_TABLES = [
  ...LEDGER_TABLES.map((t) => t.name),
  "schema_migrations",
  ...AUTH_TABLES,
  ...AUTH_TABLES.map((name) => AUTH_PREFIX + name),
  BOOTSTRAP_ADMIN_TABLE,
];
const known = new Set(APP_TABLES);
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

export async function seededAdministrator(database: LicenseDatabase, records?: Records) {
  const db = records?.db ?? database.db;
  const users = database.engine === "sqlite" ? AUTH_PREFIX + "user" : "user";
  const accounts = database.engine === "sqlite" ? AUTH_PREFIX + "account" : "account";
  const result = await sql<{
    id: string;
    email: string;
    role: string;
    banned: boolean | number | null;
  }>`
    SELECT u.id, u.email, u.role, u.banned FROM ${sql.table(users)} u
    JOIN ${sql.table(BOOTSTRAP_ADMIN_TABLE)} b ON b.user_id = u.id WHERE b.id = 1
    AND EXISTS (SELECT 1 FROM ${sql.table(accounts)} a WHERE a."userId" = u.id AND a."providerId" = 'credential' AND length(a.password) > 0)
  `.execute(db);
  const admin = result.rows[0];
  return admin?.role === "admin" && !admin.banned ? { id: admin.id, email: admin.email } : null;
}

/** Online counterpart to the offline reset: same owned-table manifest, but no
 * live table drops or connection replacement. The caller owns the transaction. */
export async function lockResetTables(database: LicenseDatabase, records: Records) {
  const tables =
    database.engine === "postgres"
      ? (
          await sql<{
            name: string;
          }>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`.execute(
            records.db,
          )
        ).rows
      : (
          await sql<{
            name: string;
          }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`.execute(
            records.db,
          )
        ).rows;
  if (database.engine === "sqlite" && tables.some((t) => !known.has(t.name)))
    throw new DomainError(
      "reset_unrelated_data",
      "This SQLite database contains unrelated tables. Use offline maintenance to review them.",
      409,
    );
  const owned = tables.map((t) => t.name).filter((name) => known.has(name));
  if (database.engine === "postgres") {
    await sql`LOCK TABLE ${sql.join(owned.map((name) => sql.table(name)))} IN SHARE ROW EXCLUSIVE MODE`.execute(
      records.db,
    );
    const dependencies = await sql`
      SELECT 1 FROM pg_constraint c JOIN pg_class source ON source.oid = c.conrelid
      JOIN pg_namespace sn ON sn.oid = source.relnamespace
      JOIN pg_class target ON target.oid = c.confrelid
      JOIN pg_namespace tn ON tn.oid = target.relnamespace
      WHERE c.contype = 'f' AND tn.nspname = current_schema()
      AND target.relname IN (${sql.join(owned)})
      AND (sn.nspname <> current_schema() OR source.relname NOT IN (${sql.join(owned)})) LIMIT 1
    `.execute(records.db);
    if (dependencies.rows.length)
      throw new DomainError(
        "reset_unrelated_data",
        "Unrelated tables depend on application data. Use offline maintenance to review them.",
        409,
      );
  }
  return owned;
}

export async function clearApplicationRows(
  database: LicenseDatabase,
  records: Records,
  owned: string[],
  adminId: string,
) {
  const prefix = database.engine === "sqlite" ? AUTH_PREFIX : "";
  for (const name of ["session", "account", "verification", "user"]) {
    const table = prefix + name;
    if (!owned.includes(table))
      throw new DomainError(
        "reset_unavailable",
        "Operator tables are unavailable. No data was reset.",
        503,
      );
    if (name === "user")
      await sql`DELETE FROM ${sql.table(table)} WHERE id <> ${adminId}`.execute(records.db);
    else if (name === "verification")
      await sql`DELETE FROM ${sql.table(table)}`.execute(records.db);
    else if (name === "session")
      await sql`DELETE FROM ${sql.table(table)} WHERE "userId" <> ${adminId} OR "impersonatedBy" IS NOT NULL`.execute(
        records.db,
      );
    else
      await sql`DELETE FROM ${sql.table(table)} WHERE "userId" <> ${adminId}`.execute(records.db);
  }
  for (const table of [...LEDGER_TABLES].reverse()) {
    if (table.name === "platform_lock") continue;
    if (table.name === "platform_records")
      await records.db
        .deleteFrom("platform_records")
        .where((eb) =>
          eb.or([eb("scope", "!=", "workspace:default"), eb("kind", "!=", "system-reset")]),
        )
        .execute();
    else if (owned.includes(table.name))
      await sql`DELETE FROM ${sql.table(table.name)}`.execute(records.db);
  }
  // Retired unprefixed SQLite auth tables are owned too, but never the live account.
  if (prefix)
    for (const table of AUTH_TABLES)
      if (owned.includes(table)) await sql`DELETE FROM ${sql.table(table)}`.execute(records.db);
}
export interface MaintenanceOptions {
  env?: NodeJS.ProcessEnv;
  root?: string;
  scope?: "app" | "schema" | "database";
  adminURL?: string;
  confirmation?: string;
}
async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
export async function workspacePath(root: string, file: string) {
  const base = await realpath(resolve(root)),
    target = resolve(base, file);
  let ancestor = target;
  while (!(await exists(ancestor))) {
    const next = dirname(ancestor);
    if (next === ancestor) throw Error("Cannot resolve maintenance path.");
    ancestor = next;
  }
  const actual = resolve(await realpath(ancestor), relative(ancestor, target));
  const rel = relative(base, actual);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))
  )
    throw Error("Maintenance paths must be inside the project and cannot be the project root.");
  if ((await exists(target)) && (await lstat(target)).isSymbolicLink())
    throw Error("Maintenance refuses symbolic-link targets.");
  return actual;
}
function tables(file: string) {
  const db = new SQLite(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
  } finally {
    db.close();
  }
}
export async function inspectMaintenance(options: MaintenanceOptions = {}) {
  const env = options.env ?? process.env,
    root = options.root ?? process.cwd(),
    runtime = resolveRuntime(env),
    scope = options.scope ?? "app";
  if (runtime.url) {
    const pool = createPostgresPool(runtime.url);
    try {
      const schema = (await pool.query<{ schema: string }>("SELECT current_schema() AS schema"))
        .rows[0].schema;
      const relations = await pool.query<{ name: string; kind: string }>(
        "SELECT c.relname AS name,c.relkind AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.relname",
        [schema],
      );
      const routines = await pool.query<{ name: string }>(
        "SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1",
        [schema],
      );
      const url = new URL(runtime.url),
        database = decodeURIComponent(url.pathname.slice(1));
      return {
        engine: "postgres" as const,
        scope,
        target: url.hostname + ":" + (url.port || 5432) + "/" + database,
        schema,
        database,
        tables: relations.rows.filter((r) => ["r", "p", "f"].includes(r.kind)).map((r) => r.name),
        unrelated: relations.rows
          .filter(
            (r) =>
              !known.has(r.name) &&
              !(r.kind === "S" && APP_TABLES.some((t) => r.name.startsWith(t + "_"))),
          )
          .map((r) => r.name)
          .concat(routines.rows.map((r) => "function:" + r.name)),
        files: [] as string[],
      };
    } finally {
      await pool.end();
    }
  }
  if (scope === "schema")
    throw Error("SQLite has no schema namespace. Use --scope app or database.");
  const ledger = await workspacePath(root, runtime.sqlitePath);
  const files = [ledger];
  const names: string[] = [];
  for (const file of files) if (await exists(file)) names.push(...tables(file).map((t) => t.name));
  return {
    engine: "sqlite" as const,
    scope,
    target: ledger,
    schema: undefined,
    database: undefined,
    tables: names,
    unrelated: names.filter((t) => !known.has(t)),
    files,
  };
}
export async function initializeAppDatabase(options: MaintenanceOptions = {}) {
  const env = options.env ?? process.env,
    root = options.root ?? process.cwd(),
    runtime = resolveRuntime(env);
  if (!runtime.url) {
    await mkdir(dirname(resolve(root, runtime.sqlitePath)), { recursive: true });
  }
  const db = await LicenseDatabase.open({
    url: runtime.url,
    sqlitePath: resolve(root, runtime.sqlitePath),
  });
  try {
    if (env.LICENSE_AUTH_SECRET) {
      const auth = createAuth({
        dbPath: resolve(root, runtime.authDbPath),
        url: runtime.url,
        secret: env.LICENSE_AUTH_SECRET,
        baseURL: env.LICENSE_SERVER_URL || env.RENDER_EXTERNAL_URL,
      });
      try {
        await ensureAuthSchema(auth);
      } finally {
        await closeAuth(auth);
      }
      if (env.LICENSE_SEED_ADMIN_EMAIL && env.LICENSE_SEED_ADMIN_PASSWORD)
        await seedOperator({
          dbPath: resolve(root, runtime.authDbPath),
          url: runtime.url,
          secret: env.LICENSE_AUTH_SECRET,
          baseURL: env.LICENSE_SERVER_URL || env.RENDER_EXTERNAL_URL,
          email: env.LICENSE_SEED_ADMIN_EMAIL,
          password: env.LICENSE_SEED_ADMIN_PASSWORD,
        });
    }
  } finally {
    await db.close();
  }
}
export async function resetAppDatabase(options: MaintenanceOptions = {}) {
  const env = options.env ?? process.env,
    runtime = resolveRuntime(env),
    plan = await inspectMaintenance(options);
  if (plan.engine === "sqlite") {
    if (plan.unrelated.length)
      throw Error(
        "Refusing to reset SQLite files containing unrelated tables: " + plan.unrelated.join(", "),
      );
    for (const file of plan.files) {
      if (plan.scope === "database") {
        for (const suffix of ["", "-wal", "-shm", "-journal"])
          await rm(file + suffix, { force: true });
      } else if (await exists(file)) {
        const db = new SQLite(file);
        try {
          db.pragma("foreign_keys=OFF");
          db.exec("BEGIN EXCLUSIVE");
          try {
            const items = db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
              )
              .all() as { name: string }[];
            for (const item of items) db.exec("DROP TABLE " + quote(item.name));
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          db.exec("VACUUM");
          db.pragma("wal_checkpoint(TRUNCATE)");
        } finally {
          db.close();
        }
      }
    }
  } else if (plan.scope === "database") {
    if (options.confirmation !== plan.database)
      throw Error("Database reset requires --confirm " + plan.database + ".");
    if (!options.adminURL)
      throw Error("Database reset requires a separate --admin-url or LICENSE_DATABASE_ADMIN_URL.");
    if (["postgres", "template0", "template1"].includes(plan.database!))
      throw Error("System databases cannot be reset.");
    const target = new URL(runtime.url!),
      admin = new URL(options.adminURL);
    if (
      target.hostname !== admin.hostname ||
      target.port !== admin.port ||
      decodeURIComponent(admin.pathname.slice(1)) === plan.database
    )
      throw Error(
        "The admin connection must reach a different database on the same Postgres server.",
      );
    const pool = createPostgresPool(options.adminURL);
    try {
      const info = (
        await pool.query<{ owner: string; encoding: string; collation: string; ctype: string }>(
          "SELECT pg_get_userbyid(datdba) AS owner,pg_encoding_to_char(encoding) AS encoding,datcollate AS collation,datctype AS ctype FROM pg_database WHERE datname=$1",
          [plan.database],
        )
      ).rows[0];
      if (!info) throw Error("Configured database does not exist.");
      await pool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [plan.database],
      );
      await pool.query("DROP DATABASE " + quote(plan.database!));
      const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
      await pool.query(
        "CREATE DATABASE " +
          quote(plan.database!) +
          " OWNER " +
          quote(info.owner) +
          " TEMPLATE template0 ENCODING " +
          literal(info.encoding) +
          " LC_COLLATE " +
          literal(info.collation) +
          " LC_CTYPE " +
          literal(info.ctype),
      );
    } finally {
      await pool.end();
    }
  } else {
    const pool = createPostgresPool(runtime.url!),
      client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(4919071114)");
      if (plan.scope === "schema") {
        if (plan.unrelated.length)
          throw Error(
            "Schema contains unrelated objects; use an app-only reset: " +
              plan.unrelated.join(", "),
          );
        if (options.confirmation !== plan.schema)
          throw Error("Schema reset requires --confirm " + plan.schema + ".");
        const outside = (
          await client.query(
            "SELECT 1 FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid JOIN pg_namespace sn ON sn.oid=source.relnamespace JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace tn ON tn.oid=target.relnamespace WHERE tn.nspname=$1 AND sn.nspname<>$1 LIMIT 1",
            [plan.schema],
          )
        ).rows;
        const views = (
          await client.query(
            "SELECT 1 FROM pg_depend d JOIN pg_rewrite rw ON rw.oid=d.objid JOIN pg_class v ON v.oid=rw.ev_class JOIN pg_namespace vn ON vn.oid=v.relnamespace JOIN pg_class target ON target.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=target.relnamespace WHERE d.classid='pg_rewrite'::regclass AND d.refclassid='pg_class'::regclass AND tn.nspname=$1 AND vn.nspname<>$1 LIMIT 1",
            [plan.schema],
          )
        ).rows;
        if (outside.length || views.length)
          throw Error(
            "Other schemas depend on this schema; a schema reset would affect unrelated objects.",
          );
        const owner = (
          await client.query<{ owner: string }>(
            "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1",
            [plan.schema],
          )
        ).rows[0].owner;
        await client.query("DROP SCHEMA " + quote(plan.schema!) + " CASCADE");
        await client.query(
          "CREATE SCHEMA " + quote(plan.schema!) + " AUTHORIZATION " + quote(owner),
        );
      } else {
        const drop = plan.tables.filter((t) => known.has(t));
        if (drop.length)
          await client.query(
            "DROP TABLE " + drop.map((t) => quote(plan.schema!) + "." + quote(t)).join(", "),
          );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
  await initializeAppDatabase(options);
  return plan;
}
export async function cleanupLocalData(options: MaintenanceOptions = {}, apply = false) {
  const env = options.env ?? process.env,
    root = resolve(options.root ?? process.cwd()),
    runtime = resolveRuntime(env);
  const active = new Set(runtime.url ? [] : [await workspacePath(root, runtime.sqlitePath)]);
  const remove: string[] = [],
    retain: string[] = [];
  for (const dir of ["db", "database"]) {
    const directory = await workspacePath(root, dir);
    if (!(await exists(directory))) continue;
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = await workspacePath(root, join(path, entry.name));
        if (entry.isSymbolicLink()) throw Error("Cleanup refuses symbolic links.");
        if (entry.isDirectory()) {
          await walk(file);
          continue;
        }
        if (!/\.(?:sqlite|db)$/.test(entry.name)) continue;
        if (active.has(file)) {
          retain.push(file);
          continue;
        }
        let owned = false;
        try {
          owned = tables(file).every((t) => known.has(t.name));
        } catch {}
        if (!owned) {
          retain.push(file);
          continue;
        }
        for (const suffix of ["", "-wal", "-shm", "-journal"])
          if (await exists(file + suffix)) remove.push(file + suffix);
      }
    };
    await walk(directory);
  }
  const backup = await workspacePath(root, env.LICENSE_BACKUP_DIR || "backups");
  if (await exists(backup))
    for (const entry of await readdir(backup, { withFileTypes: true }))
      if (entry.isFile() && /^[0-9a-f-]{36}\.kfbackup$/i.test(entry.name))
        remove.push(await workspacePath(root, join(backup, entry.name)));
  if (apply) for (const file of remove) await rm(file, { force: true });
  return { remove, retain, applied: apply };
}
