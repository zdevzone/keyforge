import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { buildLicenseApp } from "../src/app.js";
import { createAuth, ensureAuthSchema, closeAuth, seedOperator } from "../src/auth.js";
import { BackupService, registerBackups, type BackupJob } from "../src/backups.js";
import { configSchema } from "../src/config.js";
import { createPostgresPool } from "../src/database.js";
import { LicenseDatabase } from "../src/db.js";
import { parseEnv } from "../src/env.js";
import { atomic } from "../src/platform-store.js";
import { Platform, WORKSPACE } from "../src/platform.js";
import {
  capturePostgresSnapshot,
  parsePostgresSnapshot,
  restorePostgresSnapshot,
} from "../src/postgres-archive.js";
import { generateSigningKeyPair } from "../src/sign.js";
import { validateVercelEnvironment } from "../src/vercel-config.js";

test("Vercel package configuration includes runtime assets and keeps staging deployment manual", () => {
  const config = JSON.parse(readFileSync("vercel.json", "utf8"));
  const fn = config.functions["api/index.mjs"];
  assert.equal(typeof fn.includeFiles, "string", "Vercel requires one glob string, not an array");
  assert.ok(fn.includeFiles.includes("dist/src/**") && fn.includeFiles.includes("dist/public/**"));
  assert.equal(fn.maxDuration, 300);
  assert.match(config.buildCommand, /node scripts\/vercel-prepare.mjs$/);
  assert.equal(config.git.deploymentEnabled, false);
  assert.deepEqual(config.crons, [{ path: "/api/internal/backups/tick", schedule: "0 5 * * *" }]);
});

test("CDN asset mode retains public SPA deep links without serving API misses as HTML", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "kf-cdn-ui-"));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>KeyForge fixture</title>");
  const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  const app = await buildLicenseApp({
    database,
    privateKey: generateSigningKeyPair().privateKey,
    uiDir: directory,
    serveStaticAssets: false,
  });
  t.after(async () => {
    await app.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const page = await app.inject("/docs/vercel");
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"]!, /text\/html/);
  assert.equal((await app.inject("/api/not-a-route")).statusCode, 404);
  assert.equal((await app.inject("/v1/not-a-route")).statusCode, 404);
});

test("Vercel uses an explicit public URL first and refuses ephemeral or unencrypted setup", () => {
  assert.equal(
    parseEnv({ VERCEL_URL: "test.vercel.app" }).LICENSE_SERVER_URL,
    "https://test.vercel.app",
  );
  assert.equal(
    parseEnv({ VERCEL_URL: "test.vercel.app", LICENSE_SERVER_URL: "https://custom.example" })
      .LICENSE_SERVER_URL,
    "https://custom.example",
  );
  assert.throws(
    () => validateVercelEnvironment(parseEnv({})),
    /DATABASE_URL.*LICENSE_AUTH_SECRET.*BLOB_READ_WRITE_TOKEN/,
  );
  assert.throws(() => parsePostgresSnapshot(Buffer.from('{"version":1,"tables":[]}')));
  assert.throws(() =>
    parsePostgresSnapshot(
      Buffer.from(
        JSON.stringify({
          version: 1,
          tables: [
            {
              name: "user",
              columns: [{ name: "id", type: "text", required: true }],
              parents: [],
              rows: ['{"id":"one","extra":"bad"}'],
            },
          ],
        }),
      ),
    ),
  );
});

test("external-only backup survives a new instance, protects cron, and refuses local jobs", async (t) => {
  const db = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  const platform = new Platform({
    database: db,
    config: configSchema.parse({}),
    privateKey: generateSigningKeyPair().privateKey,
    kid: "test",
    now: () => new Date(),
    gate: async () => null,
  });
  const stored = new Map<string, Buffer>();
  const options = {
    enabled: true,
    remoteOnly: true,
    defaultDestination: "blob",
    cronSecret: randomBytes(32).toString("hex"),
    keyring: { active: "test", keys: { test: randomBytes(32).toString("hex") } },
    drivers: {
      blob: {
        upload: async (id: string, bytes: Buffer) => {
          stored.set(id, bytes);
          return { type: "blob" as const, key: id };
        },
        download: async (file: { key: string }) => stored.get(file.key)!,
        remove: async (file: { key: string }) => {
          stored.delete(file.key);
        },
      },
    },
  };
  const service = new BackupService(platform, options);
  const job = await service.enqueue("blob");
  await service.tick();
  const done = (await platform.records.get<BackupJob>(WORKSPACE, "backup", job.id))!;
  assert.equal(done.status, "completed");
  assert.equal(done.cacheAvailable, false);
  assert.ok(done.remoteFile);
  const restarted = new BackupService(platform, options);
  assert.ok((await restarted.bytes(done)).length);
  await restarted.verify(done);
  await assert.rejects(service.enqueue("local"), /durable external/);
  const app = Fastify();
  const pending: Promise<void>[] = [];
  await registerBackups(
    app,
    platform,
    {
      ...options,
      background: (p) => {
        pending.push(p);
      },
    },
    async () => ({ actor: "cli", role: "admin" }),
  );
  t.after(async () => {
    await Promise.all(pending);
    await app.close();
    await db.close();
  });
  assert.equal((await app.inject("/api/internal/backups/tick")).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        url: "/api/internal/backups/tick",
        headers: { authorization: "Bearer " + options.cronSecret },
      })
    ).statusCode,
    200,
  );
  const state = (await app.inject("/admin/backups")).json();
  assert.equal(state.defaultDestination, "blob");
  assert.equal(state.remoteOnly, true);
  const queued = await app.inject({ method: "POST", url: "/admin/backups", payload: {} });
  assert.equal(queued.statusCode, 202, queued.body);
  await Promise.all(pending);
  assert.equal(
    (await platform.records.get<BackupJob>(WORKSPACE, "backup", queued.json().job.id))?.status,
    "completed",
  );
});

