import assert from "node:assert/strict";
import { randomBytes, randomUUID, sign } from "node:crypto";
import test from "node:test";

import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { runReference } from "../examples/keyforge-node.js";
import {
  KeyForgeClient,
  MemoryStorage,
  verifySignedToken,
  verifyRecoveryToken,
  type ClientOptions,
} from "../packages/keyforge-client/src/index.js";
import { clientOpenApi } from "../scripts/generate-client-openapi.js";
import { buildLicenseApp } from "../src/app.js";
import { configSchema } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { Records } from "../src/platform-store.js";
import { generateSigningKeyPair } from "../src/sign.js";

async function fixture(t: any, url?: string) {
  const db = await LicenseDatabase.open({ sqlitePath: ":memory:", url });
  const pair = generateSigningKeyPair();
  let now = Date.parse("2030-01-01T12:00:00Z");
  const app = await buildLicenseApp({
    database: db,
    privateKey: pair.privateKey,
    kid: "imports-test",
    adminToken: "test-admin",
    keyring: { active: "test", keys: { test: randomBytes(32).toString("hex") } },
    config: configSchema.parse({ limits: { enabled: false } }),
    now: () => new Date(now),
    uiDir: ".no-ui",
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const admin = async (method: any, path: string, payload?: any, expected = 200) => {
    const r = await app.inject({
      method,
      url: "/admin/products/default" + path,
      headers: { authorization: "Bearer test-admin" },
      payload,
    });
    assert.equal(r.statusCode, expected, r.body);
    return r.json();
  };
  await admin("PUT", "/definitions/imports", {
    id: "imports",
    type: "number",
    description: "Units per purchase",
    minimum: 0,
    maximum: 100000,
  });
  const plan = (await admin("GET", "/catalog")).plans[0];
  await admin("PUT", "/plans/" + plan.id, {
    ...plan,
    entitlements: { imports: 50000 },
    price: 100000,
    currency: "ETB",
    durationDays: 30,
    activationLimit: 1,
  });
  const product = (await admin("GET", "/catalog")).product;
  await admin("PUT", "/import-policy", { revision: product.revision, entitlement: "imports" });
  const ajv = new Ajv2020({ strict: false });
  (addFormats as unknown as (a: Ajv2020) => void)(ajv);
  const validators = new Map<string, any>();
  const adapter: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const r = await app.inject({
      method: (init?.method as any) ?? "GET",
      url: path,
      headers: Object.fromEntries(new Headers(init?.headers)),
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    if (path.includes("recovery-requests")) {
      const entry = Object.entries(clientOpenApi.paths).find(([template]) =>
        new RegExp("^" + template.replace(/\{[^}]+\}/g, "[^/]+") + "$").test(path),
      )!;
      const op = entry[1].post as any;
      const schema = (op.responses[r.statusCode] ?? op.responses.default).content[
        "application/json"
      ].schema;
      const key = entry[0] + ":" + r.statusCode;
      if (!validators.has(key))
        validators.set(key, ajv.compile({ ...schema, components: clientOpenApi.components }));
      assert.ok(validators.get(key)(r.json()), JSON.stringify(validators.get(key).errors));
    }
    return new Response(r.body, {
      status: r.statusCode,
      headers: { "content-type": "application/json" },
    });
  };
  const options = (
    storage = new MemoryStorage(),
    extra: Partial<ClientOptions> = {},
  ): ClientOptions => ({
    serverUrl: "https://fixture.example.test",
    productId: "default",
    publicKeys: { "imports-test": pair.publicKey },
    storage,
    fetch: adapter,
    now: () => now,
    maxAttempts: 1,
    ...extra,
  });
  const issue = () =>
    admin(
      "POST",
      "/licenses",
      { requestId: randomUUID(), plan: plan.id, issuedTo: "Fictional studio" },
      201,
    );
  const renew = (id: string, extra: any = {}, expected = 200) =>
    admin(
      "POST",
      "/licenses/" + id + "/renew",
      { requestId: randomUUID(), plan: plan.id, ...extra },
      expected,
    );
  return {
    db,
    records: new Records(db.db),
    app,
    admin,
    issue,
    renew,
    options,
    pair,
    advance: (ms: number) => (now += ms),
  };
}

test("additive purchases, paid/trial separation, rollover, idempotency, payment and replacement preserve counters", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage));
  const trial = await client.startTrial();
  assert.equal(trial.state, "trial");
  if (trial.state === "trial") assert.equal(trial.token.v, 3);
  const trialEvent = randomUUID();
  await client.consumeImport(trialEvent, 12000);
  assert.equal((await client.consumeImport(trialEvent, 12000)).recorded, false);
  await assert.rejects(() => client.consumeImport(trialEvent, 1), { code: "idempotency_conflict" });
  const issued = await h.issue();
  const activated = await client.activate(issued.key);
  assert.equal(activated.state, "licensed");
  if (activated.state === "licensed") assert.equal(activated.remainingImports, 50000);
  await client.consumeImport(randomUUID(), 12000);
  const requestId = randomUUID();
  const [a, b] = await Promise.all([
    h.renew(issued.license.id, { requestId }),
    h.renew(issued.license.id, { requestId }),
  ]);
  assert.equal(a.account.granted, 100000);
  assert.equal(b.account.granted, 100000);
  await client.refresh();
  const refreshed = await client.getAuthorization();
  assert.equal(refreshed.state, "licensed");
  if (refreshed.state === "licensed") assert.equal(refreshed.remainingImports, 88000);
  const usage = await client.getImportUsage();
  assert.equal(usage!.lifetimeImports, 24000);
  assert.equal(usage!.paidConsumed, 12000);
  assert.equal(usage!.trialConsumed, 12000);
  const renewed = await h.admin("GET", "/licenses/" + issued.license.id);
  assert.equal(renewed.license.expiresAt, "2030-03-02T12:00:00.000Z");
  const topup = await h.renew(issued.license.id, { mode: "top_up" });
  assert.equal(topup.account.granted, 150000); // Per-plan 100k bounds do not cap the cumulative total.
  assert.equal(
    (await h.admin("GET", "/licenses/" + issued.license.id)).license.expiresAt,
    renewed.license.expiresAt,
  );
  await h.admin("POST", "/finance/sales/" + requestId + "/entries", {
    requestId: randomUUID(),
    kind: "payment",
    amount: 100000,
    date: "2030-01-01",
    method: "Bank transfer",
    reference: "TEST-ONLY",
  });
  assert.equal(
    (await h.admin("GET", "/licenses/" + issued.license.id + "/import-account")).account.granted,
    150000,
  );
  const replacement = await h.admin("POST", "/licenses/" + issued.license.id + "/replace-key", {
    requestId: randomUUID(),
    reason: "Customer requested a replacement key",
  });
  assert.notEqual(replacement.key, issued.key);
  await client.activate(replacement.key);
  assert.equal((await client.getImportUsage())!.lifetimeImports, 24000);
  await client.deactivate();
  await assert.rejects(() => client.startTrial(), { code: "trial_converted" });
  await client.activate(replacement.key);
  await h.admin("POST", "/licenses/" + issued.license.id + "/revoke");
  assert.equal((await client.refresh()).state, "revoked");
  assert.equal((await client.getAuthorization()).state, "revoked");
  const finance = await h.admin("GET", "/finance");
  assert.equal(finance.sales.length, 3);
});

