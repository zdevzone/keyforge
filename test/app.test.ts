import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildLicenseApp } from "../src/app.js";
import { BackupService } from "../src/backups.js";
import { configSchema } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { verifyLicenseToken } from "../src/keypair.js";
import { Platform } from "../src/platform.js";
import { generateSigningKeyPair } from "../src/sign.js";
const pair = generateSigningKeyPair();
const ring = { active: "test", keys: { test: randomBytes(32).toString("hex") } };
const prefix = "/admin/products/default";
async function harness(t: any, options: any = {}) {
  const db = await LicenseDatabase.open({
    url: options.url,
    sqlitePath: options.path ?? ":memory:",
  });
  const now = () => new Date(options.time ?? "2026-10-12T12:00:00.000Z");
  const config = configSchema.parse({ limits: { enabled: false }, ...options.config });
  const app = await buildLicenseApp({
    database: db,
    privateKey: pair.privateKey,
    adminToken: "test-admin",
    keyring: ring,
    now,
    config,
    ...options.app,
  });
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const admin = (method: "GET" | "POST" | "PUT" | "PATCH", path: string, payload?: any) =>
    app.inject({
      method,
      url: prefix + path,
      headers: { authorization: "Bearer test-admin" },
      payload,
    });
  const call = (path: string, payload: any, secret?: string) =>
    app.inject({
      method: "POST",
      url: "/v1/products/default" + path,
      headers: secret ? { authorization: "Bearer " + secret } : {},
      payload,
    });
  async function register(
    id: string,
    signals: any[] = [],
    requestId = randomUUID(),
    secret = randomBytes(32).toString("base64url"),
  ) {
    const body = { installationId: id, requestId, machineSignals: signals };
    const response = await call("/register", body, secret);
    assert.equal(response.statusCode, 200, response.body);
    return { body, secret, response };
  }
  async function catalog() {
    await admin("PUT", "/definitions/imports", {
      id: "imports",
      type: "number",
      description: "Imports",
      minimum: 0,
      archived: false,
    });
    await admin("PUT", "/plans/pro", {
      id: "pro",
      description: "Pro",
      price: 10000,
      currency: "ETB",
      entitlements: { imports: 100 },
      durationDays: null,
      activationLimit: 1,
      archived: false,
    });
  }
  async function issue(extra: any = {}) {
    await catalog();
    if (extra.expiresAt) {
      const plan = (await admin("GET", "/catalog")).json().plans.find((p: any) => p.id === "pro");
      await admin("PUT", "/plans/pro", {
        ...plan,
        durationDays: Math.ceil((Date.parse(extra.expiresAt) - now().getTime()) / 86400000),
      });
      delete extra.expiresAt;
    }
    const r = await admin("POST", "/licenses", {
      requestId: randomUUID(),
      plan: "pro",
      issuedTo: "Customer",
      ...extra,
    });
    assert.equal(r.statusCode, 201, r.body);
    return r.json();
  }
  return { app, db, config, now, admin, call, register, catalog, issue };
}
test("fresh contract removes legacy routes and preserves signed revocation", async (t) => {
  const h = await harness(t),
    issued = await h.issue(),
    install = await h.register("one");
  assert.equal(
    (await h.app.inject({ method: "POST", url: "/v1/activate", payload: { key: issued.key } }))
      .statusCode,
    404,
  );
  let r = await h.call("/activate", { installationId: "one", key: issued.key }, install.secret);
  assert.equal(r.statusCode, 200, r.body);
  const verified = verifyLicenseToken(r.json().token, pair.publicKey);
  assert.equal(verified.valid, true);
  const payload = verified.payload as any;
  assert.equal(payload.v, 1);
  assert.equal(payload.productId, "default");
  assert.equal(payload.entitlements.imports, 100);
  assert.equal("allowance" in payload, false);
  await h.admin("POST", "/licenses/" + issued.license.id + "/revoke", {});
  r = await h.call(
    "/refresh",
    { installationId: "one", licenseId: issued.license.id },
    install.secret,
  );
  assert.equal(r.statusCode, 200);
  assert.equal(
    (verifyLicenseToken(r.json().token, pair.publicKey).payload as any).status,
    "revoked",
  );
});
test("IDs cannot refresh, release or take over an installation", async (t) => {
  const h = await harness(t),
    i = await h.register("owned"),
    l = await h.issue();
  assert.equal(
    (await h.call("/activate", { installationId: "owned", key: l.key })).statusCode,
    401,
  );
  assert.equal(
    (
      await h.call(
        "/register",
        { ...i.body, requestId: randomUUID() },
        randomBytes(32).toString("base64url"),
      )
    ).statusCode,
    401,
  );
  await h.call("/activate", { installationId: "owned", key: l.key }, i.secret);
  assert.equal(
    (await h.call("/deactivate", { installationId: "owned", licenseId: l.license.id })).statusCode,
    401,
  );
  assert.equal(
    (await h.call("/refresh", { installationId: "owned", licenseId: l.license.id }, "wrong"))
      .statusCode,
    401,
  );
});
test("registration replay preserves trial and rejects changed content", async (t) => {
  const h = await harness(t),
    signals = ["machine-guid", "smbios-uuid"].map((kind) => ({
      kind,
      hash: createHash("sha256").update(kind).digest("hex"),
    }));
  const a = await h.register("a", signals);
  assert.equal(
    (verifyLicenseToken(a.response.json().trial.token, pair.publicKey).payload as any).verdict,
    "fresh",
  );
  const replay = await h.call("/register", a.body, a.secret);
  assert.deepEqual(replay.json(), a.response.json());
  assert.equal(
    (await h.call("/register", { ...a.body, appVersion: "changed" }, a.secret)).statusCode,
    409,
  );
  const b = await h.register("b", signals);
  assert.equal(
    (verifyLicenseToken(b.response.json().trial.token, pair.publicKey).payload as any).verdict,
    "spent",
  );
  const list = await h.admin("GET", "/machines"),
    machine = list.json().machines[0];
  await h.admin("POST", "/machines/" + machine.id + "/clear", {});
  const c = await h.register("c", signals);
  assert.equal(
    (verifyLicenseToken(c.response.json().trial.token, pair.publicKey).payload as any).verdict,
    "fresh",
  );
  const d = await h.register("d", signals);
  assert.equal(
    (verifyLicenseToken(d.response.json().trial.token, pair.publicKey).payload as any).verdict,
    "spent",
  );
});
test("atomic activation across independent SQLite connections respects seat limit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kf-seat-"));
  const a = await harness(t, { path: join(dir, "db.sqlite") }),
    b = await harness(t, { path: join(dir, "db.sqlite") });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const l = await a.issue(),
    i = await a.register("a"),
    j = await b.register("b");
  const responses = await Promise.all([
    a.call("/activate", { installationId: "a", key: l.key }, i.secret),
    b.call("/activate", { installationId: "b", key: l.key }, j.secret),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
});
test("product isolation and staged rotation", async (t) => {
  const h = await harness(t);
  let r = await h.app.inject({
    method: "POST",
    url: "/admin/products",
    headers: { authorization: "Bearer test-admin" },
    payload: { id: "other", name: "Other" },
  });
  assert.equal(r.statusCode, 200, r.body);
  const l = await h.issue();
  r = await h.app.inject({
    method: "GET",
    url: "/admin/products/other/licenses/" + l.license.id,
    headers: { authorization: "Bearer test-admin" },
  });
  assert.equal(r.statusCode, 404);
  const catalog = (await h.admin("GET", "/catalog")).json();
  r = await h.admin("POST", "/keys/stage", { revision: catalog.product.revision });
  assert.equal(r.statusCode, 200, r.body);
  const staged = r.json().product;
  assert.equal(staged.keys.filter((k: any) => k.pending).length, 1);
  const i = await h.register("rotation");
  const before = (
    await h.call("/activate", { installationId: "rotation", key: l.key }, i.secret)
  ).json().token;
  assert.equal(verifyLicenseToken(before, pair.publicKey).valid, true);
  const key = staged.keys.find((k: any) => k.pending);
  r = await h.admin("POST", "/keys/" + key.kid + "/activate", {
    revision: staged.revision,
    confirm: true,
  });
  assert.equal(r.statusCode, 200, r.body);
  const after = (
    await h.call("/refresh", { installationId: "rotation", licenseId: l.license.id }, i.secret)
  ).json().token;
  assert.equal(verifyLicenseToken(after, key.publicKeyPem).valid, true);
  assert.equal(verifyLicenseToken(after, pair.publicKey).valid, false);
});
test("encrypted key storage never leaks through listings and authenticated reveal is audited", async (t) => {
  const h = await harness(t),
    l = await h.issue();
  const list = (await h.admin("GET", "/licenses")).json().licenses[0];
  assert.equal(list.keyStored, true);
  assert.equal(JSON.stringify(list).includes(l.key), false);
  assert.equal("keyHash" in list, false);
  const r = await h.admin("POST", "/licenses/" + l.license.id + "/key", {});
  assert.equal(r.json().key, l.key);
  assert.equal(r.headers["cache-control"], "no-store");
  const data = await h.db.db
    .selectFrom("platform_records")
    .select("data")
    .where("kind", "=", "license")
    .execute();
  assert.equal(JSON.stringify(data).includes(l.key), false);
  const audit = (
    await h.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: { authorization: "Bearer test-admin" },
    })
  ).json();
  assert.equal(JSON.stringify(audit).includes(l.key), false);
});
test("plan snapshots, archived definitions and optimistic revisions", async (t) => {
  const h = await harness(t),
    l = await h.issue(),
    catalog = (await h.admin("GET", "/catalog")).json();
  const plan = catalog.plans.find((p: any) => p.id === "pro");
  assert.equal(
    (await h.admin("PUT", "/plans/pro", { ...plan, entitlements: { imports: 50 } })).statusCode,
    200,
  );
  assert.equal(
    (await h.admin("GET", "/licenses/" + l.license.id)).json().license.entitlements.imports,
    100,
  );
  assert.equal(
    (await h.admin("PUT", "/plans/pro", { ...plan, entitlements: { imports: 40 } })).statusCode,
    409,
  );
  const def = catalog.definitions.find((d: any) => d.id === "imports");
  assert.equal(
    (await h.admin("PUT", "/definitions/imports", { ...def, type: "string" })).statusCode,
    409,
  );
  assert.equal(
    (
      await h.admin("PATCH", "/licenses/" + l.license.id, {
        revision: l.license.revision ?? 1,
        entitlements: { typo: true },
      })
    ).statusCode,
    400,
  );
});
test("catalog import previews validate and stale previews cannot apply", async (t) => {
  const h = await harness(t);
  await h.catalog();
  const catalog = (await h.admin("GET", "/catalog/export")).json();
  const preview = (await h.admin("POST", "/catalog/import", { catalog, preview: true })).json();
  assert.equal(
    (
      await h.admin("POST", "/catalog/import", {
        catalog,
        preview: false,
        fingerprint: preview.fingerprint,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await h.admin("POST", "/catalog/import", {
        catalog,
        preview: false,
        fingerprint: preview.fingerprint,
      })
    ).statusCode,
    409,
  );
});
test("support conversations enforce ownership, internal privacy and revision conflicts", async (t) => {
  const h = await harness(t),
    l = await h.issue(),
    i = await h.register("customer"),
    other = await h.register("other");
  await h.call("/activate", { installationId: "customer", key: l.key }, i.secret);
  const base = "/v1/products/default/installations/customer/support",
    requestId = randomUUID();
  const body = {
    licenseId: l.license.id,
    requestId,
    category: "technical",
    urgency: "normal",
    subject: "Need assistance",
    message: "This is the complete issue.",
    createdAt: "2026-10-12T12:00:00.000Z",
  };
  const headers = { authorization: "Bearer " + i.secret, "idempotency-key": requestId };
  const created = await h.app.inject({ method: "POST", url: base, headers, payload: body });
  assert.equal(created.statusCode, 202, created.body);
  const id = created.json().request.id;
  assert.deepEqual(
    (await h.app.inject({ method: "POST", url: base, headers, payload: body })).json(),
    created.json(),
  );
  let ticket = (await h.admin("GET", "/support/" + id)).json().request;
  assert.equal(
    (
      await h.admin("POST", "/support/" + id + "/messages", {
        requestId: randomUUID(),
        message: "Private investigation",
        internal: true,
        revision: ticket.revision,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await h.admin("GET", "/support")).json().requests.find((t: any) => t.id === id)
      .previewInternal,
    true,
  );
  ticket = (await h.admin("GET", "/support/" + id)).json().request;
  await h.admin("POST", "/support/" + id + "/messages", {
    requestId: randomUUID(),
    message: "Please retry now",
    internal: false,
    revision: ticket.revision,
  });
  const customer = await h.app.inject({
    method: "GET",
    url: base + "/" + id,
    headers: { authorization: "Bearer " + i.secret },
  });
  assert.equal(customer.json().request.messages.length, 1);
  assert.equal(customer.body.includes("Private investigation"), false);
  assert.equal(customer.body.includes("test-admin"), false);
  const wrong = await h.app.inject({
    method: "GET",
    url: "/v1/products/default/installations/other/support/" + id,
    headers: { authorization: "Bearer " + other.secret },
  });
  assert.equal(wrong.statusCode, 404);
  ticket = (await h.admin("GET", "/support/" + id)).json().request;
  await h.admin("PATCH", "/support/" + id, {
    status: "resolved",
    assignedTo: null,
    revision: ticket.revision,
  });
  assert.equal(
    (
      await h.admin("PATCH", "/support/" + id, {
        status: "closed",
        assignedTo: null,
        revision: ticket.revision,
      })
    ).statusCode,
    409,
  );
  ticket = (await h.admin("GET", "/support/" + id)).json().request;
  const reply = await h.app.inject({
    method: "POST",
    url: base + "/" + id + "/messages",
    headers: { authorization: "Bearer " + i.secret },
    payload: { requestId: randomUUID(), message: "Still need help", revision: ticket.revision },
  });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.equal(reply.json().request.status, "queued");
});
test("meter consumption is atomic, idempotent and product credential scoped", async (t) => {
  const h = await harness(t),
    l = await h.issue();
  await h.admin("PUT", "/meters/imports", {
    id: "imports",
    entitlement: "imports",
    period: "lifetime",
    description: "Imports",
    archived: false,
  });
  const c = (
    await h.admin("POST", "/credentials", {
      name: "Backend",
      permissions: ["usage:read", "usage:consume"],
    })
  ).json();
  const consume = (body: any) =>
    h.app.inject({
      method: "POST",
      url: "/v1/products/default/usage/consume",
      headers: { authorization: "Bearer " + c.secret },
      payload: body,
    });
  const first = { licenseId: l.license.id, meterId: "imports", eventId: randomUUID(), units: 60 };
  const r = await consume(first);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().remaining, 40);
  assert.deepEqual((await consume(first)).json(), r.json());
  assert.equal((await consume({ ...first, units: 61 })).statusCode, 409);
  const responses = await Promise.all([
    consume({ ...first, eventId: randomUUID(), units: 30 }),
    consume({ ...first, eventId: randomUUID(), units: 30 }),
  ]);
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  await h.admin("POST", "/credentials/" + c.id + "/revoke", {});
  assert.equal((await consume({ ...first, eventId: randomUUID(), units: 1 })).statusCode, 401);
});
test("diagnostics reject malformed/untrusted claims instead of labelling them authorized", async (t) => {
  const h = await harness(t),
    l = await h.issue(),
    i = await h.register("diag");
  const token = (await h.call("/activate", { installationId: "diag", key: l.key }, i.secret)).json()
    .token;
  let r = await h.admin("POST", "/diagnostics", { token });
  assert.equal(r.json().signatureValid, true);
  assert.equal(r.json().schemaValid, true);
  assert.equal(
    (await h.admin("POST", "/diagnostics", { token: token + ".extra" })).statusCode,
    400,
  );
  r = await h.admin("POST", "/diagnostics", { token: token.split(".")[0] + ".AAAA" });
  assert.equal(r.json().currentAuthorization, "not_authorized");
});
test("manual snapshots do not require schedule or archive keys; archives verify in isolation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "kf-backups-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = await harness(t, { app: { backups: { directory: dir, keyring: ring } } });
  const manual = await h.app.inject({
    method: "GET",
    url: "/admin/backup/licenses",
    headers: { authorization: "Bearer test-admin" },
  });
  assert.equal(manual.statusCode, 200, manual.body);
  assert.match(manual.headers["content-type"]!, /octet-stream/);
  const platform = new Platform({
    database: h.db,
    config: h.config,
    privateKey: pair.privateKey,
    kid: "test",
    keyring: ring,
    now: h.now,
    gate: async () => null,
  });
  const service = new BackupService(platform, { directory: dir, keyring: ring });
  const job = await service.enqueue("local");
  await service.tick();
  const completed = await platform.records.get<any>("workspace:default", "backup", job.id);
  assert.equal(completed.status, "completed", completed.error);
  await service.verify(completed);
  assert.ok((await platform.records.get<any>("workspace:default", "backup", job.id))!.verifiedAt);
  const bytes = await service.bytes(completed);
  assert.equal(bytes.toString().includes("platform_records"), false);
});

test("Postgres product workflow serializes seats and metered quotas", async (t) => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return t.skip("set TEST_DATABASE_URL to exercise product-scoped Postgres workflows");
  const { createPostgresPool } = await import("../src/database.js");
  const pool = createPostgresPool(base);
  const schema = "kf_product_" + randomUUID().replaceAll("-", "");
  await pool.query('CREATE SCHEMA "' + schema + '"');
  const url = new URL(base);
  url.searchParams.set("options", "-c search_path=" + schema);
  const h = await harness({ after: () => {} }, { url: url.toString() });
  try {
    const license = await h.issue();
    const a = await h.register("pg-one"),
      b = await h.register("pg-two");
    const seats = await Promise.all([
      h.call("/activate", { installationId: "pg-one", key: license.key }, a.secret),
      h.call("/activate", { installationId: "pg-two", key: license.key }, b.secret),
    ]);
    assert.deepEqual(seats.map((r) => r.statusCode).sort(), [200, 409]);
    const groupsBefore = (await h.admin("GET", "/machines")).json().machines;
    const backfill = await h.app.inject({
      method: "PUT",
      url: "/v1/products/default/installations/pg-one/device-signals",
      headers: { authorization: "Bearer " + a.secret },
      payload: { machineSignals: [{ kind: "machine-guid", hash: "e".repeat(64) }] },
    });
    assert.equal(backfill.statusCode, 200, backfill.body);
    const groupsAfter = (await h.admin("GET", "/machines")).json().machines;
    assert.deepEqual(
      groupsAfter.map((m: any) => [m.id, m.registrationCount, m.trialState]),
      groupsBefore.map((m: any) => [m.id, m.registrationCount, m.trialState]),
    );
    assert.equal(
      (await h.admin("GET", `/licenses/${license.license.id}/activations`))
        .json()
        .activations.filter((b: any) => !b.deactivatedAt).length,
      1,
    );
    const meter = await h.admin("PUT", "/meters/imports", {
      id: "imports",
      entitlement: "imports",
      period: "monthly",
      description: "Imports",
      archived: false,
    });
    assert.equal(meter.statusCode, 200, meter.body);
    const credential = (
      await h.admin("POST", "/credentials", { name: "Backend", permissions: ["usage:consume"] })
    ).json();
    const consume = (eventId: string) =>
      h.app.inject({
        method: "POST",
        url: "/v1/products/default/usage/consume",
        headers: { authorization: "Bearer " + credential.secret },
        payload: { licenseId: license.license.id, meterId: "imports", eventId, units: 60 },
      });
    const event = randomUUID();
    const usage = await Promise.all([consume(event), consume(randomUUID())]);
    assert.deepEqual(usage.map((r) => r.statusCode).sort(), [200, 409]);
    const winning = usage.find((r) => r.statusCode === 200)!;
    assert.equal(winning.json().remaining, 40);
    const temp = await mkdtemp(join(tmpdir(), "keyforge-pg-archive-"));
    const verification = new URL(base);
    verification.pathname = "/postgres";
    const platform = new Platform({
      database: h.db,
      config: h.config,
      privateKey: pair.privateKey,
      kid: "test",
      keyring: ring,
      now: h.now,
      gate: async () => null,
    });
    const backups = new BackupService(platform, {
      keyring: ring,
      directory: temp,
      databaseUrl: url.toString(),
      verificationUrl: verification.toString(),
    });
    try {
      const job = await backups.enqueue("local");
      await backups.tick();
      const completed = await platform.records.get<any>("workspace:default", "backup", job.id);
      assert.equal(completed?.status, "completed", completed?.error);
      await backups.verify(completed!);
      assert.ok(
        (await platform.records.get<any>("workspace:default", "backup", job.id))?.verifiedAt,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } finally {
    await h.app.close();
    await h.db.close();
    await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
    await pool.end();
  }
});
test("encrypted SQLite archives restore only to explicit maintenance targets", async (t) => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  const temp = await mkdtemp(join(tmpdir(), "keyforge-restore-test-"));
  const h = await harness(t),
    license = await h.issue();
  const p = new Platform({
    database: h.db,
    config: h.config,
    privateKey: pair.privateKey,
    kid: "test",
    keyring: ring,
    now: h.now,
    gate: async () => null,
  });
  const service = new BackupService(p, { keyring: ring, directory: temp });
  const job = await service.enqueue("local");
  await service.tick();
  const completed = await p.records.get<any>("workspace:default", "backup", job.id);
  assert.equal(completed?.status, "completed");
  const file = service.path(job.id),
    target = join(temp, "restored.sqlite");
  const command = [
    "scripts/restore-backup.mjs",
    "--file",
    file,
    "--job",
    job.id,
    "--maintenance",
    "--sqlite",
    target,
  ];
  const options = {
    windowsHide: true,
    env: {
      ...process.env,
      LICENSE_BACKUP_KEYRING: JSON.stringify(ring),
      LICENSE_BACKUP_KEYRING_FILE: "",
      LICENSE_PORT: "4187",
    },
  };
  try {
    await assert.rejects(() =>
      execute(
        process.execPath,
        command.filter((arg) => arg !== "--maintenance"),
        options,
      ),
    );
    await execute(process.execPath, command, options);
    const restored = await LicenseDatabase.open({ sqlitePath: target });
    try {
      const record = await new Platform({
        database: restored,
        config: h.config,
        privateKey: pair.privateKey,
        kid: "test",
        keyring: ring,
        now: h.now,
        gate: async () => null,
      }).records.get<any>("product:default", "license", license.license.id);
      assert.equal(record?.issuedTo, "Customer");
    } finally {
      await restored.close();
    }
    const before = await readFile(target);
    await assert.rejects(() => execute(process.execPath, command, options));
    assert.deepEqual(await readFile(target), before);
    await writeFile(file, (await readFile(file)).subarray(0, 40));
    await assert.rejects(() => execute(process.execPath, [...command, "--replace"], options));
    assert.deepEqual(await readFile(target), before);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("credential identity cannot repeat a trial by omitting hardware signals", async (t) => {
  const h = await harness(t);
  const first = await h.register("anonymous");
  const decode = (token: string) =>
    JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assert.equal(decode(first.response.json().trial.token).verdict, "fresh");
  const repeated = await h.register("anonymous", [], randomUUID(), first.secret);
  assert.equal(decode(repeated.response.json().trial.token).verdict, "spent");
  const machines = (await h.admin("GET", "/machines")).json().machines;
  assert.equal(machines.length, 1);
  await h.admin("POST", "/machines/" + machines[0].id + "/clear", {});
  const cleared = await h.register("anonymous", [], randomUUID(), first.secret);
  assert.equal(decode(cleared.response.json().trial.token).verdict, "fresh");
  const used = await h.register("anonymous", [], randomUUID(), first.secret);
  assert.equal(decode(used.response.json().trial.token).verdict, "spent");
});

test("startup rejects a signing key that disagrees with the persisted public key", async (t) => {
  const h = await harness(t);
  const another = generateSigningKeyPair();
  const kid = (await h.admin("GET", "/catalog"))
    .json()
    .product.keys.find((key: any) => !key.retiredAt && !key.pending).kid;
  await assert.rejects(
    () => buildLicenseApp({ database: h.db, privateKey: another.privateKey, keyring: ring, kid }),
    /persisted product public key/,
  );
});

test("notification read state, preferences and customer privacy preserve communication boundaries", async (t) => {
  const h = await harness(t),
    l = await h.issue({ expiresAt: "2026-10-19T12:00:00.000Z" }),
    i = await h.register("notified");
  await h.call("/activate", { installationId: "notified", key: l.key }, i.secret);
  const base = "/v1/products/default/installations/notified";
  const headers = { authorization: "Bearer " + i.secret };
  const requestId = randomUUID();
  const created = await h.app.inject({
    method: "POST",
    url: base + "/support",
    headers: { ...headers, "idempotency-key": requestId },
    payload: {
      licenseId: l.license.id,
      requestId,
      category: "technical",
      urgency: "normal",
      subject: "Notifications test",
      message: "Please help with this issue",
      createdAt: h.now().toISOString(),
    },
  });
  assert.equal(created.statusCode, 202, created.body);
  const ticketId = created.json().request.id;
  const events = (await h.admin("GET", "/notifications")).json().items;
  assert.ok(events.some((n: any) => n.kind === "expiration"));
  const message = events.find((n: any) => n.kind === "message");
  assert.ok(message);
  assert.equal(
    (await h.admin("POST", "/notifications/read", { eventId: message.id })).statusCode,
    200,
  );
  assert.equal(
    (await h.admin("GET", "/notifications")).json().items.find((n: any) => n.id === message.id)
      .read,
    true,
  );
  await h.admin("POST", "/support/" + ticketId + "/read", { lastMessageId: "original" });
  assert.equal((await h.admin("GET", "/support?view=unread")).json().total, 0);
  let ticket = (await h.admin("GET", "/support/" + ticketId)).json().request;
  await h.admin("POST", "/support/" + ticketId + "/messages", {
    requestId: randomUUID(),
    message: "Secret operator note",
    internal: true,
    revision: ticket.revision,
  });
  let customer = (await h.app.inject({ url: base + "/notifications", headers })).json();
  assert.equal(
    customer.items.some((n: any) => n.kind === "reply"),
    false,
  );
  assert.equal(JSON.stringify(customer).includes("Secret"), false);
  ticket = (await h.admin("GET", "/support/" + ticketId)).json().request;
  await h.admin("POST", "/support/" + ticketId + "/messages", {
    requestId: randomUUID(),
    message: "Public reply",
    revision: ticket.revision,
  });
  customer = (await h.app.inject({ url: base + "/notifications", headers })).json();
  const reply = customer.items.find((n: any) => n.kind === "reply");
  assert.ok(reply);
  await h.app.inject({
    method: "POST",
    url: base + "/notifications/read",
    headers,
    payload: { eventId: reply.id },
  });
  assert.equal(
    (await h.app.inject({ url: base + "/notifications", headers }))
      .json()
      .items.find((n: any) => n.id === reply.id).read,
    true,
  );
  await h.app.inject({
    method: "PUT",
    url: base + "/notifications/preferences",
    headers,
    payload: { messages: false, expirations: false },
  });
  assert.deepEqual(
    (await h.app.inject({ url: base + "/notifications", headers })).json().items,
    [],
  );
  assert.equal(
    (
      await h.app.inject({
        url: base + "/notifications",
        headers: { authorization: "Bearer wrong" },
      })
    ).statusCode,
    401,
  );
  await h.admin("PUT", "/notifications/preferences", {
    messages: false,
    assignments: false,
    expirations: false,
  });
  assert.ok(
    (await h.admin("GET", "/notifications")).json().items.length > 0,
    "preferences preserve captured history",
  );
  assert.equal(
    (await h.admin("POST", "/notifications/bulk", { action: "delete", scope: "all" })).statusCode,
    400,
  );
  const feed = (await h.admin("GET", "/notifications")).json().items;
  const first = feed[0];
  assert.equal(
    (
      await h.admin("POST", "/notifications/bulk", {
        action: "unread",
        scope: "selected",
        eventIds: [first.id],
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await h.admin("GET", "/notifications")).json().items.find((n: any) => n.id === first.id).read,
    false,
  );
  await h.admin("POST", "/notifications/bulk", {
    action: "read",
    scope: "matching",
    filter: "unread",
  });
  assert.ok((await h.admin("GET", "/notifications")).json().items.every((n: any) => n.read));
  await h.admin("POST", "/notifications/bulk", {
    action: "delete",
    scope: "selected",
    eventIds: [first.id],
    confirmed: true,
  });
  await h.admin("POST", "/notifications/read", { eventId: first.id });
  assert.equal(
    (await h.admin("GET", "/notifications")).json().items.some((n: any) => n.id === first.id),
    false,
    "legacy read endpoint cannot resurrect deleted notifications",
  );
  await h.admin("POST", "/notifications/bulk", { action: "delete", scope: "all", confirmed: true });
  assert.deepEqual((await h.admin("GET", "/notifications")).json().items, []);
});