test("portable Postgres snapshot restores credentials and financial data, rolls back verification, and restores sequences", async (t) => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return t.skip("set TEST_DATABASE_URL for portable Postgres recovery");
  const pool = createPostgresPool(base);
  const schemas = ["kf_archive_", "kf_recovery_"].map((p) => p + randomUUID().replaceAll("-", ""));
  const urls: string[] = [];
  const dbs: LicenseDatabase[] = [];
  const auths: ReturnType<typeof createAuth>[] = [];
  const secret = randomBytes(32).toString("hex");
  t.after(async () => {
    for (const auth of auths) await closeAuth(auth);
    for (const db of dbs) await db.close();
    for (const schema of schemas) await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
    await pool.end();
  });
  for (const schema of schemas) {
    await pool.query('CREATE SCHEMA "' + schema + '"');
    const url = new URL(base);
    url.searchParams.set("options", "-c search_path=" + schema);
    urls.push(url.href);
    dbs.push(await LicenseDatabase.open({ url: url.href }));
    const auth = createAuth({
      url: url.href,
      dbPath: ":memory:",
      secret,
      baseURL: "http://localhost:4100",
    });
    auths.push(auth);
    await ensureAuthSchema(auth);
  }
  await seedOperator({
    url: urls[0],
    dbPath: ":memory:",
    secret,
    email: "archive@example.test",
    password: "a-long-password-for-archive",
  });
  await auths[0].api.signInEmail({
    body: { email: "archive@example.test", password: "a-long-password-for-archive" },
  });
  await atomic(dbs[0], async (r) => {
    await r.put("product:default", "sale", {
      id: "historic",
      amount: 12345,
      currency: "ETB",
      paymentStatus: "unpaid",
    });
    await r.put("product:default", "trial", { id: "spent", consumed: 100 });
  });
  await dbs[0].db
    .insertInto("audit_log")
    .values({
      at: new Date().toISOString(),
      actor: "test",
      action: "snapshot",
      license_id: null,
      detail: "{}",
    })
    .execute();
  const bytes = await capturePostgresSnapshot(urls[0]);
  assert.ok(parsePostgresSnapshot(bytes).tables.some((t) => t.name === "session" && t.rows.length));
  await restorePostgresSnapshot(urls[1], bytes); // Full recovery, then rollback.
  assert.equal((await dbs[1].db.selectFrom("platform_records").selectAll().execute()).length, 0);
  await restorePostgresSnapshot(urls[1], bytes, true);
  assert.deepEqual(
    await dbs[1].db.selectFrom("platform_records").selectAll().execute(),
    await dbs[0].db.selectFrom("platform_records").selectAll().execute(),
  );
  await auths[1].api.signInEmail({
    body: { email: "archive@example.test", password: "a-long-password-for-archive" },
  });
  await dbs[1].db
    .insertInto("audit_log")
    .values({
      at: new Date().toISOString(),
      actor: "test",
      action: "after restore",
      license_id: null,
      detail: "{}",
    })
    .execute();
  const mutated = JSON.parse(bytes.toString());
  mutated.tables.find((t: { name: string }) => t.name === "user").rows[0] = '{"id":"invalid"}';
  await assert.rejects(
    restorePostgresSnapshot(urls[1], Buffer.from(JSON.stringify(mutated)), true),
  );
  await auths[1].api.signInEmail({
    body: { email: "archive@example.test", password: "a-long-password-for-archive" },
  });
});
