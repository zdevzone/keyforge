import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { sql, type Kysely } from "kysely";

import {
  connectDatabase,
  isPostgresUrl,
  tableColumns,
  type DatabaseHandle,
  type Engine,
} from "./database.js";
import { migrateToLatest } from "./migrations.js";

/**
 * Copying the ledger between databases: a one-shot move, a scheduled mirror to
 * a standby, and a check that the standby is actually current.
 *
 * This is deliberately a **snapshot copy, not replication**. A mirror lags by
 * however often it runs, and the service never writes to the standby — so
 * promoting one is a decision a human makes, not something that happens on its
 * own. Two writable ledgers with automatic failover would eventually issue one
 * product key twice and count a seat twice, which is worse than a gap.
 *
 * Whole tables, every time. `licenses` has no `updated_at`, so an edit through
 * `PATCH /admin/licenses/:id` changes nothing a timestamp-based sync could
 * notice: an incremental copy would silently miss it. At a license server's row
 * counts a full snapshot is both correct and quick, so correct wins.
 *
 * Only the ledger tables travel. Operator accounts belong to Better Auth,
 * whose schema this code does not own; they come back through the boot-time
 * seeding that already exists (LICENSE_SEED_ADMIN_EMAIL / _PASSWORD).
 */

type Row = Record<string, string | number | null>;

interface LedgerTable {
  name: string;
  columns: string[];
  /** Identifies a row, and orders the table. */
  key: string[];
  /** Columns compared as numbers — see normalizeValue. */
  numeric: string[];
}

/**
 * The tables, in **insert order**: `installations.license_id` and
 * `activations.license_id` both reference `licenses`, so licenses go first and
 * deletes run in reverse. (`audit_log.license_id` is a plain column with no
 * foreign key — the audit trail outlives the licenses it describes.) The three
 * machine tables follow the same rule among themselves: signals and
 * installations both reference a group.
 *
 * **Every ledger table has to be listed here.** A table left out is not copied,
 * not compared, and not reported — `verify` calls a mirror missing it a match.
 * The trial ledger is the one where that is worst: silently dropping it during
 * a move to Postgres hands every customer in the file a fresh trial, and
 * nothing about the migration looks wrong.
 *
 * Columns are listed rather than `SELECT *`: a database that predates
 * migration 003 still carries a legacy `allowance` column, and column order is
 * not guaranteed to match between two engines.
 */
export const LEDGER_TABLES: LedgerTable[] = [
  {
    name: "platform_records",
    columns: ["scope", "kind", "id", "data", "revision"],
    key: ["scope", "kind", "id"],
    numeric: ["revision"],
  },
  { name: "platform_lock", columns: ["id", "value"], key: ["id"], numeric: ["value"] },
  {
    name: "licenses",
    columns: [
      "id",
      "key_hash",
      "plan",
      "entitlements",
      "issued_to",
      "status",
      "activation_limit",
      "issued_at",
      "expires_at",
      "revoked_at",
    ],
    key: ["id"],
    numeric: ["activation_limit"],
  },
  {
    name: "installations",
    columns: [
      "installation_id",
      "registered_at",
      "last_seen_at",
      "app_version",
      "platform",
      "user_name",
      "user_email",
      "license_id",
    ],
    key: ["installation_id"],
    numeric: [],
  },
  {
    name: "activations",
    columns: ["license_id", "installation_id", "activated_at", "deactivated_at"],
    key: ["license_id", "installation_id"],
    numeric: [],
  },
  {
    name: "machine_groups",
    columns: [
      "id",
      "support_reference",
      "first_registered_at",
      "last_registered_at",
      "registration_count",
      "recheck_count",
      "trial_spent_reported",
      "cleared_at",
      "cleared_at_count",
    ],
    key: ["id"],
    // cleared_at_count is nullable, and normalizeValue keeps null as null —
    // listing it here only decides how a present value is compared.
    numeric: ["registration_count", "recheck_count", "trial_spent_reported", "cleared_at_count"],
  },
  {
    name: "machine_signals",
    columns: ["group_id", "kind", "hash", "first_seen_at", "last_seen_at"],
    key: ["group_id", "kind", "hash"],
    numeric: [],
  },
  {
    name: "machine_installations",
    columns: ["group_id", "installation_id", "first_seen_at"],
    key: ["group_id", "installation_id"],
    numeric: [],
  },
  {
    name: "audit_log",
    columns: ["id", "at", "actor", "action", "license_id", "detail"],
    key: ["id"],
    numeric: ["id"],
  },
  {
    name: "support_requests",
    columns: [
      "id",
      "client_request_id",
      "license_id",
      "installation_id",
      "category",
      "urgency",
      "subject",
      "message",
      "reporter_name",
      "app_version",
      "platform",
      "status",
      "client_created_at",
      "received_at",
      "updated_at",
    ],
    key: ["id"],
    numeric: [],
  },
  {
    name: "support_rate_limit_buckets",
    columns: ["license_id", "installation_id", "window_start", "request_count"],
    key: ["license_id", "installation_id", "window_start"],
    numeric: ["request_count"],
  },
];