test("lost-history recovery is admin-only, nonce-bound, single generation, conservative, and survives lost responses", async (t) => {
  const h = await fixture(t),
    oldStorage = new MemoryStorage(),
    original = new KeyForgeClient(h.options(oldStorage));
  const issued = await h.issue();
  await original.activate(issued.key);
  await original.consumeImport(randomUUID(), 12000);
  const oldIdentity = (await oldStorage.load())!;
  await original.deactivate();
  const storage = new MemoryStorage(),
    recovering = new KeyForgeClient(h.options(storage));
  await assert.rejects(() => recovering.activate(issued.key), { code: "recovery_required" });
  const request = await recovering.requestUsageRecovery(issued.license.id);
  const list = await h.admin("GET", "/recovery-requests");
  const row = list.requests.find((v: any) => v.id === request.id);
  assert.ok(!("challenge" in row));
  assert.ok(!("payload" in row));
  const unauthorized = await h.app.inject({
    method: "POST",
    url: "/admin/products/default/recovery-requests/" + encodeURIComponent(request.id) + "/approve",
    payload: {
      requestId: randomUUID(),
      revision: row.revision,
      mode: "lost_history",
      reason: "Verified customer identity independently",
    },
  });
  assert.equal(unauthorized.statusCode, 401);
  await assert.rejects(() => recovering.claimUsageRecovery(), { code: "recovery_unavailable" });
  await h.admin("POST", "/recovery-requests/" + encodeURIComponent(request.id) + "/approve", {
    requestId: randomUUID(),
    revision: row.revision,
    mode: "lost_history",
    reason: "Verified customer identity independently",
  });
  const save = storage.compareAndSwap.bind(storage);
  let fail = true;
  storage.compareAndSwap = async (revision, state) => {
    if (fail && state.importUsage?.recoveryGeneration === 1) {
      fail = false;
      throw Error("Simulated disk failure");
    }
    return save(revision, state);
  };
  await assert.rejects(() => recovering.claimUsageRecovery(), /Simulated disk failure/);
  const outcome = await recovering.claimUsageRecovery();
  assert.equal(outcome.state, "quota_exhausted");
  const recovered = (await recovering.getImportUsage())!;
  assert.equal(recovered.paidConsumed, 50000);
  assert.equal(recovered.lifetimeKnown, false);
  assert.equal(recovered.trialConverted, true);
  await assert.rejects(() => recovering.startTrial(), { code: "trial_converted" });
  const oldRefresh = await h.app.inject({
    method: "POST",
    url: "/v1/products/default/refresh",
    headers: { authorization: "Bearer " + oldIdentity.credential },
    payload: { installationId: oldIdentity.installationId, licenseId: issued.license.id },
  });
  assert.equal(oldRefresh.statusCode, 403);
  assert.equal(oldRefresh.json().error, "not_activated_here");
  await h.renew(issued.license.id, { mode: "top_up" });
  const refreshed = await recovering.refresh();
  assert.equal(refreshed.state, "licensed");
  if (refreshed.state === "licensed") assert.equal(refreshed.remainingImports, 50000);
  assert.equal((await recovering.getImportUsage())!.paidConsumed, 50000);
  assert.equal(
    (await h.records.list("product:default", "licensing_event")).filter(
      (v) => (v as any).kind === "recovery.claim",
    ).length,
    1,
  );
});

