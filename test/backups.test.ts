import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import Fastify from "fastify";

import {
  BackupDestinations,
  customDestinationSchema,
  storageOptionsFromEnv,
  nextBackupTime,
  type BackupDriver,
} from "../src/backup-destinations.js";
import {
  BackupService,
  registerBackups,
  type BackupOptions,
  type BackupJob,
  type Schedule,
} from "../src/backups.js";
import { configSchema } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { atomic } from "../src/platform-store.js";
import { Platform, WORKSPACE } from "../src/platform.js";
import { generateSigningKeyPair } from "../src/sign.js";

async function fixture(t: TestContext, options: BackupOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kf-provider-test-"));
  const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  let time = new Date("2026-10-12T12:00:00Z");
  const platform = new Platform({
    database,
    config: configSchema.parse({}),
    privateKey: generateSigningKeyPair().privateKey,
    kid: "test",
    now: () => time,
    gate: async () => null,
  });
  const settings = {
    directory,
    keyring: { active: "test", keys: { test: randomBytes(32).toString("hex") } },
    enabled: true,
    ...options,
  };
  const service = new BackupService(platform, settings);
  t.after(async () => {
    service.destinations.close();
    await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    service,
    platform,
    settings,
    advance: (value: string) => {
      time = new Date(value);
    },
  };
}
async function endpoint(
  t: TestContext,
  handler: (
    method: string,
    path: string,
    headers: Record<string, any>,
    body: Buffer,
  ) => { status?: number; body?: Buffer | string; headers?: Record<string, string> },
) {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const result = handler(req.method!, req.url!, req.headers, Buffer.concat(chunks));
    res.writeHead(result.status ?? 200, result.headers);
    res.end(result.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}
async function custom(h: Awaited<ReturnType<typeof fixture>>, value: Record<string, unknown>) {
  const item = { ...customDestinationSchema.parse(value), id: "custom-" + randomUUID() };
  await atomic(h.platform.options.database, (r) => r.put(WORKSPACE, "backup-destination", item));
  return item;
}
async function job(h: Awaited<ReturnType<typeof fixture>>, id: string) {
  return (await h.platform.records.get<BackupJob>(WORKSPACE, "backup", id))!;
}
test("public multipart and authenticated raw endpoints receive encrypted archives; failed uploads remain downloadable", async (t) => {
  const uploads: { path: string; method: string; headers: Record<string, any>; body: Buffer }[] =
    [];
  const url = await endpoint(t, (method, path, headers, body) => {
    uploads.push({ method, path, headers, body });
    return { status: path === "/fail" ? 403 : 201, body: "provider-secret-must-not-leak" };
  });
  const h = await fixture(t);
  const anonymous = await custom(h, { name: "Public", url: url + "/form" });
  const raw = await custom(h, {
    name: "Private",
    url: url + "/raw",
    method: "PUT",
    format: "raw",
    headerName: "Authorization",
    headerValueEnv: "LICENSE_BACKUP_CUSTOM_TEST_TOKEN",
  });
  h.service.destinations.env = { LICENSE_BACKUP_CUSTOM_TEST_TOKEN: "Bearer fixture-secret" };
  const failed = await custom(h, { name: "Reject", url: url + "/fail", format: "raw" });
  for (const target of [anonymous, raw, failed]) {
    const queued = await h.service.enqueue(target.id);
    await h.service.tick();
    const record = await job(h, queued.id);
    assert.equal(record.status, target === failed ? "failed" : "completed", record.error);
    const bytes = await h.service.bytes(record);
    assert.equal(bytes.includes(Buffer.from("SQLite format 3")), false);
    await h.service.verify(record);
    if (target === anonymous) {
      const request = new Request(url, {
        method: "POST",
        headers: { "content-type": uploads[0].headers["content-type"] },
        body: new Uint8Array(uploads[0].body),
      });
      const form = await request.formData();
      const file = form.get("file") as File;
      assert.equal(file.name, queued.id + ".kfbackup");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      assert.equal(uploads[0].headers.authorization, undefined);
    } else if (target === raw) {
      assert.equal(uploads[1].method, "PUT");
      assert.equal(uploads[1].headers.authorization, "Bearer fixture-secret");
      assert.deepEqual(uploads[1].body, bytes);
    } else {
      assert.equal(record.errorCode, "backup_remote_http_error");
      assert.match(record.error!, /HTTP 403/);
      assert.equal(record.error!.includes("provider-secret"), false);
      assert.equal(record.cacheAvailable, true);
    }
  }
});
test("S3 and R2 use separate credentials and buckets and support remote read/delete", async (t) => {
  const files = new Map<string, Buffer>(),
    auth: string[] = [];
  const url = await endpoint(t, (method, path, headers, body) => {
    auth.push(headers.authorization ?? "");
    const key = path.split("?")[0];
    if (method === "PUT") {
      files.set(key, body);
      return {};
    }
    if (method === "DELETE") {
      files.delete(key);
      return { status: 204 };
    }
    const bytes = files.get(key);
    return bytes
      ? { body: bytes, headers: { "content-length": String(bytes.length) } }
      : { status: 404 };
  });
  const destinations = new BackupDestinations({
    s3: {
      bucket: "aws-bucket",
      endpoint: url,
      region: "us-east-1",
      credentials: { accessKeyId: "AWS_TEST", secretAccessKey: "aws-test-secret" },
    },
    r2: {
      bucket: "r2-bucket",
      endpoint: url,
      region: "auto",
      credentials: { accessKeyId: "R2_TEST", secretAccessKey: "r2-test-secret" },
    },
  });
  t.after(() => destinations.close());
  assert.equal((await destinations.statuses([])).filter((d) => d.configured).length, 3);
  for (const id of ["s3", "r2"]) {
    const driver = await destinations.driver(id),
      bytes = Buffer.from("encrypted-test-envelope");
    const ref = await driver.upload(randomUUID(), bytes);
    assert.ok(ref);
    assert.deepEqual(await driver.download!(ref), bytes);
    await driver.remove!(ref);
    await assert.rejects(driver.download!(ref), /not found/i);
  }
  assert.ok(auth.some((a) => a.includes("Credential=AWS_TEST/")));
  assert.ok(auth.some((a) => a.includes("Credential=R2_TEST/")));
  assert.equal(files.size, 0);
});
test("daily UTC schedules, toggles and retention are independent per destination", async (t) => {
  const removed: string[] = [],
    stored = new Map<string, Buffer>();
  const mock = (id: string): BackupDriver => ({
    upload: async (key, bytes) => {
      stored.set(id + key, bytes);
      return { type: "uploadthing", key: id + key };
    },
    download: async (file) => stored.get(file.key)!,
    remove: async (file) => {
      removed.push(id);
      stored.delete(file.key);
    },
  });
  const h = await fixture(t, {
    drivers: { s3: mock("s3"), r2: mock("r2"), uploadthing: mock("uploadthing") },
  });
  await h.service.saveSchedule("s3", {
    enabled: true,
    hourUTC: 13,
    minuteUTC: 0,
    retentionDays: 1,
  });
  await h.service.saveSchedule("r2", {
    enabled: true,
    hourUTC: 13,
    minuteUTC: 15,
    retentionDays: 7,
  });
  await h.service.saveSchedule("uploadthing", {
    enabled: false,
    hourUTC: 13,
    minuteUTC: 0,
    retentionDays: 30,
  });
  h.advance("2026-10-12T13:16:00Z");
  while (await h.service.tick()) {}
  const jobs = await h.platform.records.list<BackupJob>(WORKSPACE, "backup");
  assert.deepEqual(jobs.map((j) => j.destination).sort(), ["r2", "s3"]);
  assert.ok(jobs.every((j) => j.status === "completed"));
  const s3 = jobs.find((j) => j.destination === "s3")!;
  await rm(h.service.path(s3.id));
  assert.ok((await h.service.bytes(s3)).length);
  h.advance("2026-10-14T12:00:00Z");
  await h.service.prune();
  assert.deepEqual(removed, ["s3"]);
  assert.equal((await job(h, s3.id)).pruned, true);
  assert.equal((await job(h, jobs.find((j) => j.destination === "r2")!.id)).pruned, undefined);
  assert.equal(
    nextBackupTime(new Date("2026-10-12T13:15:00Z"), 13, 15),
    "2026-10-13T13:15:00.000Z",
  );
  await assert.rejects(
    h.service.saveSchedule("s3", { enabled: false, hourUTC: 1, minuteUTC: 0, retentionDays: 1 }),
    /Reload/,
  );
  await assert.rejects(
    h.service.saveSchedule("s3", {
      enabled: false,
      hourUTC: 1,
      minuteUTC: 0,
      retentionDays: 1,
      revision: 99,
    }),
    /changed/,
  );
});
test("custom destinations validate auth references, enforce admin role, and archive only their own schedule", async (t) => {
  const h = await fixture(t),
    app = Fastify();
  await registerBackups(app, h.platform, h.settings, async (req, reply) => {
    const role = req.headers.authorization;
    if (!role) {
      reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    return { actor: "cli", role: String(role) };
  });
  t.after(() => app.close());
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: any, role = "admin") =>
    app.inject({ method, url, payload, headers: { authorization: role } });
  const publicURL = "http://127.0.0.1:9999/upload";
  assert.equal(
    (
      await call(
        "POST",
        "/admin/backups/destinations",
        { name: "Denied", url: publicURL },
        "support",
      )
    ).statusCode,
    403,
  );
  assert.equal((await app.inject("/admin/backups")).statusCode, 401);
  for (const payload of [
    { name: "Invalid", url: "file:///etc/file" },
    {
      name: "Invalid",
      url: publicURL,
      headerName: "Authorization",
      headerValueEnv: "LICENSE_SIGNING_KEY",
    },
    { name: "Invalid", url: publicURL, headerName: "Authorization" },
  ])
    assert.equal((await call("POST", "/admin/backups/destinations", payload)).statusCode, 400);
  const created = await call("POST", "/admin/backups/destinations", {
    name: "Archive",
    url: publicURL,
  });
  assert.equal(created.statusCode, 201, created.body);
  const destination = created.json().destination;
  await call("PUT", "/admin/backups/destinations/" + destination.id + "/schedule", {
    enabled: true,
    hourUTC: 13,
    minuteUTC: 45,
    retentionDays: 3,
  });
  await call("PUT", "/admin/backups/destinations/local/schedule", {
    enabled: true,
    hourUTC: 14,
    minuteUTC: 10,
    retentionDays: 5,
  });
  const update = {
    name: "Archive",
    url: publicURL,
    archived: true,
    revision: destination.revision,
  };
  assert.equal(
    (await call("PUT", "/admin/backups/destinations/" + destination.id, update)).statusCode,
    200,
  );
  assert.equal(
    (await call("PUT", "/admin/backups/destinations/" + destination.id, update)).statusCode,
    409,
  );
  const state = (await call("GET", "/admin/backups")).json();
  assert.equal(
    state.destinations.some((d: any) => d.id === destination.id),
    false,
  );
  assert.equal(state.destinations.find((d: any) => d.id === "local").schedule.enabled, true);
  assert.equal(
    (await h.platform.records.get<Schedule>(WORKSPACE, "backup-schedule", destination.id))!.enabled,
    false,
  );
});
test("credentials detect concurrently, aliases resolve, invalid UploadThing tokens do not crash startup", async () => {
  const options = storageOptionsFromEnv({
    LICENSE_BACKUP_S3_BUCKET: "s3",
    LICENSE_BACKUP_S3_ACCESS_KEY_ID: "s3key",
    LICENSE_BACKUP_S3_SECRET_ACCESS_KEY: "s3secret",
    R2_BUCKET_NAME: "r2",
    R2_ACCOUNT_ID: "account",
    R2_ACCESS_KEY_ID: "r2key",
    R2_SECRET_ACCESS_KEY: "r2secret",
    UPLOADTHING_TOKEN: "invalid",
  });
  assert.equal(options.r2!.endpoint, "https://account.r2.cloudflarestorage.com");
  assert.equal(options.s3!.credentials!.accessKeyId, "s3key");
  assert.equal(options.r2!.credentials!.accessKeyId, "r2key");
  const destinations = new BackupDestinations(options);
  try {
    const status = await destinations.statuses([]);
    assert.equal(status.find((d) => d.id === "s3")!.configured, true);
    assert.equal(status.find((d) => d.id === "r2")!.configured, true);
    assert.equal(status.find((d) => d.id === "uploadthing")!.configured, false);
    assert.equal(JSON.stringify(status).includes("s3secret"), false);
    assert.equal(JSON.stringify(status).includes("r2secret"), false);
  } finally {
    destinations.close();
  }
});
test("partial dedicated credentials never fall back to another provider's keys", async () => {
  const options = storageOptionsFromEnv({
    LICENSE_BACKUP_S3_BUCKET: "s3",
    LICENSE_BACKUP_S3_ACCESS_KEY_ID: "partial",
    LICENSE_BACKUP_R2_BUCKET: "r2",
    LICENSE_BACKUP_R2_ACCOUNT_ID: "account",
    LICENSE_BACKUP_R2_ACCESS_KEY_ID: "partial",
    R2_ACCESS_KEY_ID: "alias-key",
    R2_SECRET_ACCESS_KEY: "alias-secret",
  });
  assert.equal(options.s3!.credentials!.secretAccessKey, "");
  assert.equal(options.r2!.credentials!.secretAccessKey, "");
  const destinations = new BackupDestinations(options);
  try {
    const status = await destinations.statuses([]);
    for (const id of ["s3", "r2"]) {
      assert.equal(status.find((d) => d.id === id)!.configured, false);
      assert.match(status.find((d) => d.id === id)!.reason!, /both/);
    }
  } finally {
    destinations.close();
  }
});
test("custom retention preserves endpoint-managed remote objects and missing cache errors are actionable", async (t) => {
  const url = await endpoint(t, () => ({ status: 204 }));
  const h = await fixture(t),
    target = await custom(h, { name: "Upload only", url });
  await h.service.saveSchedule(target.id, {
    enabled: false,
    hourUTC: 2,
    minuteUTC: 0,
    retentionDays: 1,
  });
  const queued = await h.service.enqueue(target.id);
  await h.service.tick();
  const record = await job(h, queued.id);
  assert.ok((await readFile(h.service.path(record.id))).length);
  await rm(h.service.path(record.id));
  await assert.rejects(h.service.bytes(record), /local archive is missing/i);
  h.advance("2026-10-14T12:00:00Z");
  await h.service.prune();
  const pruned = await job(h, record.id);
  assert.equal(pruned.pruned, true);
  assert.equal(pruned.remoteRetained, true);
});

test("UploadThing SDK adapter uploads a native File, downloads with a signed URL and deletes by recorded key", async () => {
  const original = globalThis.fetch,
    bytes = Buffer.from("encrypted-ut-envelope");
  const methods: string[] = [];
  let uploadedName = "";
  const destinations = new BackupDestinations({
    uploadthing: {
      token: Buffer.from(
        JSON.stringify({ apiKey: "sk_fixture", appId: "fixture", regions: ["iad1"] }),
      ).toString("base64"),
    },
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    methods.push(request.method);
    if (request.method === "PUT") {
      const form = await request.formData();
      const file = form.get("file") as File;
      uploadedName = file.name;
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      return Response.json({
        url: "https://fixture.ufs.sh/f/mock",
        appUrl: "https://fixture.ufs.sh/f/mock",
        ufsUrl: "https://fixture.ufs.sh/f/mock",
        fileHash: "fixture",
      });
    }
    if (request.method === "GET") {
      assert.match(request.url, /signature=/);
      return new Response(new Uint8Array(bytes));
    }
    assert.match(request.url, /deleteFiles/);
    assert.equal(request.headers.get("x-uploadthing-api-key"), "sk_fixture");
    const body = (await request.json()) as { fileKeys: string[] };
    assert.equal(body.fileKeys.length, 1);
    return Response.json({ success: true, deletedCount: 1 });
  };
  try {
    assert.equal(
      (await destinations.statuses([])).find((d) => d.id === "uploadthing")!.configured,
      true,
    );
    const driver = await destinations.driver("uploadthing"),
      id = randomUUID(),
      ref = await driver.upload(id, bytes);
    assert.ok(ref);
    assert.equal(uploadedName, id + ".kfbackup");
    assert.equal(ref.type, "uploadthing");
    assert.deepEqual(await driver.download!(ref), bytes);
    await driver.remove!(ref);
    assert.deepEqual(methods, ["PUT", "GET", "POST"]);
  } finally {
    globalThis.fetch = original;
    destinations.close();
  }
});
