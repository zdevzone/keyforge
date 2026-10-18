import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import SQLite from "better-sqlite3";

import { createAuth, closeAuth, ensureAuthSchema } from "../src/auth.js";
import { BackupService } from "../src/backups.js";
import { configSchema } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { Records } from "../src/platform-store.js";
import { Vault } from "../src/platform-store.js";
import { Platform } from "../src/platform.js";
import { resolveRuntime } from "../src/runtime.js";
import { generateSigningKeyPair } from "../src/sign.js";
import { seedLicense } from "./record-fixtures.js";

const secret = "unified-session-test-secret-0123456789abcdef";
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), "kf-database-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, ledger: join(root, "licenses.sqlite") };
}
test("shared SQLite backups restore auth and licensing together, retaining session cookies", async (t) => {
  const f = await fixture(t);
  assert.equal(resolveRuntime({ LICENSE_DB_PATH: f.ledger }).authDbPath, f.ledger);
  assert.equal(
    resolveRuntime({ DATABASE_URL: "postgres://localhost/keyforge" }).engine,
    "postgres",
  );
  const auth = createAuth({
    dbPath: f.ledger,
    secret,
    baseURL: "http://localhost",
    allowSignUp: true,
  });
  await ensureAuthSchema(auth);
  await auth.api.signUpEmail({
    body: { email: "recovery@example.test", name: "Recovery", password: "Recovery-password-2026!" },
  });
  const signed = await auth.api.signInEmail({
    body: { email: "recovery@example.test", password: "Recovery-password-2026!" },
    asResponse: true,
  });
  const cookie = signed.headers.get("set-cookie")!.split(";")[0];
  await closeAuth(auth);
  const database = await LicenseDatabase.open({ sqlitePath: f.ledger });
  const issued = await seedLicense(database, {
    plan: "restore",
    issuedTo: "Recovery buyer",
    activationLimit: 1,
    entitlements: {},
  });
  const ring = { active: "recovery", keys: { recovery: "a".repeat(64) } };
  const service = new BackupService(
    new Platform({
      database,
      config: configSchema.parse({}),
      privateKey: generateSigningKeyPair().privateKey,
      kid: "recovery",
      now: () => new Date(),
      gate: async () => null,
    }),
    { authDbPath: f.ledger, directory: f.root, keyring: ring },
  );
  const archive = await service.capture();
  assert.deepEqual(
    archive.files.map((v) => v.name),
    ["database.sqlite"],
  );
  service.destinations.close();
  await database.close();
  const id = "00000000-0000-4000-8000-000000000000";
  const file = join(f.root, id + ".kfbackup");
  await writeFile(file, new Vault(ring).encrypt(JSON.stringify(archive), "backup:" + id));
  const target = join(f.root, "restored.sqlite");
  await promisify(execFile)(
    process.execPath,
    [
      "scripts/restore-backup.mjs",
      "--file",
      file,
      "--job",
      id,
      "--maintenance",
      "--sqlite",
      target,
    ],
    {
      windowsHide: true,
      env: {
        ...process.env,
        LICENSE_PORT: "4187",
        LICENSE_BACKUP_KEYRING: JSON.stringify(ring),
        LICENSE_BACKUP_KEYRING_FILE: "",
      },
    },
  );
  const recovered = createAuth({
    dbPath: target,
    secret,
    baseURL: "http://localhost",
  });
  try {
    await ensureAuthSchema(recovered);
    assert.equal(
      (await recovered.api.getSession({ headers: new Headers({ cookie }) }))?.user.email,
      "recovery@example.test",
    );
  } finally {
    await closeAuth(recovered);
  }
  const ledger = await LicenseDatabase.open({ sqlitePath: target });
  try {
    assert.deepEqual(
      await new Records(ledger.db).get("product:default", "license", issued.license.id),
      issued.license,
    );
  } finally {
    await ledger.close();
  }
});

test("fresh v1 schema rejects a previous development database without importing it", async (t) => {
  const f = await fixture(t);
  const old = new SQLite(f.ledger);
  old.exec(
    "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES ('001_initial', '2026-01-01'); CREATE TABLE licenses (id TEXT); INSERT INTO licenses VALUES ('old-demo')",
  );
  old.close();
  await assert.rejects(() => LicenseDatabase.open({ sqlitePath: f.ledger }), /fresh v1 database/);
  const check = new SQLite(f.ledger);
  try {
    assert.deepEqual(check.prepare("SELECT id FROM licenses").all(), [{ id: "old-demo" }]);
    assert.equal(
      (
        check
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='platform_records'")
          .get() as { n: number }
      ).n,
      0,
    );
  } finally {
    check.close();
  }
});
