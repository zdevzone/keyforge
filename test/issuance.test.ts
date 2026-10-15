import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";

import { sql } from "kysely";

import { buildLicenseApp } from "../src/app.js";
import { configSchema } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { verifyLicenseToken } from "../src/keypair.js";
import { Records } from "../src/platform-store.js";
import { generateSigningKeyPair } from "../src/sign.js";

const today = "2026-10-15";
async function fixture(t: any) {
  const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  const legacy = await database.createLicense({
    plan: "standard",
    issuedTo: "Existing buyer",
    activationLimit: 1,
    entitlements: {},
  });
  const pair = generateSigningKeyPair(),
    ring = { active: "test", keys: { test: randomBytes(32).toString("hex") } };
  const app = await buildLicenseApp({
    database,
    privateKey: pair.privateKey,
    adminToken: "test-admin",
    keyring: ring,
    config: configSchema.parse({ limits: { enabled: false } }),
    now: () => new Date(today + "T12:00:00Z"),
  });
  t.after(async () => {
    await app.close();
    await database.close();
  });
  const admin = (method: any, path: string, payload?: any) =>
    app.inject({
      method,
      url: "/admin/products/default" + path,
      headers: { authorization: "Bearer test-admin" },
      payload,
    });
  const plan = (await admin("GET", "/catalog")).json().plans.find((p: any) => p.id === "standard");
  await admin("PUT", "/plans/standard", {
    ...plan,
    price: 12000,
    currency: "ETB",
    durationDays: 30,
    activationLimit: 2,
  });
  const issue = (payload: any) =>
    admin("POST", "/licenses", {
      requestId: randomUUID(),
      plan: "standard",
      issuedTo: "Buyer",
      ...payload,
    });
  const records = new Records(database.db);
  return { app, database, ring, pair, legacy, admin, issue, records };
}
test("issuance snapshots plan terms and ETB price, records an unpaid sale exactly once, and preserves existing records", async (t) => {
  const h = await fixture(t),
    requestId = randomUUID();
  const payload = { requestId, plan: "standard", issuedTo: "Buyer" };
  const results = await Promise.all([h.issue(payload), h.issue(payload)]);
  for (const r of results) assert.equal(r.statusCode, 201, r.body);
  assert.equal(results[0].json().license.id, results[1].json().license.id);
  assert.equal(results[0].json().key, results[1].json().key);
  const first = results[0].json();
  assert.equal(first.sale.status, "unpaid");
  assert.equal(first.sale.amount, 12000);
  assert.equal(first.sale.currency, "ETB");
  assert.equal(first.license.activationLimit, 2);
  assert.equal(first.license.expiresAt, "2026-11-14T12:00:00.000Z");
  assert.equal((await h.records.list("product:default", "issuance")).length, 1);
  const plan = (await h.admin("GET", "/catalog"))
    .json()
    .plans.find((v: any) => v.id === "standard");
  await h.admin("PUT", "/plans/standard", { ...plan, price: 24000, activationLimit: 4 });
  const replay = await h.issue(payload);
  assert.equal(replay.json().sale.amount, 12000);
  assert.equal(replay.json().license.activationLimit, 2);
  assert.equal(replay.json().key, first.key);
  assert.equal((await h.issue({ ...payload, issuedTo: "Other buyer" })).statusCode, 409);
  assert.equal((await h.issue({ expectedPrice: 12000 })).statusCode, 409);
  assert.equal((await h.issue({ entitlements: { pro: true } })).statusCode, 400);
  const finance = (await h.admin("GET", "/finance")).json();
  assert.equal(finance.sales.length, 1);
  assert.equal(finance.entries.length, 0);
  assert.equal(finance.licenses.find((v: any) => v.id === h.legacy.license.id).hasSale, false);
  assert.deepEqual(await h.database.getLicense(h.legacy.license.id), h.legacy.license);
  const exported = (await h.admin("GET", "/catalog/export")).json();
  assert.equal(exported.plans.find((v: any) => v.id === "standard").price, 24000);
  const preview = (
    await h.admin("POST", "/catalog/import", { catalog: exported, preview: true })
  ).json();
  await h.admin("PUT", "/finance/prices/standard", { amount: 30000 });
  assert.equal(
    (
      await h.admin("POST", "/catalog/import", {
        catalog: exported,
        preview: false,
        fingerprint: preview.fingerprint,
      })
    ).statusCode,
    409,
  );
});
test("already-paid issuance is atomic and later payments settle an existing sale without another license", async (t) => {
  const h = await fixture(t);
  const paid = await h.issue({
    payment: { date: today, method: "Bank transfer", reference: "BANK-42" },
  });
  assert.equal(paid.statusCode, 201, paid.body);
  assert.equal(paid.json().sale.status, "paid");
  const second = (await h.issue({})).json();
  const entry = {
    requestId: randomUUID(),
    kind: "payment",
    amount: 12000,
    date: today,
    method: "Cash",
    reference: "RCPT-12",
  };
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await h.admin("POST", "/finance/sales/" + second.sale.id + "/entries", entry)).statusCode,
      200,
    );
  const finance = (await h.admin("GET", "/finance")).json();
  assert.equal(finance.sales.length, 2);
  assert.equal(finance.entries.length, 2);
  assert.ok(finance.sales.every((v: any) => v.status === "paid"));
  assert.equal(finance.licenses.length, 3); // includes the untouched historical license
  const report = (await h.admin("GET", "/finance/report")).json();
  assert.equal(report.salesValue, 24000);
  assert.equal(report.received, 24000);
  assert.equal(report.outstanding, 0);
  await sql
    .raw(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON platform_records WHEN NEW.kind='financial_entry' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END",
    )
    .execute(h.database.db);
  const broken = await h.issue({ payment: { date: today, method: "Cash", reference: "ROLLBACK" } });
  assert.equal(broken.statusCode, 500);
  assert.equal((await h.records.list("product:default", "sale")).length, 2);
  assert.equal((await h.records.list("product:default", "license")).length, 3);
});
test("unconfigured prices and invalid payments cannot silently create sales or licenses", async (t) => {
  const h = await fixture(t);
  const plan = (await h.admin("GET", "/catalog"))
    .json()
    .plans.find((v: any) => v.id === "standard");
  await h.admin("PUT", "/plans/standard", { ...plan, price: null });
  assert.equal((await h.issue({})).json().error, "price_required");
  assert.equal(
    (await h.admin("PUT", "/plans/standard", { ...plan, price: 100, currency: "USD" })).statusCode,
    400,
  );
  const current = (await h.admin("GET", "/catalog"))
    .json()
    .plans.find((v: any) => v.id === "standard");
  await h.admin("PUT", "/plans/standard", { ...current, price: 12000 });
  assert.equal(
    (await h.issue({ payment: { date: today, method: "", reference: "" } })).statusCode,
    400,
  );
  assert.equal(
    (await h.issue({ payment: { date: "2026-10-16", method: "Cash", reference: "future" } }))
      .statusCode,
    400,
  );
  assert.equal((await h.issue({ installationId: "not-registered" })).statusCode, 400);
  assert.equal((await h.records.list("product:default", "sale")).length, 0);
});
test("customers can request before installation and retrieve only through their private link", async (t) => {
  const h = await fixture(t),
    secret = randomBytes(32).toString("base64url");
  const headers = { authorization: "Bearer " + secret };
  const body = {
    id: randomUUID(),
    productId: "default",
    plan: "standard",
    name: "Before installation",
    email: "buyer@example.test",
  };
  const catalog = (await h.app.inject({ url: "/v1/license-request-catalog" })).json();
  assert.ok(catalog.products.some((v: any) => v.id === "default"));
  const created = await h.app.inject({
    method: "POST",
    url: "/v1/license-requests",
    headers,
    payload: body,
  });
  assert.equal(created.statusCode, 202, created.body);
  assert.equal(
    (await h.app.inject({ method: "POST", url: "/v1/license-requests", headers, payload: body }))
      .statusCode,
    202,
  );
  const url = "/v1/license-requests/" + body.id;
  assert.equal((await h.app.inject({ url })).statusCode, 404);
  assert.equal(
    (await h.app.inject({ method: "POST", url: url + "/collect", headers })).statusCode,
    409,
  );
  assert.equal((await h.records.list("workspace:default", "license_request")).length, 1);
  const issued = await h.issue({
    licenseRequestId: body.id,
    issuedTo: "Cannot override recipient",
  });
  assert.equal(issued.statusCode, 201, issued.body);
  assert.equal(issued.json().license.issuedTo, body.name);
  assert.equal((await h.issue({ licenseRequestId: body.id })).statusCode, 409);
  const status = await h.app.inject({ url, headers });
  assert.equal(status.json().delivery.status, "available");
  assert.equal(JSON.stringify(status.json()).includes(issued.json().key), false);
  assert.equal(JSON.stringify(status.json()).includes(secret), false);
  const collected = await h.app.inject({ method: "POST", url: url + "/collect", headers });
  assert.equal(collected.statusCode, 200, collected.body);
  assert.equal(collected.json().key, issued.json().key);
  assert.equal((await h.app.inject({ url, headers })).json().delivery.status, "retrieved");
  assert.equal(
    (await h.admin("GET", "/licenses/" + issued.json().license.id + "/activations")).json()
      .activations.length,
    0,
  );
});
test("installation delivery is scoped, exposes no key in notifications, and supports retry after retrieval failure", async (t) => {
  const h = await fixture(t),
    secret = randomBytes(32).toString("base64url"),
    other = randomBytes(32).toString("base64url");
  for (const [id, token] of [
    ["buyer", secret],
    ["other", other],
  ]) {
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: "/v1/products/default/register",
          headers: { authorization: "Bearer " + token },
          payload: { installationId: id, requestId: randomUUID() },
        })
      ).statusCode,
      200,
    );
  }
  const issued = (await h.issue({ installationId: "buyer", issuedTo: "" })).json();
  const key = issued.key,
    id = issued.license.id;
  const notifications = (
    await h.app.inject({
      url: "/v1/products/default/installations/buyer/notifications",
      headers: { authorization: "Bearer " + secret },
    })
  ).json();
  assert.ok(notifications.items.some((v: any) => v.kind === "license" && v.licenseId === id));
  assert.equal(JSON.stringify(notifications).includes(key), false);
  const base = "/v1/products/default/installations/";
  assert.equal(
    (
      await h.app.inject({
        method: "POST",
        url: base + "other/licenses/" + id + "/collect",
        headers: { authorization: "Bearer " + other },
      })
    ).statusCode,
    404,
  );
  const originalKey = h.ring.keys.test;
  h.ring.keys.test = randomBytes(32).toString("hex");
  assert.equal(
    (
      await h.app.inject({
        method: "POST",
        url: base + "buyer/licenses/" + id + "/collect",
        headers: { authorization: "Bearer " + secret },
      })
    ).statusCode,
    503,
  );
  assert.equal(
    (await h.admin("GET", "/licenses/" + id + "/delivery")).json().delivery.status,
    "failed",
  );
  h.ring.keys.test = originalKey;
  const collected = await h.app.inject({
    method: "POST",
    url: base + "buyer/licenses/" + id + "/collect",
    headers: { authorization: "Bearer " + secret },
  });
  assert.equal(collected.json().key, key);
  const active = await h.app.inject({
    method: "POST",
    url: "/v1/products/default/activate",
    headers: { authorization: "Bearer " + secret },
    payload: { installationId: "buyer", key },
  });
  assert.equal(active.statusCode, 200, active.body);
  assert.equal(verifyLicenseToken(active.json().token, h.pair.publicKey).valid, true);
});
