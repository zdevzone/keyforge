import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import SQLite from "better-sqlite3";
import { sql } from "kysely";

import { buildLicenseApp } from "../src/app.js";
import {
  AUTH_PREFIX,
  BOOTSTRAP_ADMIN_TABLE,
  closeAuth,
  createAuth,
  seedOperator,
} from "../src/auth.js";
import { BackupService } from "../src/backups.js";
import { createPostgresPool } from "../src/database.js";
import { LicenseDatabase } from "../src/db.js";
import { atomic, DomainError, Records, Vault } from "../src/platform-store.js";
import { generateSigningKeyPair } from "../src/sign.js";

const password = "Reset-fixture-password-2026!";
const baseURL = "http://localhost:4100";
async function fixture(t: TestContext, url?: string, verificationUrl?: string) {
  const root = await mkdtemp(join(tmpdir(), "kf-system-reset-"));
  const dbPath = join(root, "database.sqlite");
  const secret = randomBytes(32).toString("hex");
  const options = { dbPath, url, secret, baseURL, password };
  await seedOperator({ ...options, email: "first@example.test" });
  await seedOperator({ ...options, email: "second@example.test" });
  await seedOperator({ ...options, email: "support@example.test" });
  const auth = createAuth(options);
  const context = await auth.$context;
  const support = await context.adapter.findOne<{ id: string }>({
    model: "user",
    where: [{ field: "email", value: "support@example.test" }],
  });
  await context.adapter.update({
    model: "user",
    where: [{ field: "id", value: support!.id }],
    update: { role: "support" },
  });
  const database = await LicenseDatabase.open({ sqlitePath: dbPath, url });
  const ring = { active: "test", keys: { test: randomBytes(32).toString("hex") } };
  const app = await buildLicenseApp({
    database,
    auth,
    authDbPath: dbPath,
    privateKey: generateSigningKeyPair().privateKey,
    keyring: ring,
    backups: { directory: join(root, "backups"), keyring: ring, databaseUrl: url, verificationUrl },
    uiDir: join(root, "no-ui"),
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await closeAuth(auth);
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  async function login(email: string) {
    const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    return {
      cookie: response.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; "),
      host: "localhost:4100",
      origin: baseURL,
    };
  }
  const headers = await login("first@example.test"),
    second = await login("second@example.test"),
    lesser = await login("support@example.test");
  const plan = (await app.inject({ url: "/admin/system/reset", headers })).json();
  assert.equal(plan.preservedAdmin.email, "first@example.test");
  const records = new Records(database.db);
  await atomic(database, async (r) => {
    for (const kind of [
      "sale",
      "financial-entry",
      "ticket",
      "notification",
      "credential",
      "license-request",
    ])
      await r.put("product:default", kind, { id: randomUUID(), fixture: true });
  });
  await database.createLicense({
    plan: "standard",
    entitlements: {},
    issuedTo: "Old customer",
    activationLimit: 1,
  });
  const reset = (backup = false, requestId = randomUUID(), useHeaders = headers) =>
    app.inject({
      method: "POST",
      url: "/admin/system/reset",
      headers: useHeaders,
      payload: { backup, requestId, confirmation: "DELETE ALL" },
    });
  return {
    root,
    app,
    auth,
    database,
    records,
    ring,
    headers,
    second,
    lesser,
    reset,
    options,
    plan,
  };
}

test("online reset preserves the original seeded identity, current password and sessions, and retries cannot delete new data", async (t) => {
  const f = await fixture(t);
  const changedPassword = "Changed-root-password-2026!";
  await sql`UPDATE ${sql.table(AUTH_PREFIX + "session")} SET "userId" = ${f.plan.preservedAdmin.id}, "impersonatedBy" = (SELECT id FROM ${sql.table(AUTH_PREFIX + "user")} WHERE email = 'second@example.test') WHERE "userId" = (SELECT id FROM ${sql.table(AUTH_PREFIX + "user")} WHERE email = 'support@example.test')`.execute(
    f.database.db,
  );
  assert.equal((await f.app.inject({ url: "/admin/config", headers: f.lesser })).statusCode, 200);
  await f.auth.api.changePassword({
    headers: new Headers(f.headers),
    body: { currentPassword: password, newPassword: changedPassword, revokeOtherSessions: false },
  });
  const before = await sql<{
    password: string;
  }>`SELECT password FROM ${sql.table(AUTH_PREFIX + "account")} WHERE "userId" = ${f.plan.preservedAdmin.id}`.execute(
    f.database.db,
  );
  await writeFile(join(f.root, "signing.key"), "external key material stays outside reset");
  const requestId = randomUUID();
  const response = await f.reset(false, requestId, f.second);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().preservedAdmin.id, f.plan.preservedAdmin.id);
  assert.equal(response.json().backupId, null);
  const users = await sql<{
    id: string;
  }>`SELECT id FROM ${sql.table(AUTH_PREFIX + "user")}`.execute(f.database.db);
  assert.deepEqual(
    users.rows.map((u) => u.id),
    [f.plan.preservedAdmin.id],
  );
  const after = await sql<{
    password: string;
  }>`SELECT password FROM ${sql.table(AUTH_PREFIX + "account")} WHERE "userId" = ${f.plan.preservedAdmin.id}`.execute(
    f.database.db,
  );
  assert.ok(before.rows[0].password === after.rows[0].password);
  assert.equal(
    (
      await f.auth.api.signInEmail({
        body: { email: "first@example.test", password: changedPassword },
      })
    ).user.id,
    f.plan.preservedAdmin.id,
  );
  assert.equal((await f.app.inject({ url: "/admin/config", headers: f.headers })).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/admin/config", headers: f.second })).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/admin/config", headers: f.lesser })).statusCode, 401);
  assert.equal((await f.database.db.selectFrom("licenses").selectAll().execute()).length, 0);
  const kinds = await f.database.db
    .selectFrom("platform_records")
    .select("kind")
    .distinct()
    .execute();
  assert.ok(kinds.every((r) => ["product", "plan", "definition", "system-reset"].includes(r.kind)));
  assert.equal(
    await readFile(join(f.root, "signing.key"), "utf8"),
    "external key material stays outside reset",
  );
  await f.database.createLicense({
    plan: "new",
    entitlements: {},
    issuedTo: "New customer",
    activationLimit: 1,
  });
  const replay = await f.reset(false, requestId);
  assert.equal(replay.json().replayed, true);
  assert.equal((await f.database.db.selectFrom("licenses").selectAll().execute()).length, 1);
  await seedOperator({ ...f.options, email: "second@example.test" });
  assert.equal(
    (await f.app.inject({ url: "/admin/system/reset", headers: f.headers })).json().preservedAdmin
      .id,
    f.plan.preservedAdmin.id,
  );
});

