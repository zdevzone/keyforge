import { createHash } from "node:crypto";

import type { PoolClient } from "pg";
import { z } from "zod";

import { BOOTSTRAP_ADMIN_TABLE } from "./auth.js";
import { createPostgresPool } from "./database.js";
import { LEDGER_TABLES } from "./replica.js";

const names = new Set([
  ...LEDGER_TABLES.map((t) => t.name),
  "schema_migrations",
  "user",
  "account",
  "session",
  "verification",
  BOOTSTRAP_ADMIN_TABLE,
]);
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const tableSchema = z
  .object({
    name: z.string().refine((name) => names.has(name)),
    columns: z
      .array(z.object({ name: z.string(), type: z.string(), required: z.boolean() }).strict())
      .nonempty(),
    parents: z.array(z.string()),
    rows: z.array(z.string()),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    tables: z.array(tableSchema).nonempty(),
  })
  .strict();
type Snapshot = z.infer<typeof snapshotSchema>;

// Application data, not arbitrary database objects or executable SQL. Restore
// requires the same application schema, initialized by the matching release.
async function describe(client: PoolClient): Promise<Omit<Snapshot["tables"][number], "rows">[]> {
  const tables = (
    await client.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
    )
  ).rows;
  if (tables.some((t) => !names.has(t.name)))
    throw Error("Portable backups require a dedicated KeyForge database without unrelated tables.");
  const result = [];
  for (const { name } of tables) {
    const columns = (
      await client.query<{ name: string; type: string; required: boolean }>(
        `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS required
       FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [quote(name)],
      )
    ).rows;
    const parents = (
      await client.query<{ name: string }>(
        "SELECT DISTINCT confrelid::regclass::text AS name FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f' ORDER BY name",
        [quote(name)],
      )
    ).rows.map((r) => r.name.replaceAll('"', ""));
    result.push({ name, columns, parents });
  }
  return result;
}
function ordered(tables: Snapshot["tables"]): Snapshot["tables"] {
  const result: Snapshot["tables"] = [];
  const remaining = new Map(tables.map((t) => [t.name, t]));
  if (remaining.size !== tables.length) throw Error("Duplicate snapshot table.");
  while (remaining.size) {
    const next = [...remaining.values()].find((t) =>
      t.parents.every((p) => result.some((r) => r.name === p)),
    );
    if (!next) throw Error("Unsupported snapshot dependencies.");
    result.push(next);
    remaining.delete(next.name);
  }
  return result;
}
export function parsePostgresSnapshot(bytes: Buffer): Snapshot {
  if (bytes.length > 128 * 1024 * 1024) throw Error("Portable snapshot exceeds 128 MiB.");
  const snapshot = snapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
  ordered(snapshot.tables);
  for (const table of snapshot.tables) {
    const keys = table.columns.map((c) => c.name).sort();
    if (new Set(keys).size !== keys.length) throw Error("Duplicate snapshot column.");
    for (const row of table.rows) {
      const value = JSON.parse(row);
      if (
        !value ||
        Array.isArray(value) ||
        JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)
      )
        throw Error("Invalid snapshot row.");
    }
  }
  return snapshot;
}
export async function capturePostgresSnapshot(url: string): Promise<Buffer> {
  const pool = createPostgresPool(url),
    client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL statement_timeout = '90s'");
    const tables: Snapshot["tables"] = [];
    let size = 0;
    for (const table of await describe(client)) {
      // Fetch bounded pages from one consistent server-side cursor. Native
      // row_to_json preserves timestamp precision and big integers losslessly.
      await client.query(
        `DECLARE kf_backup NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS value FROM ${quote(table.name)} t`,
      );
      const rows: string[] = [];
      for (;;) {
        const page = (await client.query<{ value: string }>("FETCH 250 FROM kf_backup")).rows;
        for (const row of page) {
          size += Buffer.byteLength(row.value);
          if (size > 96 * 1024 * 1024)
            throw Error("Use database-native backups for larger databases.");
          rows.push(row.value);
        }
        if (page.length < 250) break;
      }
      await client.query("CLOSE kf_backup");
      tables.push({ ...table, rows });
    }
    const bytes = Buffer.from(JSON.stringify({ version: 1, tables } satisfies Snapshot));
    parsePostgresSnapshot(bytes);
    await client.query("COMMIT");
    return bytes;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function restorePostgresSnapshot(url: string, bytes: Buffer, commit = false) {
  const snapshot = parsePostgresSnapshot(bytes);
  const pool = createPostgresPool(url),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL statement_timeout = '90s'");
    await client.query("SELECT pg_advisory_xact_lock(4919071114)");
    const tables = ordered(snapshot.tables);
    await client.query(
      `LOCK TABLE ${tables.map((t) => quote(t.name)).join(",")} IN ACCESS EXCLUSIVE MODE`,
    );
    const expected = snapshot.tables.map(({ rows: _rows, ...table }) => table);
    if (JSON.stringify(await describe(client)) !== JSON.stringify(expected))
      throw Error(
        "Initialize the target with the exact KeyForge release used to create this archive.",
      );
    const versions = tables.find((t) => t.name === "schema_migrations");
    if (versions) {
      const current = (
        await client.query<{ value: string }>(
          "SELECT row_to_json(t)::text AS value FROM schema_migrations t",
        )
      ).rows.map((r) => r.value);
      // Migration application times vary; names identify compatible releases.
      const migrationNames = (rows: string[]) => rows.map((r) => JSON.parse(r).name).sort();
      if (JSON.stringify(migrationNames(current)) !== JSON.stringify(migrationNames(versions.rows)))
        throw Error("The snapshot and target have different migration versions.");
    }
    for (const table of [...tables].reverse())
      await client.query(`DELETE FROM ${quote(table.name)}`);
    for (const table of tables) {
      for (let i = 0; i < table.rows.length; i += 100) {
        await client.query(
          `INSERT INTO ${quote(table.name)} SELECT * FROM json_populate_recordset(NULL::${quote(table.name)}, $1::json)`,
          ["[" + table.rows.slice(i, i + 100).join(",") + "]"],
        );
      }
      // Verify the restored contents, not just the archive checksums. Sort
      // native JSON text so row order has no bearing on verification.
      const restored = (
        await client.query<{ value: string }>(
          `SELECT row_to_json(t)::text AS value FROM ${quote(table.name)} t`,
        )
      ).rows
        .map((r) => r.value)
        .sort();
      const checksum = (rows: string[]) =>
        createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      if (checksum(restored) !== checksum([...table.rows].sort()))
        throw Error("Restored rows differ from snapshot.");
      for (const col of table.columns) {
        const sequence = (
          await client.query<{ name: string | null }>(
            "SELECT pg_get_serial_sequence($1,$2) AS name",
            [quote(table.name), col.name],
          )
        ).rows[0].name;
        if (!sequence) continue;
        const next = (
          await client.query<{ value: string }>(
            `SELECT (COALESCE(MAX(${quote(col.name)}),0)+1)::text AS value FROM ${quote(table.name)}`,
          )
        ).rows[0].value;
        if (!/^\d+$/.test(next)) throw Error("Invalid sequence value.");
        // ALTER is transactional (setval is not), including during verification.
        await client.query(
          `ALTER SEQUENCE ${sequence
            .split(".")
            .map((s) => quote(s.replaceAll('"', "")))
            .join(".")} RESTART WITH ${next}`,
        );
      }
    }
    await client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
