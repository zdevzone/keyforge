import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

import { createPostgresPool, isPostgresUrl, resolvePostgresOptions } from "../src/database.js";
import { LicenseDatabase } from "../src/db.js";
import { migrateToLatest } from "../src/migrations.js";

/**
 * How this service talks to a remote Postgres. None of this needs a database:
 * the decisions worth pinning down are made before a socket is opened.
 */

const NEON = "postgres://user:pw@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb";

test("TLS is decided here, not inferred from the driver's version", () => {
  // What every managed provider hands you. Verified, and pinned so a pg major
  // bump cannot quietly turn it into encrypted-but-unverified.
  assert.deepEqual(resolvePostgresOptions(`${NEON}?sslmode=require`).ssl, {
    rejectUnauthorized: true,
  });
  assert.deepEqual(resolvePostgresOptions(`${NEON}?sslmode=verify-full`).ssl, {
    rejectUnauthorized: true,
  });
  // Neon's console appends this; it must not change the decision.
  assert.deepEqual(resolvePostgresOptions(`${NEON}?sslmode=require&channel_binding=require`).ssl, {
    rejectUnauthorized: true,
  });
  // A remote host with nothing specified still gets verified TLS rather than
  // a plaintext attempt that fails looking like bad credentials.
  assert.deepEqual(resolvePostgresOptions(NEON).ssl, { rejectUnauthorized: true });

  // Opting out is allowed, but it has to be written down.
  assert.deepEqual(resolvePostgresOptions(`${NEON}?sslmode=no-verify`).ssl, {
    rejectUnauthorized: false,
  });
  assert.deepEqual(resolvePostgresOptions(`${NEON}?sslmode=prefer`).ssl, {
    rejectUnauthorized: false,
  });
  assert.equal(resolvePostgresOptions(`${NEON}?sslmode=disable`).ssl, false);

  // Plain local Postgres keeps working exactly as before.
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(resolvePostgresOptions(`postgres://kf:kf@${host}:5432/kf`).ssl, false);
  }
  assert.deepEqual(
    resolvePostgresOptions("postgres://kf:kf@localhost:5432/kf?sslmode=require").ssl,
    {
      rejectUnauthorized: true,
    },
  );
});

/**
 * pg builds its config as `Object.assign({}, config, parse(connectionString))`,
 * so anything left in the URL *overrides* the ssl object passed beside it.
 * Leaving `sslmode` in place would have made the whole policy above inert
 * against exactly the providers it exists for — every managed Postgres hands
 * you a URL with `sslmode` in it.
 */