/** Rows per INSERT. Both engines cap the bind parameters in one statement. */
const CHUNK = 200;

export type Target = { url: string } | { sqlitePath: string };

/** A `postgres://` URL selects Postgres; anything else is a SQLite file path. */
export function resolveTarget(spec: string): Target {
  const trimmed = spec.trim();
  if (!trimmed) throw new Error("A database target cannot be empty.");
  return isPostgresUrl(trimmed) ? { url: trimmed } : { sqlitePath: trimmed };
}

/**
 * A target as it may appear in output. **Never print the target itself**: a
 * Postgres URL carries the password, and this tool's output lands in terminal
 * scrollback, cron mail and CI logs.
 */
export function describeTarget(target: Target): string {
  if ("sqlitePath" in target) return target.sqlitePath;
  try {
    const url = new URL(target.url);
    const user = url.username ? `${url.username}@` : "";
    return `postgres://${user}${url.host}${url.pathname}`;
  } catch {
    return "postgres://(unreadable url)";
  }
}

/**
 * What makes two targets the same database, so a mistyped `--to` cannot be
 * pointed at the ledger it is meant to protect. `options` is part of the
 * identity because a different `search_path` is a different set of tables.
 */
export function targetIdentity(target: Target): string {
  if ("sqlitePath" in target) {
    // ":memory:" is a fresh database per connection, but two of them are never
    // a copy worth making, so treating them as one target is the safe reading.
    return target.sqlitePath === ":memory:"
      ? "sqlite::memory:"
      : `sqlite:${resolvePath(target.sqlitePath)}`;
  }
  try {
    const url = new URL(target.url);
    const port = url.port || "5432";
    const options = url.searchParams.get("options") ?? "";
    return `postgres:${url.hostname.toLowerCase()}:${port}${url.pathname}${options}`;
  } catch {
    return `postgres:${target.url}`;
  }
}

/** Kysely's types are per-schema; here the table set is data, so it is loose. */
type LedgerDb = Kysely<Record<string, Row>>;

function open(target: Target, role: string): DatabaseHandle {
  if ("sqlitePath" in target && target.sqlitePath !== ":memory:") {
    mkdirSync(dirname(resolvePath(target.sqlitePath)), { recursive: true });
  }
  try {
    return connectDatabase(target);
  } catch (error) {
    throw new Error(
      `Could not open the ${role} database ${describeTarget(target)}: ${(error as Error).message}`,
    );
  }
}

/**
 * Refuse a database that is not a current Keyforge ledger, with a sentence
 * rather than a column-not-found error halfway through a copy. The source is
 * never migrated — a copy tool that writes to the database it is reading from
 * is not one you would point at production.
 */
async function assertLedgerSchema(handle: DatabaseHandle, role: string): Promise<void> {
  for (const table of LEDGER_TABLES) {
    const columns = await tableColumns(handle.db, handle.engine, table.name);
    if (columns.size === 0) {
      throw new Error(
        `The ${role} database has no "${table.name}" table — is it a Keyforge ledger?`,
      );
    }
    const missing = table.columns.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new Error(
        `The ${role} database is on an older schema: ${table.name} is missing ` +
          `${missing.join(", ")}. Start the service against it once so migrations run, then retry.`,
      );
    }
  }
}