test("encrypted backup restore preserves newer known usage; wrong passwords, stale approvals and cross-context recovery fail", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage));
  const issued = await h.issue();
  await client.activate(issued.key);
  await client.consumeImport(randomUUID(), 100);
  const password = "test-backup-passphrase-only";
  const backup = await client.exportUsageBackup(password);
  assert.ok(!backup.includes("paidConsumed"));
  await client.consumeImport(randomUUID(), 200);
  await client.markUsageRecoveryRequired();
  assert.equal((await client.getAuthorization()).state, "recovery_required");
  await assert.rejects(() =>
    client.requestUsageRecovery(issued.license.id, {
      encrypted: backup,
      password: "wrong-password-for-test",
    }),
  );
  const request = await client.requestUsageRecovery(issued.license.id, {
    encrypted: backup,
    password,
  });
  const approve = async () => {
    const row = (await h.admin("GET", "/recovery-requests")).requests.find(
      (v: any) => v.id === request.id,
    );
    await h.admin("POST", "/recovery-requests/" + encodeURIComponent(request.id) + "/approve", {
      requestId: randomUUID(),
      revision: row.revision,
      mode: "restore",
      reason: "Verified customer and encrypted backup provenance",
    });
  };
  await approve();
  const result = await client.claimUsageRecovery();
  assert.equal(result.state, "licensed");
  assert.equal((await client.getImportUsage())!.paidConsumed, 300);
  assert.equal((await client.getImportUsage())!.lifetimeImports, 300);
  const pending = await client.requestUsageRecovery(issued.license.id);
  const row = (await h.admin("GET", "/recovery-requests")).requests.find(
    (v: any) => v.id === pending.id,
  );
  await h.admin("POST", "/recovery-requests/" + encodeURIComponent(pending.id) + "/approve", {
    requestId: randomUUID(),
    revision: row.revision,
    mode: "lost_history",
    reason: "Verified customer identity independently",
  });
  await h.renew(issued.license.id);
  await assert.rejects(() => client.claimUsageRecovery(), { code: "recovery_stale" });
});

