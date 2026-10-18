import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { Kysely, PostgresDialect, sql } from "kysely";

import { buildLicenseApp } from "../src/app.js";
import { configSchema } from "../src/config.js";
import { connectDatabase, createPostgresPool } from "../src/database.js";
import { LicenseDatabase } from "../src/db.js";
import {
  LEDGER_TABLES,
  copyLedger,
  describeTarget,
  resolveTarget,
  targetIdentity,
  verifyLedger,
} from "../src/replica.js";
import { generateSigningKeyPair } from "../src/sign.js";

/**
 * Moving a ledger to a second database and back.
 *
 * The fixtures are written through the **real API** rather than inserted by
 * hand, so what gets copied is what the service actually stores — including
 * the audit trail, which is the table with the id sequence behind it.
 *
 * Every assertion about "did it arrive" reads the destination with its own
 * SELECT and its own normalization, not with the copy's helpers: a comparison
 * that shares code with the thing it is checking proves less than it looks.
 */

const ADMIN = "test-admin-token";
const { privateKey } = generateSigningKeyPair();
const auth = { authorization: `Bearer ${ADMIN}` };

const LEDGER = ["platform_records", "platform_lock", "audit_log"] as const;

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "keyforge-replica-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A ledger with something in every table, produced the way a vendor would. */
async function seed(sqlitePath: string): Promise<void> {
  const database = await LicenseDatabase.open({ sqlitePath });
  const app = await buildLicenseApp({
    database,
    privateKey,
    adminToken: ADMIN,
    keyring: { active: "test", keys: { test: "ab".repeat(32) } },
    config: configSchema.parse({ limits: { enabled: false } }),
  });
  try {
    const saved = (await app.inject({ url: "/admin/products/default/catalog", headers: auth }))
      .json()
      .plans.find((p: any) => p.id === "standard");
    await app.inject({
      method: "PUT",
      url: "/admin/products/default/plans/standard",
      headers: auth,
      payload: { ...saved, price: 12000, activationLimit: 2 },
    });
    const response = await app.inject({
      method: "POST",
      url: "/admin/products/default/licenses",
      headers: auth,
      payload: {
        requestId: randomUUID(),
        issuedTo: "Ada Lovelace",
        plan: "standard",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    await database.appendAudit({
      actor: "fixture",
      action: "license.issue",
      licenseId: response.json().license.id,
    });
  } finally {
    await app.close();
    await database.close();
  }
}
/**
 * Every ledger row, engine-neutral. Values are stringified because Postgres
 * hands back `bigint` columns as strings and SQLite as numbers; rows are
 * ordered by their own content so two dumps are comparable.
 */
async function dump(spec: string): Promise<Record<string, unknown[]>> {
  const handle = connectDatabase(resolveTarget(spec));
  try {
    const out: Record<string, unknown[]> = {};
    for (const table of LEDGER) {
      const result = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(table)}`.execute(
        handle.db,
      );
      out[table] = result.rows
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([column, value]) => [
              column,
              value === null ? null : String(value),
            ]),
          ),
        )
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    }
    return out;
  } finally {
    await handle.close();
  }
}

/**
 * A Postgres target of its own, when a database is configured. A scratch
 * schema rather than the shared one: these tests delete whole tables, and the
 * rest of the suite runs against the same database.
 */
async function postgresTarget(t: TestContext): Promise<string | null> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  const schema = `kf_copy_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool: createPostgresPool(url) }),
  });
  await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);
  t.after(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin.destroy();
  });
  return `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`;
}

/** Source -> second database -> back, with the contents intact at each hop. */
async function roundTrip(t: TestContext, second: string): Promise<void> {
  const dir = tempDir(t);
  const origin = join(dir, "licenses.sqlite");
  await seed(origin);
  const expected = await dump(origin);
  for (const table of LEDGER) {
    assert.ok(expected[table].length > 0, `fixture should populate ${table}`);
  }

  await copyLedger({ from: resolveTarget(origin), to: resolveTarget(second) });
  assert.deepEqual(await dump(second), expected, "the copy should hold every row");
  assert.equal(
    (await verifyLedger({ from: resolveTarget(origin), to: resolveTarget(second) })).match,
    true,
  );

  const restored = join(dir, "restored.sqlite");
  await copyLedger({ from: resolveTarget(second), to: resolveTarget(restored) });
  assert.deepEqual(await dump(restored), expected, "and survive the trip back");
  assert.equal(
    (await verifyLedger({ from: resolveTarget(second), to: resolveTarget(restored) })).match,
    true,
  );
}

