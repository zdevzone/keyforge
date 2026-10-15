import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import SQLite from "better-sqlite3";

import { closeAuth, createAuth, seedOperator } from "../src/auth.js";
import { createPostgresPool } from "../src/database.js";
import { LicenseDatabase } from "../src/db.js";
import {
  inspectMaintenance,
  resetAppDatabase,
  cleanupLocalData,
  workspacePath,
} from "../src/maintenance.js";
import { generateSigningKeyPair } from "../src/sign.js";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "kf-maintenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    DATABASE_URL: "",
    LICENSE_DB_PATH: join(root, "db/ledger.sqlite"),
    LICENSE_AUTH_SECRET: randomBytes(32).toString("hex"),
    LICENSE_SERVER_URL: "http://localhost:4100",
    LICENSE_SEED_ADMIN_EMAIL: "owner@example.test",
    LICENSE_SEED_ADMIN_PASSWORD: "Owner-password-2026!",
  };
  await mkdir(join(root, "db"));
  return { root, env };
}
test("SQLite reset removes old ledger/operators, recreates schemas and preserves external secrets", async (t) => {
  const h = await fixture(t),
    db = await LicenseDatabase.open({ sqlitePath: h.env.LICENSE_DB_PATH });
  await db.createLicense({
    plan: "old",
    entitlements: {},
    issuedTo: "Old customer",
    activationLimit: 1,
  });
  await db.close();
  await seedOperator({
    dbPath: h.env.LICENSE_DB_PATH,
    secret: h.env.LICENSE_AUTH_SECRET,
    baseURL: h.env.LICENSE_SERVER_URL,
    email: "old@example.test",
    password: "Old-password-2026!",
  });
  const secret = join(h.root, "signing.key");
  await writeFile(secret, "preserve this file");
  const before = await inspectMaintenance(h);
  assert.equal(before.unrelated.length, 0);
  await resetAppDatabase(h);
  const fresh = await LicenseDatabase.open({ sqlitePath: h.env.LICENSE_DB_PATH });
  assert.equal((await fresh.db.selectFrom("licenses").selectAll().execute()).length, 0);
  await fresh.close();
  const auth = createAuth({
    dbPath: h.env.LICENSE_DB_PATH,
    secret: h.env.LICENSE_AUTH_SECRET,
    baseURL: h.env.LICENSE_SERVER_URL,
  });
  try {
    const context = await auth.$context;
    assert.equal(
      await context.adapter.findOne({
        model: "user",
        where: [{ field: "email", value: "old@example.test" }],
      }),
      null,
    );
    assert.equal(
      (
        await auth.api.signInEmail({
          body: {
            email: h.env.LICENSE_SEED_ADMIN_EMAIL,
            password: h.env.LICENSE_SEED_ADMIN_PASSWORD,
          },
        })
      ).user.email,
      h.env.LICENSE_SEED_ADMIN_EMAIL,
    );
  } finally {
    await closeAuth(auth);
  }
  assert.equal(await readFile(secret, "utf8"), "preserve this file");
  await resetAppDatabase({ ...h, scope: "database" });
  assert.equal((await inspectMaintenance(h)).unrelated.length, 0);
});
test("SQLite reset refuses unrelated data and maintenance paths cannot escape the workspace", async (t) => {
  const h = await fixture(t),
    db = new SQLite(h.env.LICENSE_DB_PATH);
  db.exec("CREATE TABLE customer_data (value TEXT); INSERT INTO customer_data VALUES ('keep')");
  db.close();
  await assert.rejects(resetAppDatabase(h), /unrelated/);
  const check = new SQLite(h.env.LICENSE_DB_PATH);
  assert.equal((check.prepare("SELECT value FROM customer_data").get() as any).value, "keep");
  check.close();
  await assert.rejects(workspacePath(h.root, ".."), /inside/);
  await assert.rejects(workspacePath(h.root, h.root), /project root/);
});
test("local cleanup preserves an aliased active database and removes only obsolete app data", async (t) => {
  const h = await fixture(t);
  await resetAppDatabase(h);
  const obsolete = join(h.root, "db/old.sqlite"),
    unrelated = join(h.root, "db/other.sqlite");
  const old = new SQLite(obsolete);
  old.exec("CREATE TABLE licenses (id TEXT)");
  old.close();
  const other = new SQLite(unrelated);
  other.exec("CREATE TABLE other_application (id TEXT)");
  other.close();
  await mkdir(join(h.root, "backups"));
  const archive = join(h.root, "backups", randomUUID() + ".kfbackup"),
    key = join(h.root, "backups", "recovery.key");
  await writeFile(archive, "encrypted");
  await writeFile(key, "keep");
  const alias = join(h.root, "database-alias");
  await symlink(join(h.root, "db"), alias, process.platform === "win32" ? "junction" : "dir");
  const options = {
    ...h,
    env: { ...h.env, LICENSE_DB_PATH: join(alias, "ledger.sqlite") },
  };
  const plan = await cleanupLocalData(options);
  assert.ok(plan.remove.includes(await realpath(obsolete)));
  assert.ok(plan.remove.includes(await realpath(archive)));
  assert.ok(plan.retain.includes(await realpath(h.env.LICENSE_DB_PATH)));
  assert.ok(!plan.remove.includes(await realpath(h.env.LICENSE_DB_PATH)));
  await access(obsolete);
  await cleanupLocalData(options, true);
  await assert.rejects(access(obsolete));
  await assert.rejects(access(archive));
  await access(unrelated);
  await access(key);
  await access(h.env.LICENSE_DB_PATH);
});
test("demo seed creates usable fixtures and repeating it returns the same dataset", async (t) => {
  const h = await fixture(t),
    pair = generateSigningKeyPair(),
    ring = { active: "test", keys: { test: randomBytes(32).toString("hex") } };
  const env = {
    ...h.env,
    LICENSE_SIGNING_KEY: pair.privateKey,
    LICENSE_DATA_KEYRING: JSON.stringify(ring),
  };
  const { seedDemo } = await import(
    pathToFileURL(join(process.cwd(), "scripts/demo-seed.mjs")).href
  );
  const output = join(h.root, "manifest.json"),
    first = await seedDemo(env, output),
    again = await seedDemo(env, output);
  assert.deepEqual(first, again);
  assert.equal(first.licenses.length, 6);
  assert.equal(first.installations.length, 4);
  assert.equal(first.support.length, 3);
  const auth = createAuth({
    dbPath: env.LICENSE_DB_PATH,
    secret: env.LICENSE_AUTH_SECRET,
    baseURL: env.LICENSE_SERVER_URL,
  });
  try {
    for (const role of ["admin", "support"]) {
      const operator = first.operators[role];
      const response = await auth.api.signInEmail({ body: operator });
      assert.equal(response.user.role, role);
    }
  } finally {
    await closeAuth(auth);
  }
  const db = await LicenseDatabase.open({ sqlitePath: env.LICENSE_DB_PATH });
  try {
    const rows = await db.db
      .selectFrom("platform_records")
      .selectAll()
      .where("kind", "=", "demo-seed")
      .execute();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.includes(first.operators.admin.password), false);
  } finally {
    await db.close();
  }
});
test("Postgres app and schema resets preserve unrelated objects and recreate the application", async (t) => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return t.skip("set TEST_DATABASE_URL for Postgres maintenance");
  const h = await fixture(t),
    owner = createPostgresPool(base),
    schema = "kf_reset_" + randomUUID().replaceAll("-", "");
  await owner.query('CREATE SCHEMA "' + schema + '"');
  const url = new URL(base);
  url.searchParams.set("options", "-c search_path=" + schema);
  h.env.DATABASE_URL = url.href;
  const pool = createPostgresPool(url.href);
  t.after(async () => {
    await pool.end();
    await owner.query('DROP SCHEMA "' + schema + '" CASCADE');
    await owner.end();
  });
  await resetAppDatabase(h);
  await pool.query("CREATE TABLE unrelated_object (value TEXT)");
  await pool.query("INSERT INTO unrelated_object VALUES ('keep')");
  await resetAppDatabase(h);
  assert.equal((await pool.query("SELECT value FROM unrelated_object")).rows[0].value, "keep");
  await assert.rejects(
    resetAppDatabase({ ...h, scope: "schema", confirmation: schema }),
    /unrelated/,
  );
  await pool.query("DROP TABLE unrelated_object");
  await resetAppDatabase({ ...h, scope: "schema", confirmation: schema });
  assert.equal((await inspectMaintenance(h)).unrelated.length, 0);
  await assert.rejects(
    resetAppDatabase({ ...h, scope: "database", confirmation: "wrong" }),
    /confirm/,
  );
});
test("Postgres database reset drops and recreates only its explicitly confirmed database", async (t) => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return t.skip("set TEST_DATABASE_URL for full Postgres database reset");
  const root = await mkdtemp(join(tmpdir(), "kf-database-reset-")),
    name = "kf_reset_" + randomUUID().replaceAll("-", ""),
    owner = createPostgresPool(base);
  await owner.query('CREATE DATABASE "' + name + '"');
  const url = new URL(base);
  url.pathname = "/" + name;
  url.searchParams.delete("options");
  t.after(async () => {
    await owner.query('DROP DATABASE IF EXISTS "' + name + '"');
    await owner.end();
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    root,
    env: { DATABASE_URL: url.href },
    scope: "database" as const,
    adminURL: base,
    confirmation: name,
  };
  await resetAppDatabase({ ...options, scope: "app" });
  const db = await LicenseDatabase.open({ url: url.href });
  await db.createLicense({ plan: "old", entitlements: {}, issuedTo: "Old", activationLimit: 1 });
  await db.close();
  await resetAppDatabase(options);
  const fresh = await LicenseDatabase.open({ url: url.href });
  try {
    assert.equal((await fresh.db.selectFrom("licenses").selectAll().execute()).length, 0);
  } finally {
    await fresh.close();
  }
});