test("reset requires an admin, same-origin request, exact confirmation, and a known seeded admin", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.reset(false, randomUUID(), f.lesser)).statusCode, 403);
  assert.equal(
    (await f.reset(false, randomUUID(), { ...f.headers, origin: "https://attacker.example" }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/admin/system/reset",
        headers: f.headers,
        payload: { confirmation: "delete all", backup: false, requestId: randomUUID() },
      })
    ).statusCode,
    400,
  );
  await sql`DELETE FROM ${sql.table(BOOTSTRAP_ADMIN_TABLE)}`.execute(f.database.db);
  assert.equal(
    (await f.app.inject({ url: "/admin/system/reset", headers: f.headers })).json().available,
    false,
  );
  assert.equal((await f.reset()).json().error, "reset_unavailable");
  assert.equal((await f.database.db.selectFrom("licenses").selectAll().execute()).length, 1);
});

test("reset backup is verified before deletion and remains downloadable with the complete original database", async (t) => {
  const f = await fixture(t);
  const response = await f.reset(true);
  assert.equal(response.statusCode, 200, response.body);
  const id = response.json().backupId;
  const jobs = (await f.app.inject({ url: "/admin/backups", headers: f.headers })).json().jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, id);
  assert.ok(jobs[0].verifiedAt);
  const download = await f.app.inject({ url: `/admin/backups/${id}/download`, headers: f.headers });
  assert.equal(download.statusCode, 200, download.body);
  const archive = JSON.parse(
    new Vault(f.ring).decrypt(download.rawPayload.toString(), "backup:" + id),
  );
  const file = join(f.root, "restored.sqlite");
  await writeFile(file, Buffer.from(archive.files[0].data, "base64"));
  const restored = new SQLite(file, { readonly: true });
  try {
    assert.equal(
      (restored.prepare(`SELECT count(*) AS n FROM ${AUTH_PREFIX}user`).get() as any).n,
      3,
    );
    assert.equal((restored.prepare("SELECT count(*) AS n FROM licenses").get() as any).n, 1);
    assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    restored.close();
  }
});