test("a ledger round-trips through a second SQLite database", async (t) => {
  await roundTrip(t, join(tempDir(t), "standby.sqlite"));
});

test("a ledger round-trips through Postgres, across engines", async (t) => {
  const second = await postgresTarget(t);
  if (!second) {
    t.skip("set TEST_DATABASE_URL to exercise the cross-engine copy");
    return;
  }
  await roundTrip(t, second);
});

/**
 * The bug that would otherwise surface in production, on the first admin
 * action after a promotion: `audit_log.id` is a `bigserial`, and copying rows
 * with their ids does not move the sequence behind them — so the next insert
 * collides with a copied id.
 */
test("the audit sequence is resynced, so the next write does not collide", async (t) => {
  const dir = tempDir(t);
  const origin = join(dir, "licenses.sqlite");
  await seed(origin);

  const targets = [join(dir, "standby.sqlite")];
  const postgres = await postgresTarget(t);
  if (postgres) targets.push(postgres);

  for (const spec of targets) {
    await copyLedger({ from: resolveTarget(origin), to: resolveTarget(spec) });

    const target = resolveTarget(spec);
    const database = await LicenseDatabase.open(target);
    try {
      const highest = Math.max(
        ...(await database.listAudit({ limit: 500 })).map((entry) => entry.id),
      );
      // The write the promoted service would make first.
      await database.appendAudit({ actor: "cli", action: "promoted", detail: {} });
      const latest = (await database.listAudit({ limit: 1 }))[0];
      assert.ok(
        latest.id > highest,
        `${spec}: new audit id ${latest.id} should be above the copied maximum ${highest}`,
      );
      assert.equal(latest.action, "promoted");
    } finally {
      await database.close();
    }
  }
});

test("a destination that already holds data is not overwritten by accident", async (t) => {
  const dir = tempDir(t);
  const origin = join(dir, "licenses.sqlite");
  const standby = join(dir, "standby.sqlite");
  await seed(origin);
  await copyLedger({ from: resolveTarget(origin), to: resolveTarget(standby) });

  // A different ledger, so a silent overwrite would lose real rows.
  const other = join(dir, "other.sqlite");
  await seed(other);

  await assert.rejects(
    () => copyLedger({ from: resolveTarget(other), to: resolveTarget(standby) }),
    /--replace/,
    "a populated destination needs an explicit --replace",
  );
  // And it is genuinely untouched.
  assert.deepEqual(await dump(standby), await dump(origin));

  // With --replace it becomes the source exactly: no leftovers, no orphans.
  await copyLedger({ from: resolveTarget(other), to: resolveTarget(standby), replace: true });
  assert.deepEqual(await dump(standby), await dump(other));
});

/**
 * Without this guard a mistyped `mirror --to` empties the ledger it was meant
 * to protect: the mirror implies --replace, so the delete would run first.
 */
test("copying a database onto itself is refused", async (t) => {
  const dir = tempDir(t);
  const origin = join(dir, "licenses.sqlite");
  await seed(origin);
  const before = await dump(origin);

  await assert.rejects(
    () =>
      copyLedger({
        from: resolveTarget(origin),
        to: resolveTarget(join(dir, "./licenses.sqlite")),
        replace: true,
      }),
    /same database/,
  );
  assert.deepEqual(await dump(origin), before);

  // Relative and absolute spellings of one file are one target; a Postgres URL
  // is identified by where it points, not by how the credentials are written.
  assert.equal(
    targetIdentity(resolveTarget("./a/../licenses.sqlite")),
    targetIdentity(resolveTarget("licenses.sqlite")),
  );
  assert.equal(
    targetIdentity(resolveTarget("postgres://a:1@Host:5432/kf")),
    targetIdentity(resolveTarget("postgres://b:2@host/kf")),
  );
  assert.notEqual(
    targetIdentity(resolveTarget("postgres://a@host/kf")),
    targetIdentity(resolveTarget("postgres://a@host/kf?options=-c%20search_path%3Dstandby")),
  );
});