test("signed ordering rejects downgrade and conflicting same-revision grants; cross-process CAS never loses usage", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage));
  const issued = await h.issue();
  await client.activate(issued.key);
  const old = (await storage.load())!.licenseToken!;
  await h.renew(issued.license.id);
  await client.refresh();
  const intercept = new KeyForgeClient(
    h.options(storage, { fetch: async () => new Response(JSON.stringify({ token: old })) }),
  );
  await assert.rejects(() => intercept.refresh(), { code: "stale_grant" });
  const current = (await storage.load())!.licenseToken!;
  const payload = JSON.parse(Buffer.from(current.split(".")[0], "base64url").toString());
  const bytes = Buffer.from(
    JSON.stringify({ ...payload, paidImportsGranted: payload.paidImportsGranted + 1 }),
  );
  const altered =
    bytes.toString("base64url") + "." + sign(null, bytes, h.pair.privateKey).toString("base64url");
  const conflicting = new KeyForgeClient(
    h.options(storage, { fetch: async () => new Response(JSON.stringify({ token: altered })) }),
  );
  await assert.rejects(() => conflicting.refresh(), { code: "revision_conflict" });
  const second = new KeyForgeClient(h.options(storage));
  const outcomes = await Promise.allSettled([
    client.consumeImport(randomUUID(), 1),
    second.consumeImport(randomUUID(), 1),
  ]);
  assert.ok(outcomes.some((v) => v.status === "fulfilled"));
  assert.equal(
    (await client.getImportUsage())!.paidConsumed,
    outcomes.filter((v) => v.status === "fulfilled").length,
  );
  for (const outcome of outcomes)
    if (outcome.status === "rejected") assert.equal(outcome.reason.code, "storage_conflict");
  const noCAS = { load: () => storage.load(), save: (s: any) => storage.save(s) };
  await assert.rejects(
    () => new KeyForgeClient(h.options(storage, { storage: noCAS })).consumeImport(randomUUID()),
    { code: "atomic_storage_required" },
  );
  const context = {
    ...h.options(storage),
    installationId: (await storage.load())!.installationId,
    now: Date.parse("2030-01-01T12:00:00Z"),
  };
  await assert.rejects(() => verifyRecoveryToken(current, context), {
    code: "unexpected_token_kind",
  });
  assert.equal((await verifySignedToken(current, context)).kind, "license");
});

test("new identities cannot claim old import accounts; renewal rollback and revocation preserve financial history", async (t) => {
  const h = await fixture(t),
    issued = await h.issue(),
    client = new KeyForgeClient(h.options());
  await client.activate(issued.key);
  const before = await h.admin("GET", "/finance");
  await h.renew(
    issued.license.id,
    { payment: { date: "2029-12-01", method: "bank", reference: "wrong date" } },
    400,
  );
  const after = await h.admin("GET", "/finance");
  assert.deepEqual(after.sales, before.sales);
  assert.equal(
    (await h.admin("GET", "/licenses/" + issued.license.id + "/import-account")).account.granted,
    50000,
  );
  await client.deactivate();
  const other = new KeyForgeClient(h.options());
  await assert.rejects(() => other.activate(issued.key), { code: "recovery_required" });
  const state = new MemoryStorage(),
    legacyClient = new KeyForgeClient(h.options(state));
  await legacyClient.register();
  const stored = (await state.load())!;
  delete stored.importUsage;
  await state.save(stored);
  await assert.rejects(() => legacyClient.activate(issued.key), { code: "recovery_required" });
});