test("TLS parameters are stripped from the URL, so the decision survives pg", () => {
  const options = resolvePostgresOptions(`${NEON}?sslmode=require&channel_binding=require`);
  assert.doesNotMatch(options.connectionString, /sslmode/);
  assert.doesNotMatch(options.connectionString, /channel_binding/);

  // What pg actually ends up believing, which is the only thing that matters.
  // connectionParameters is internal to pg, hence the cast; it is also the
  // only place the effective decision is visible without opening a socket.
  const effectiveSsl = (client: pg.Client) =>
    (client as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;

  const client = new pg.Client({ connectionString: options.connectionString, ssl: options.ssl });
  assert.deepEqual(effectiveSsl(client), { rejectUnauthorized: true });

  // And the opposite decision survives just as well.
  const off = resolvePostgresOptions(`${NEON}?sslmode=disable`);
  const offClient = new pg.Client({ connectionString: off.connectionString, ssl: off.ssl });
  assert.equal(effectiveSsl(offClient), false);

  // Everything else about the URL is left alone.
  const withOptions = resolvePostgresOptions(`${NEON}?sslmode=require&application_name=keyforge`);
  assert.match(withOptions.connectionString, /application_name=keyforge/);
});

test("no deprecation warning is emitted for a managed provider's URL", () => {
  const warnings: string[] = [];
  const original = process.emitWarning;
  // pg warns once per process, so this only proves anything on a fresh path;
  // the assertion that matters is that our own construction adds none.
  process.emitWarning = ((warning: string | Error) => {
    warnings.push(String(warning));
  }) as typeof process.emitWarning;
  try {
    const options = resolvePostgresOptions(`${NEON}?sslmode=require&channel_binding=require`);
    new pg.Client({ connectionString: options.connectionString, ssl: options.ssl });
  } finally {
    process.emitWarning = original;
  }
  assert.deepEqual(
    warnings.filter((warning) => /SSL modes/.test(warning)),
    [],
  );
});

test("certificate material named in the URL is still honoured", (t) => {
  const path = join(tmpdir(), `keyforge-ca-${randomUUID()}.pem`);
  writeFileSync(path, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");
  t.after(() => rmSync(path, { force: true }));

  const options = resolvePostgresOptions(`${NEON}?sslmode=verify-full&sslrootcert=${path}`);
  assert.doesNotMatch(options.connectionString, /sslrootcert/);
  assert.deepEqual(options.ssl, {
    rejectUnauthorized: true,
    ca: "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
  });
});

test("pool size is bounded, and configurable when a budget says otherwise", () => {
  // Two pools share one process, so the default is deliberately not pg's 10.
  assert.equal(resolvePostgresOptions(NEON, {}).max, 5);
  assert.equal(resolvePostgresOptions(NEON, { LICENSE_DB_POOL_MAX: "2" }).max, 2);
  for (const bad of ["", "lots", "0", "-3", "2.5"]) {
    assert.equal(resolvePostgresOptions(NEON, { LICENSE_DB_POOL_MAX: bad }).max, 5, bad);
  }
  const options = resolvePostgresOptions(NEON);
  assert.ok(options.idleTimeoutMillis > 0, "idle clients should be released");
  assert.ok(options.connectionTimeoutMillis > 0, "a suspended compute must not hang forever");
});

test("a malformed URL still produces a usable config rather than throwing", () => {
  // pg will reject it with its own error; this helper must not be the one to
  // blow up, or the failure arrives without context.
  assert.doesNotThrow(() => resolvePostgresOptions("postgres://"));
});

/**
 * The failure this milestone exists for. `pg.Pool` is an EventEmitter, and an
 * EventEmitter with no `error` listener *throws* when one is emitted — so a
 * dropped idle client took the whole service down. Managed databases close
 * idle connections routinely (a serverless compute suspends after minutes of
 * quiet), which made this a scheduled crash rather than an edge case.
 */
test("a dropped idle client is survived, not fatal", () => {
  const pool = createPostgresPool(NEON);
  try {
    assert.ok(pool.listenerCount("error") > 0, "the pool must have an error listener");
    assert.doesNotThrow(() => {
      pool.emit("error", new Error("terminating connection due to administrator command"));
    });
  } finally {
    void pool.end().catch(() => {});
  }
});

test("no DATABASE_URL means SQLite, which is still the default", async (t) => {
  assert.equal(isPostgresUrl(undefined), false);
  assert.equal(isPostgresUrl(""), false);
  assert.equal(isPostgresUrl("./licenses.sqlite"), false);
  assert.equal(isPostgresUrl("postgres://host/db"), true);
  assert.equal(isPostgresUrl("postgresql://host/db"), true);

  const database = await LicenseDatabase.open({ url: undefined, sqlitePath: ":memory:" });
  t.after(() => database.close());
  assert.equal(database.engine, "sqlite");
});

/**
 * The lock exists because a managed database usually has more than one
 * instance in front of it: two booting together would both see a migration as
 * unapplied and both run it. Postgres-only, and skipped without a database —
 * the race cannot be reproduced against SQLite, which is single-writer anyway.
 */
test("concurrent boots migrate a Postgres database exactly once", async (t) => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    t.skip("set TEST_DATABASE_URL to exercise the migration lock");
    return;
  }

  // A schema of its own, so a half-migrated state cannot disturb other tests.
  const schema = `kf_lock_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool: createPostgresPool(url) }),
  });
  t.after(async () => {
    await sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).execute(admin);
    await admin.destroy();
  });
  await sql.raw(`CREATE SCHEMA ${schema}`).execute(admin);

  const connect = () =>
    new Kysely<never>({
      dialect: new PostgresDialect({
        pool: createPostgresPool(
          `${url}${url.includes("?") ? "&" : "?"}options=-c%20search_path%3D${schema}`,
        ),
      }),
    });

  const [first, second] = [connect(), connect()];
  t.after(async () => {
    await first.destroy();
    await second.destroy();
  });

  // Both racing from empty. Neither may fail, and between them each migration
  // must be recorded once — a double-apply shows up as a duplicate-key error
  // or a duplicated schema_migrations row.
  const results = await Promise.all([
    migrateToLatest(first as never, "postgres"),
    migrateToLatest(second as never, "postgres"),
  ]);
  const applied = results.flat();
  assert.ok(applied.length > 0, "one of the two should have applied the migrations");
  assert.equal(
    new Set(applied).size,
    applied.length,
    `each migration should run once, got ${applied.join(", ")}`,
  );

  const recorded = await sql<{ name: string; count: string }>`
    SELECT name, count(*) AS count FROM schema_migrations GROUP BY name
  `.execute(first as never);
  assert.ok(recorded.rows.length > 0);
  for (const row of recorded.rows) {
    assert.equal(Number(row.count), 1, `${row.name} recorded more than once`);
  }
});