test("verify names what differs instead of just failing", async (t) => {
  const dir = tempDir(t);
  const origin = join(dir, "licenses.sqlite");
  const standby = join(dir, "standby.sqlite");
  await seed(origin);
  await copyLedger({ from: resolveTarget(origin), to: resolveTarget(standby) });
  assert.equal(
    (await verifyLedger({ from: resolveTarget(origin), to: resolveTarget(standby) })).match,
    true,
  );

  // One edited row — the case a row count alone would call identical.
  const handle = connectDatabase(resolveTarget(standby));
  await sql`UPDATE platform_records SET data = replace(data, 'Ada Lovelace', 'Someone Else') WHERE kind = 'license'`.execute(
    handle.db,
  );
  await handle.close();

  const result = await verifyLedger({ from: resolveTarget(origin), to: resolveTarget(standby) });
  assert.equal(result.match, false);
  const licenses = result.tables.find((verdict) => verdict.table === "platform_records");
  assert.equal(licenses?.match, false);
  assert.equal(licenses?.from, licenses?.to, "counts match; only the contents differ");
  assert.match(String(licenses?.difference), /data/);
  // The other tables are untouched and must not be reported as suspect.
  assert.equal(result.tables.find((verdict) => verdict.table === "audit_log")?.match, true);

  // A missing row is located too.
  const second = connectDatabase(resolveTarget(standby));
  await sql`DELETE FROM platform_records WHERE kind = 'license'`.execute(second.db);
  await second.close();
  const after = await verifyLedger({ from: resolveTarget(origin), to: resolveTarget(standby) });
  assert.match(
    String(after.tables.find((verdict) => verdict.table === "platform_records")?.difference),
    /missing from the destination/,
  );
});

/** Output lands in cron mail and CI logs; the password must not travel with it. */
/**
 * The failure this guards against is silent in both directions: a table missing
 * from LEDGER_TABLES is not copied, and `verify` — which iterates the same
 * list — then calls the incomplete mirror a match. Nothing reports an error;
 * the data is simply gone, and a promoted standby hands every customer whose
 * trial lived in that table a fresh one.
 */
test("every table in the ledger is one the replica knows how to carry", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "licenses.sqlite");
  const database = await LicenseDatabase.open({ sqlitePath: path });
  const tables = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `.execute(database.db);
  await database.close();

  const actual = tables.rows
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && name !== "schema_migrations")
    .sort();
  const carried = LEDGER_TABLES.map((table) => table.name).sort();
  assert.deepEqual(actual, carried, "add the new table to LEDGER_TABLES in src/replica.ts");
});

/**
 * Column lists are written by hand, so a column added in a later migration is
 * dropped by the copy without anything failing — the row arrives with that
 * field null and looks like an ordinary row.
 */
test("every column of every ledger table is carried too", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "licenses.sqlite");
  const database = await LicenseDatabase.open({ sqlitePath: path });
  for (const table of LEDGER_TABLES) {
    const info = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info(${table.name})
    `.execute(database.db);
    assert.deepEqual(
      info.rows.map((row) => row.name).sort(),
      [...table.columns].sort(),
      `${table.name}: column list in src/replica.ts is out of date`,
    );
  }
  await database.close();
});

test("a Postgres target is described without its password", () => {
  const target = resolveTarget(
    "postgres://ledger_owner:not-a-real-password@db.example.invalid/ledger?sslmode=require",
  );
  const described = describeTarget(target);
  assert.doesNotMatch(described, /not-a-real-password/);
  assert.match(described, /ledger_owner@db\.example\.invalid\/ledger/);
  assert.equal(describeTarget(resolveTarget("./licenses.sqlite")), "./licenses.sqlite");
});