test("legacy adoption preserves finance and requires explicit verified local usage", async (t) => {
  const h = await fixture(t),
    issued = await h.issue(),
    s = "product:default";
  const { importAccountId: _account, ...legacy } = (await h.records.get<any>(
    s,
    "license",
    issued.license.id,
  ))!;
  await h.records.put(s, "license", legacy);
  const storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage));
  await client.activate(issued.key);
  const state = (await storage.load())!;
  delete state.importUsage;
  await storage.save(state);
  const before = await h.admin("GET", "/finance");
  const grant = (await h.admin("GET", "/licenses/" + legacy.id)).license;
  await h.admin("POST", "/licenses/" + legacy.id + "/import-account", {
    requestId: randomUUID(),
    revision: grant.revision,
    granted: 50000,
    reason: "Reconciled existing allowance without a new sale",
  });
  await assert.rejects(() => client.refresh(), { code: "usage_migration_required" });
  assert.equal((await client.getAuthorization()).state, "reconnect_required");
  await client.adoptLegacyImportUsage({
    lifetimeImports: 12000,
    paidConsumed: 12000,
    trialConsumed: 0,
    lifetimeKnown: true,
  });
  const migrated = await client.refresh();
  assert.equal(migrated.state, "licensed");
  if (migrated.state === "licensed") assert.equal(migrated.remainingImports, 38000);
  assert.deepEqual((await h.admin("GET", "/finance")).sales, before.sales);
  await assert.rejects(
    () =>
      client.adoptLegacyImportUsage({
        lifetimeImports: 0,
        paidConsumed: 0,
        trialConsumed: 0,
        lifetimeKnown: true,
      }),
    { code: "usage_already_initialized" },
  );
});

test("altered recovery signatures and expired approvals cannot replace local usage", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage(),
    original = new KeyForgeClient(h.options(storage)),
    issued = await h.issue();
  await original.activate(issued.key);
  await original.consumeImport(randomUUID(), 20);
  await original.markUsageRecoveryRequired();
  const request = await original.requestUsageRecovery(issued.license.id);
  const row = (await h.admin("GET", "/recovery-requests")).requests.find(
    (v: any) => v.id === request.id,
  );
  await h.admin("POST", "/recovery-requests/" + encodeURIComponent(request.id) + "/approve", {
    requestId: randomUUID(),
    revision: row.revision,
    mode: "lost_history",
    reason: "Verified recovery request independently with the customer",
  });
  const fetch = h.options(storage).fetch!;
  const tampered = new KeyForgeClient(
    h.options(storage, {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (!String(url).endsWith("/claim") || !response.ok) return response;
        const result = (await response.json()) as { recoveryToken: string; token: string },
          parts = result.recoveryToken.split(".");
        const body = JSON.parse(Buffer.from(parts[0], "base64url").toString());
        body.paidImportsFloor = 0;
        result.recoveryToken =
          Buffer.from(JSON.stringify(body)).toString("base64url") + "." + parts[1];
        return new Response(JSON.stringify(result));
      },
    }),
  );
  await assert.rejects(() => tampered.claimUsageRecovery(), { code: "invalid_signature" });
  assert.equal((await original.getImportUsage())!.paidConsumed, 20);
  assert.equal((await original.getImportUsage())!.integrity, false);
  assert.equal((await original.claimUsageRecovery()).state, "quota_exhausted");
  const next = await original.requestUsageRecovery(issued.license.id);
  const nextRow = (await h.admin("GET", "/recovery-requests")).requests.find(
    (v: any) => v.id === next.id,
  );
  await h.admin("POST", "/recovery-requests/" + encodeURIComponent(next.id) + "/approve", {
    requestId: randomUUID(),
    revision: nextRow.revision,
    mode: "lost_history",
    reason: "Verified recovery request independently with the customer",
  });
  h.advance(86400001);
  await assert.rejects(() => original.claimUsageRecovery(), { code: "recovery_unavailable" });
});

test("recovery merges disjoint surviving receipts without refunding known imports", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage)),
    issued = await h.issue();
  await client.activate(issued.key);
  const before = (await storage.load())!;
  await client.consumeImport(randomUUID(), 100);
  const password = "fixture-only-strong-passphrase",
    backup = await client.exportUsageBackup(password);
  // Model a surviving branch with different receipts; approved recovery must
  // merge the evidence, never replace it with the larger single counter.
  await storage.save(before);
  await client.consumeImport(randomUUID(), 200);
  await client.markUsageRecoveryRequired();
  const request = await client.requestUsageRecovery(issued.license.id, {
    encrypted: backup,
    password,
  });
  const row = (await h.admin("GET", "/recovery-requests")).requests.find(
    (v: any) => v.id === request.id,
  );
  await h.admin("POST", "/recovery-requests/" + encodeURIComponent(request.id) + "/approve", {
    requestId: randomUUID(),
    revision: row.revision,
    mode: "restore",
    reason: "Verified customer and both surviving usage snapshots",
  });
  const result = await client.claimUsageRecovery();
  assert.equal(result.state, "licensed");
  const usage = (await client.getImportUsage())!;
  assert.equal(usage.paidConsumed, 300);
  assert.equal(usage.lifetimeImports, 300);
  assert.equal(usage.lifetimeKnown, false);
  assert.equal(Object.keys(usage.events).length, 2);
});