/**
 * One value, in a form both engines agree on. node-postgres returns `bigint`
 * columns as strings, so `audit_log.id` arrives as "12" from Postgres and 12
 * from SQLite; without this the same ledger would checksum two ways, and the
 * copied id would rely on SQLite's column affinity to become a number again.
 */
function normalizeValue(value: unknown, numeric: boolean): string | number | null {
  if (value === null || value === undefined) return null;
  if (numeric) return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeRow(row: Record<string, unknown>, table: LedgerTable): Row {
  const out: Row = {};
  for (const column of table.columns) {
    out[column] = normalizeValue(row[column], table.numeric.includes(column));
  }
  return out;
}

/**
 * Ordering happens here rather than in SQL on purpose: Postgres orders text by
 * the database's collation and SQLite orders it byte-wise, so `ORDER BY` would
 * make two identical ledgers produce different checksums.
 */
function compareRows(a: Row, b: Row, key: string[]): number {
  for (const column of key) {
    const left = a[column];
    const right = b[column];
    if (left === right) continue;
    if (left === null) return -1;
    if (right === null) return 1;
    if (typeof left === "number" && typeof right === "number") return left - right;
    return String(left) < String(right) ? -1 : 1;
  }
  return 0;
}

async function readTable(handle: DatabaseHandle, table: LedgerTable): Promise<Row[]> {
  const db = handle.db as unknown as LedgerDb;
  const rows = await db
    .selectFrom(table.name)
    .select(table.columns as never)
    .execute();
  return (rows as Record<string, unknown>[])
    .map((row) => normalizeRow(row, table))
    .sort((a, b) => compareRows(a, b, table.key));
}

/** A stable fingerprint of a table's contents, independent of engine. */
function checksum(rows: Row[], table: LedgerTable): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(JSON.stringify(table.columns.map((column) => row[column])));
  return hash.digest("hex").slice(0, 16);
}

async function countRows(handle: DatabaseHandle, table: LedgerTable): Promise<number> {
  const result = await sql<{ count: number | string }>`SELECT count(*) AS count FROM ${sql.table(
    table.name,
  )}`.execute(handle.db);
  return Number(result.rows[0]?.count ?? 0);
}

export interface CopyOptions {
  from: Target;
  to: Target;
  /** Required to write into a destination that already holds rows. */
  replace?: boolean;
}

export interface CopyResult {
  from: Engine;
  to: Engine;
  /** Rows written, per table. */
  copied: Record<string, number>;
  replaced: boolean;
}

/**
 * Copy every ledger table from one database to another, in either direction
 * and across engines. The destination is migrated first, then written in a
 * single transaction: a copy that fails leaves the destination as it was.
 */
export async function copyLedger(options: CopyOptions): Promise<CopyResult> {
  if (targetIdentity(options.from) === targetIdentity(options.to)) {
    throw new Error(
      `Source and destination are the same database (${describeTarget(options.from)}). ` +
        "That would empty it, not copy it.",
    );
  }

  const source = open(options.from, "source");
  try {
    await assertLedgerSchema(source, "source");
    const snapshot = new Map<string, Row[]>();
    for (const table of LEDGER_TABLES) snapshot.set(table.name, await readTable(source, table));

    const destination = open(options.to, "destination");
    try {
      await migrateToLatest(destination.db, destination.engine);
      await assertLedgerSchema(destination, "destination");

      const existing: Record<string, number> = {};
      let populated = false;
      for (const table of LEDGER_TABLES) {
        existing[table.name] = await countRows(destination, table);
        if (table.name !== "platform_lock" && existing[table.name] > 0) populated = true;
      }
      if (populated && !options.replace) {
        const counts = Object.entries(existing)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => `${name} ${count}`)
          .join(", ");
        throw new Error(
          `${describeTarget(options.to)} already holds data (${counts}). ` +
            "Pass --replace to overwrite it.",
        );
      }

      const copied: Record<string, number> = {};
      await (destination.db as unknown as LedgerDb).transaction().execute(async (trx) => {
        if (!populated) await trx.deleteFrom("platform_lock").execute();
        if (populated) {
          // Reverse order: the foreign keys point back towards licenses.
          for (const table of [...LEDGER_TABLES].reverse()) {
            await trx.deleteFrom(table.name).execute();
          }
        }
        for (const table of LEDGER_TABLES) {
          const rows = snapshot.get(table.name) ?? [];
          for (let index = 0; index < rows.length; index += CHUNK) {
            await trx
              .insertInto(table.name)
              .values(rows.slice(index, index + CHUNK) as never)
              .execute();
          }
          copied[table.name] = rows.length;
        }
        if (destination.engine === "postgres") await resyncAuditSequence(trx);
      });

      return {
        from: source.engine,
        to: destination.engine,
        copied,
        replaced: populated,
      };
    } finally {
      await destination.close();
    }
  } finally {
    await source.close();
  }
}