test("backup verification failure and database deletion failure both preserve existing data", async (t) => {
  const f = await fixture(t);
  const mock = t.mock.method(BackupService.prototype, "verify", async () => {
    throw new DomainError("backup_corrupt", "Fixture verification failure.");
  });
  assert.equal((await f.reset(true)).json().error, "backup_corrupt");
  assert.equal((await readdir(join(f.root, "backups"))).length, 0);
  mock.mock.restore();
  await sql`CREATE TRIGGER reject_reset BEFORE DELETE ON licenses BEGIN SELECT RAISE(ABORT, 'fixture reset failure'); END`.execute(
    f.database.db,
  );
  const failed = await f.reset(true);
  assert.equal(failed.statusCode, 500, failed.body);
  assert.equal((await f.database.db.selectFrom("licenses").selectAll().execute()).length, 1);
  assert.equal((await f.app.inject({ url: "/admin/config", headers: f.second })).statusCode, 200);
  assert.equal(
    (await f.app.inject({ url: "/admin/backups", headers: f.headers })).json().jobs.length,
    1,
  );
});

test("maintenance rejects new requests during backup verification and resumes after reset", async (t) => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = BackupService.prototype.verify;
  t.mock.method(
    BackupService.prototype,
    "verify",
    async function (this: BackupService, ...args: Parameters<BackupService["verify"]>) {
      entered();
      await waiting;
      return original.apply(this, args);
    },
  );
  const resetting = f.reset(true).then((r) => r);
  await started;
  try {
    assert.equal(
      (await f.app.inject({ url: "/admin/config", headers: f.headers })).statusCode,
      503,
    );
    assert.equal((await f.app.inject({ url: "/healthz" })).statusCode, 200);
  } finally {
    release();
  }
  assert.equal((await resetting).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/admin/config", headers: f.headers })).statusCode, 200);
});

test("Postgres online reset retains the seeded admin and a restore-verified archive", async (t) => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base)
    return t.skip("set TEST_DATABASE_URL to exercise online reset and verified Postgres backups");
  const name = "kf_reset_" + randomUUID().replaceAll("-", "");
  const owner = createPostgresPool(base);
  await owner.query(`CREATE DATABASE "${name}"`);
  t.after(async () => {
    await owner.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await owner.end();
  });
  const url = new URL(base);
  url.pathname = "/" + name;
  const f = await fixture(t, url.href, base);
  const result = await f.reset(true);
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(result.json().backupId);
  assert.equal((await f.app.inject({ url: "/admin/config", headers: f.headers })).statusCode, 200);
  assert.equal((await f.app.inject({ url: "/admin/config", headers: f.second })).statusCode, 401);
  assert.equal((await f.database.db.selectFrom("licenses").selectAll().execute()).length, 0);
  const jobs = (await f.app.inject({ url: "/admin/backups", headers: f.headers })).json().jobs;
  assert.ok(jobs[0].verifiedAt);
  await f.database.createLicense({
    plan: "again",
    entitlements: {},
    issuedTo: "Later customer",
    activationLimit: 1,
  });
  const withoutBackup = await f.reset(false);
  assert.equal(withoutBackup.statusCode, 200, withoutBackup.body);
  assert.equal(withoutBackup.json().backupId, null);
  assert.equal((await f.database.db.selectFrom("licenses").selectAll().execute()).length, 0);
});