test("rejected recovery cannot be claimed and rejecting it again is idempotent", async (t) => {
  const h = await fixture(t),
    client = new KeyForgeClient(h.options()),
    issued = await h.issue();
  await client.activate(issued.key);
  const request = await client.requestUsageRecovery(issued.license.id);
  const row = (await h.admin("GET", "/recovery-requests")).requests.find(
    (v: any) => v.id === request.id,
  );
  const body = {
    requestId: randomUUID(),
    revision: row.revision,
    reason: "Could not verify account ownership independently",
  };
  const path = "/recovery-requests/" + encodeURIComponent(request.id) + "/reject";
  await h.admin("POST", path, body);
  await h.admin("POST", path, body);
  await assert.rejects(() => client.claimUsageRecovery(), { code: "recovery_unavailable" });
  assert.equal((await client.getImportUsage())!.paidConsumed, 0);
});

test("Node reference exercises import authorization, restart and additive refresh over real HTTP", async (t) => {
  const h = await fixture(t),
    serverUrl = await h.app.listen({ host: "127.0.0.1", port: 0 }),
    storage = new MemoryStorage(),
    options = h.options(storage, { serverUrl, fetch }),
    issued = await h.issue(),
    event = randomUUID();
  const initial = await runReference(options, { key: issued.key, importEventId: event });
  assert.equal(initial.importReceipt!.recorded, true);
  assert.equal(initial.canUsePaidFeatures, true);
  const restarted = await runReference(options, { importEventId: event });
  assert.equal(restarted.importReceipt!.recorded, false);
  await h.renew(issued.license.id);
  const authorization = await restarted.client.refresh();
  assert.equal(authorization.state, "licensed");
  if (authorization.state === "licensed") assert.equal(authorization.remainingImports, 99999);
  assert.equal((await restarted.client.getImportUsage())!.paidConsumed, 1);
});

test("PostgreSQL import purchases and recovery claims serialize concurrent requests", async (t) => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return t.skip("set TEST_DATABASE_URL for PostgreSQL import/recovery transactions");
  const { createPostgresPool } = await import("../src/database.js");
  const pool = createPostgresPool(base),
    schema = "kf_imports_" + randomUUID().replaceAll("-", "");
  await pool.query('CREATE SCHEMA "' + schema + '"');
  const url = new URL(base);
  url.searchParams.set("options", "-c search_path=" + schema);
  const cleanup: (() => Promise<void>)[] = [];
  try {
    const h = await fixture(
      { after: (fn: () => Promise<void>) => cleanup.push(fn) },
      url.toString(),
    );
    const issued = await h.issue(),
      storage = new MemoryStorage(),
      client = new KeyForgeClient(h.options(storage));
    await client.activate(issued.key);
    const requestId = randomUUID();
    const purchases = await Promise.all(
      Array.from({ length: 4 }, () => h.renew(issued.license.id, { requestId })),
    );
    assert.ok(purchases.every((v) => v.account.granted === 100000));
    const request = await client.requestUsageRecovery(issued.license.id);
    const row = (await h.admin("GET", "/recovery-requests")).requests.find(
      (v: any) => v.id === request.id,
    );
    await h.admin("POST", "/recovery-requests/" + encodeURIComponent(request.id) + "/approve", {
      requestId: randomUUID(),
      revision: row.revision,
      mode: "lost_history",
      reason: "Verified PostgreSQL recovery fixture identity",
    });
    const second = new KeyForgeClient(h.options(storage));
    await Promise.allSettled([client.claimUsageRecovery(), second.claimUsageRecovery()]);
    const account = (await h.admin("GET", "/licenses/" + issued.license.id + "/import-account"))
      .account;
    assert.equal(account.recoveryGeneration, 1);
    assert.equal((await h.admin("GET", "/finance")).sales.length, 2);
  } finally {
    for (const close of cleanup) await close();
    await pool.query('DROP SCHEMA "' + schema + '" CASCADE');
    await pool.end();
  }
});