/**
 * Postgres' `audit_log.id` is a `bigserial`, and copying rows with their ids
 * does not move the sequence behind it — so the next audit entry the service
 * writes would collide with a copied id and fail. This is the bug that would
 * otherwise appear in production, on the first admin action after a promotion.
 *
 * SQLite needs no equivalent: `AUTOINCREMENT` advances `sqlite_sequence`
 * whenever a larger rowid is inserted explicitly.
 *
 * (`setval` is not undone by a rollback. Skipping a few ids is harmless; the
 * alternative — a sequence left behind the data — is not.)
 */
async function resyncAuditSequence(trx: LedgerDb): Promise<void> {
  await sql`
    SELECT setval(s.seq, COALESCE((SELECT MAX(id) FROM audit_log), 0) + 1, false)
    FROM (SELECT pg_get_serial_sequence('audit_log', 'id') AS seq) s
    WHERE s.seq IS NOT NULL
  `.execute(trx);
}

export interface TableVerdict {
  table: string;
  from: number;
  to: number;
  match: boolean;
  /** Where the two first disagree, in words. Absent when they match. */
  difference?: string;
}

export interface VerifyResult {
  match: boolean;
  tables: TableVerdict[];
}

/**
 * Compare two ledgers table by table: row counts, then a content checksum, so
 * "the mirror is current" is something an operator checks rather than assumes.
 * Neither database is written to.
 */
export async function verifyLedger(options: { from: Target; to: Target }): Promise<VerifyResult> {
  const source = open(options.from, "source");
  try {
    await assertLedgerSchema(source, "source");
    const destination = open(options.to, "destination");
    try {
      await assertLedgerSchema(destination, "destination");
      const tables: TableVerdict[] = [];
      for (const table of LEDGER_TABLES) {
        const left = await readTable(source, table);
        const right = await readTable(destination, table);
        const match = checksum(left, table) === checksum(right, table);
        tables.push({
          table: table.name,
          from: left.length,
          to: right.length,
          match,
          ...(match ? {} : { difference: firstDifference(left, right, table) }),
        });
      }
      return { match: tables.every((verdict) => verdict.match), tables };
    } finally {
      await destination.close();
    }
  } finally {
    await source.close();
  }
}

/** The first disagreement, named — a mismatch nobody can locate is a shrug. */
function firstDifference(left: Row[], right: Row[], table: LedgerTable): string {
  const describe = (row: Row) => table.key.map((column) => `${column}=${row[column]}`).join(" ");
  let index = 0;
  let other = 0;
  while (index < left.length && other < right.length) {
    const order = compareRows(left[index], right[other], table.key);
    if (order < 0) return `${table.name} ${describe(left[index])} is missing from the destination`;
    if (order > 0) return `${table.name} ${describe(right[other])} is only in the destination`;
    for (const column of table.columns) {
      if (left[index][column] !== right[other][column]) {
        return `${table.name} ${describe(left[index])}: ${column} is ${JSON.stringify(
          left[index][column],
        )} in the source, ${JSON.stringify(right[other][column])} in the destination`;
      }
    }
    index += 1;
    other += 1;
  }
  if (index < left.length) {
    return `${table.name} ${describe(left[index])} is missing from the destination`;
  }
  if (other < right.length) {
    return `${table.name} ${describe(right[other])} is only in the destination`;
  }
  return `${table.name} differs`;
}
