import assert from "node:assert/strict";
import { randomUUID, verify } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import SQLite from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";

import { buildLicenseApp } from "../src/app.js";
import { configSchema, resolveListenPort, type AppConfig } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { generateSigningKeyPair, type LicenseTokenPayload } from "../src/sign.js";

const ADMIN = "test-admin-token";
const { publicKey, privateKey } = generateSigningKeyPair();

/** Decode and signature-verify a token the way a consuming app would. */
function readToken(token: string): LicenseTokenPayload {
  const [body, signature] = token.split(".");
  const bytes = Buffer.from(body, "base64url");
  assert.ok(
    verify(null, bytes, publicKey, Buffer.from(signature, "base64url")),
    "token signature must verify against the public key",
  );
  return JSON.parse(bytes.toString("utf8")) as LicenseTokenPayload;
}

interface TestClock {
  now: () => Date;
  advanceDays: (days: number) => void;
}

function makeClock(startIso = "2026-01-01T00:00:00.000Z"): TestClock {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advanceDays: (days) => {
      current += days * 24 * 60 * 60 * 1000;
    },
  };
}

interface TestApp {
  app: FastifyInstance;
  clock: TestClock;
}

/**
 * The suite runs against SQLite by default. Point TEST_DATABASE_URL at a
 * Postgres instance (CI does) and the identical suite runs there, which is how
 * dialect differences get caught rather than assumed away.
 */
const POSTGRES_URL = process.env.TEST_DATABASE_URL;

/** Each app gets its own schema-clean database. */
async function makeApp(configOverride: Record<string, unknown> = {}): Promise<TestApp> {
  const clock = makeClock();
  // Rate limits stay off by default so rapid test calls never trip them;
  // the rate-limit test opts back in with a tiny budget.
  const config: AppConfig = configSchema.parse({ limits: { enabled: false }, ...configOverride });
  const database = await LicenseDatabase.open(
    POSTGRES_URL ? { url: POSTGRES_URL } : { sqlitePath: ":memory:" },
  );
  if (POSTGRES_URL) await truncateAll(database);
  const app = await buildLicenseApp({
    database,
    privateKey,
    adminToken: ADMIN,
    config,
    now: clock.now,
  });
  return { app, clock };
}

/** Postgres tests share one database, so each case starts from empty tables. */
async function truncateAll(database: LicenseDatabase): Promise<void> {
  await sql`TRUNCATE licenses, activations, installations, audit_log RESTART IDENTITY CASCADE`.execute(
    database.db,
  );
}

const auth = { authorization: `Bearer ${ADMIN}` };

async function issue(app: FastifyInstance, body: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/admin/licenses",
    headers: auth,
    payload: { issuedTo: "Test Customer", ...body },
  });
  assert.equal(response.statusCode, 201);
  return response.json() as {
    license: { id: string; entitlements: Record<string, unknown> };
    key: string;
  };
}

test("activation lifecycle: activate, refresh, revoke propagates as a signed verdict", async () => {
  const { app } = await makeApp();
  const { license, key } = await issue(app, { entitlements: { allowance: 1000 } });

  const activated = await app.inject({
    method: "POST",
    url: "/v1/activate",
    payload: { key, installationId: "machine-1" },
  });
  assert.equal(activated.statusCode, 200);
  const payload = readToken(activated.json().token);
  assert.equal(payload.v, 2);
  assert.equal(payload.licenseId, license.id);
  assert.equal(payload.status, "active");
  assert.deepEqual(payload.entitlements, { allowance: 1000 });
  assert.equal(payload.allowance, 1000); // v1 compatibility mirror

  const revoked = await app.inject({
    method: "POST",
    url: `/admin/licenses/${license.id}/revoke`,
    headers: auth,
    payload: {},
  });
  assert.equal(revoked.statusCode, 200);

  const refreshed = await app.inject({
    method: "POST",
    url: "/v1/refresh",
    payload: { licenseId: license.id, installationId: "machine-1" },
  });
  assert.equal(refreshed.statusCode, 200);
  assert.equal(readToken(refreshed.json().token).status, "revoked");
});

test("unknown, revoked and expired keys answer distinctly", async () => {
  const { app, clock } = await makeApp();

  const unknown = await app.inject({
    method: "POST",
    url: "/v1/activate",
    payload: { key: "KEY-NOPE", installationId: "m" },
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error, "unknown_key");

  const expiring = await issue(app, {
    expiresAt: new Date(clock.now().getTime() + 24 * 60 * 60 * 1000).toISOString(),
  });
  clock.advanceDays(2);
  const expired = await app.inject({
    method: "POST",
    url: "/v1/activate",
    payload: { key: expiring.key, installationId: "m" },
  });
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.json().error, "license_expired");
});

test("seat limit blocks a second machine until the first releases", async () => {
  const { app } = await makeApp();
  const { license, key } = await issue(app, { activationLimit: 1 });

  const first = await app.inject({
    method: "POST",
    url: "/v1/activate",
    payload: { key, installationId: "machine-1" },
  });
  assert.equal(first.statusCode, 200);

  const second = await app.inject({
    method: "POST",
    url: "/v1/activate",
    payload: { key, installationId: "machine-2" },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "activation_limit_reached");

  // Same machine again is idempotent, not a second seat.
  const again = await app.inject({
    method: "POST",
    url: "/v1/activate",
    payload: { key, installationId: "machine-1" },
  });
  assert.equal(again.statusCode, 200);

  const released = await app.inject({
    method: "POST",
    url: "/v1/deactivate",
    payload: { licenseId: license.id, installationId: "machine-1" },
  });
  assert.equal(released.statusCode, 200);

  const transferred = await app.inject({
    method: "POST",
    url: "/v1/activate",
    payload: { key, installationId: "machine-2" },
  });
  assert.equal(transferred.statusCode, 200);
});

test("validate reports seats without consuming one", async () => {
  const { app } = await makeApp();
  const { key } = await issue(app, { activationLimit: 2, entitlements: { seats: 2, pro: true } });

  for (let i = 0; i < 3; i += 1) {
    const validated = await app.inject({ method: "POST", url: "/v1/validate", payload: { key } });
    assert.equal(validated.statusCode, 200);
    assert.equal(validated.json().seatsInUse, 0);
    assert.deepEqual(validated.json().entitlements, { seats: 2, pro: true });
  }
});

test("register upserts and empty fields never erase earlier data", async () => {
  const { app } = await makeApp();
  const first = await app.inject({
    method: "POST",
    url: "/v1/register",
    payload: {
      installationId: "census-1",
      appVersion: "1.0.0",
      platform: "linux",
      userName: "Someone",
      userEmail: "someone@example.com",
    },
  });
  assert.equal(first.statusCode, 200);

  const again = await app.inject({
    method: "POST",
    url: "/v1/register",
    payload: { installationId: "census-1", appVersion: "1.1.0" },
  });
  assert.equal(again.statusCode, 200);

  const listed = await app.inject({ method: "GET", url: "/admin/installations", headers: auth });
  const install = listed
    .json()
    .installations.find((i: { installationId: string }) => i.installationId === "census-1");
  assert.equal(install.appVersion, "1.1.0");
  assert.equal(install.userName, "Someone");
  assert.equal(install.userEmail, "someone@example.com");
});

test("PATCH validates entitlements, limits and expiry", async () => {
  const { app } = await makeApp();
  const { license } = await issue(app);

  const badLimit = await app.inject({
    method: "PATCH",
    url: `/admin/licenses/${license.id}`,
    headers: auth,
    payload: { activationLimit: 0 },
  });
  assert.equal(badLimit.statusCode, 400);

  const badEntitlements = await app.inject({
    method: "PATCH",
    url: `/admin/licenses/${license.id}`,
    headers: auth,
    payload: { entitlements: { nested: { object: true } } },
  });
  assert.equal(badEntitlements.statusCode, 400);
  assert.equal(badEntitlements.json().error, "bad_entitlements");

  const good = await app.inject({
    method: "PATCH",
    url: `/admin/licenses/${license.id}`,
    headers: auth,
    payload: { entitlements: { allowance: 500, tier: "gold" }, expiresAt: null },
  });
  assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json().license.entitlements, { allowance: 500, tier: "gold" });
});

test("search is case-insensitive and identical on both engines", async () => {
  const { app } = await makeApp();
  await issue(app, { issuedTo: "Acme Corporation", plan: "Enterprise" });

  // SQLite's LIKE ignores ASCII case and Postgres' does not, so this asserts
  // the behavior the server normalizes rather than either engine's default.
  for (const q of ["acme", "ACME", "Acme", "corporation", "ENTERPRISE"]) {
    const response = await app.inject({
      method: "GET",
      url: `/admin/licenses?q=${encodeURIComponent(q)}`,
      headers: auth,
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().total, 1, `search "${q}" should match`);
  }

  const miss = await app.inject({ method: "GET", url: "/admin/licenses?q=zzz", headers: auth });
  assert.equal(miss.json().total, 0);
});

test("installation search is case-insensitive too", async () => {
  const { app } = await makeApp();
  await app.inject({
    method: "POST",
    url: "/v1/register",
    payload: { installationId: "Census-ABC", platform: "Windows-11", userName: "Dana" },
  });
  for (const q of ["census", "WINDOWS", "dana"]) {
    const response = await app.inject({
      method: "GET",
      url: `/admin/installations?q=${encodeURIComponent(q)}`,
      headers: auth,
    });
    assert.equal(response.json().total, 1, `search "${q}" should match`);
  }
});

test("admin routes require the bearer token", async () => {
  const { app } = await makeApp();
  for (const url of ["/admin/licenses", "/admin/audit", "/admin/installations"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401);
  }
});

test("admin actions land in the audit log with their actor", async () => {
  const { app } = await makeApp();
  const { license } = await issue(app);
  await app.inject({
    method: "POST",
    url: `/admin/licenses/${license.id}/revoke`,
    headers: auth,
    payload: {},
  });

  const audit = await app.inject({ method: "GET", url: "/admin/audit", headers: auth });
  const actions = audit.json().entries.map((e: { action: string }) => e.action);
  assert.deepEqual(actions, ["license.revoke", "license.issue"]);
  assert.ok(audit.json().entries.every((e: { actor: string }) => e.actor === "cli"));
});

test("config: custom key format shows up in issued keys", async () => {
  const { app } = await makeApp({ key: { prefix: "ACME", groups: 3, groupLength: 4 } });
  const { key } = await issue(app);
  assert.match(key, /^ACME-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
});

test("config: plan presets fill entitlements, duration and seats", async () => {
  const { app, clock } = await makeApp({
    licenses: {
      defaultPlan: "trial",
      planPresets: {
        trial: {
          entitlements: { allowance: 100, trial: true },
          durationDays: 14,
          activationLimit: 1,
        },
      },
    },
  });
  const { license } = await issue(app, { plan: "trial" });
  assert.deepEqual(license.entitlements, { allowance: 100, trial: true });
  const expires = new Date((license as { expiresAt?: string }).expiresAt ?? 0).getTime();
  assert.equal(expires, clock.now().getTime() + 14 * 24 * 60 * 60 * 1000);
});

test("config: disabled registry answers 404 on both surfaces", async () => {
  const { app } = await makeApp({ registry: { enabled: false } });
  const register = await app.inject({
    method: "POST",
    url: "/v1/register",
    payload: { installationId: "x" },
  });
  assert.equal(register.statusCode, 404);
  const admin = await app.inject({ method: "GET", url: "/admin/installations", headers: auth });
  assert.equal(admin.statusCode, 404);
});

test("config: collectUserInfo=false stores anonymous census rows", async () => {
  const { app } = await makeApp({ registry: { collectUserInfo: false } });
  await app.inject({
    method: "POST",
    url: "/v1/register",
    payload: { installationId: "anon-1", userName: "Nosy", userEmail: "nosy@example.com" },
  });
  const listed = await app.inject({ method: "GET", url: "/admin/installations", headers: auth });
  const install = listed.json().installations[0];
  assert.equal(install.userName, "");
  assert.equal(install.userEmail, "");
});

test("config: rate limit answers 429 past the budget", async () => {
  const { app } = await makeApp({
    limits: { enabled: true, validate: { max: 2, timeWindow: "1 minute" } },
  });
  const results: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/validate",
      payload: { key: "KEY-WHATEVER" },
    });
    results.push(response.statusCode);
  }
  assert.deepEqual(results, [404, 404, 429]);
});

test("config: disabled audit and backups answer 404 and record nothing", async () => {
  const { app } = await makeApp({ features: { audit: false, backups: false } });
  await issue(app);
  const audit = await app.inject({ method: "GET", url: "/admin/audit", headers: auth });
  assert.equal(audit.statusCode, 404);
  const backup = await app.inject({ method: "GET", url: "/admin/backup/licenses", headers: auth });
  assert.equal(backup.statusCode, 404);
});

test("a pre-entitlements database migrates and still accepts new licenses", async (t) => {
  // Postgres runs share one database, so build the legacy shape on SQLite.
  if (POSTGRES_URL) return t.skip("legacy-schema fixture is SQLite-specific");

  const file = join(tmpdir(), `keyforge-legacy-${randomUUID()}.sqlite`);
  const legacy = new SQLite(file);
  legacy.exec(`
    CREATE TABLE licenses (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      plan TEXT NOT NULL,
      allowance INTEGER NOT NULL,
      issued_to TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      activation_limit INTEGER NOT NULL DEFAULT 1,
      issued_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );
    INSERT INTO licenses (id, key_hash, plan, allowance, issued_to, issued_at)
    VALUES ('old-1', 'hash-1', 'standard', 200000, 'Legacy Customer', '2025-01-01T00:00:00.000Z');
  `);
  legacy.close();

  try {
    const database = await LicenseDatabase.open({ sqlitePath: file });
    // The old allowance survives as an entitlement...
    const page = await database.listLicenses();
    assert.equal(page.total, 1);
    assert.deepEqual(page.licenses[0].entitlements, { allowance: 200000 });

    // ...and the NOT NULL legacy column no longer blocks new inserts, which
    // is what broke when the ledger moved to Kysely.
    const issued = await database.createLicense({ plan: "new", entitlements: { seats: 2 } });
    assert.deepEqual(issued.license.entitlements, { seats: 2 });
    assert.equal((await database.listLicenses()).total, 2);

    // Re-opening is a no-op: migrations are recorded, not re-run.
    await database.close();
    const reopened = await LicenseDatabase.open({ sqlitePath: file });
    assert.equal((await reopened.listLicenses()).total, 2);
    await reopened.close();
  } finally {
    await rm(file, { force: true });
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
  }
});

test("meta is public and carries the configured branding", async () => {
  const { app } = await makeApp({ branding: { name: "Acme Licensing" } });
  const meta = await app.inject({ method: "GET", url: "/api/meta" });
  assert.equal(meta.statusCode, 200);
  assert.deepEqual(meta.json(), { name: "Acme Licensing" });
});

test("allowance remains accepted as sugar for entitlements.allowance", async () => {
  const { app } = await makeApp();
  const { license, key } = await issue(app, { allowance: 42 });
  assert.deepEqual(license.entitlements, { allowance: 42 });
  const activated = await app.inject({
    method: "POST",
    url: "/v1/activate",
    payload: { key, installationId: "m" },
  });
  assert.equal(readToken(activated.json().token).allowance, 42);
});

/**
 * Platform hosts assign a port and pass it as PORT. Ignoring it means binding
 * 4100, failing every health check, and reading logs that say nothing is
 * wrong — so this tiny function is worth pinning down.
 */
test("the listen port follows the host, but an explicit setting wins", () => {
  assert.equal(resolveListenPort({}), 4100);
  assert.equal(resolveListenPort({ PORT: "8080" }), 8080);
  assert.equal(resolveListenPort({ LICENSE_PORT: "4200" }), 4200);
  assert.equal(resolveListenPort({ LICENSE_PORT: "4200", PORT: "8080" }), 4200);
  // Nonsense falls back rather than crashing the process at listen() time.
  for (const bad of ["", "http", "0", "-1", "70000", "80.5"]) {
    assert.equal(resolveListenPort({ PORT: bad }), 4100, `PORT=${bad} should fall back`);
  }
});

/**
 * The console is the only place the public key can be recovered once keygen's
 * output has scrolled away, so /admin/config carries it. The thing that must
 * never happen is the private half going with it — the whole trust model is
 * that only this service holds it.
 */
test("admin config publishes the public key and never the private one", async () => {
  const { app } = await makeApp();
  const response = await app.inject({ method: "GET", url: "/admin/config", headers: auth });
  assert.equal(response.statusCode, 200);

  const { signingKey } = response.json();
  assert.equal(signingKey.keyType, "ed25519");
  assert.equal(signingKey.publicKeyPem.trim(), publicKey.trim());
  assert.match(signingKey.fingerprint, /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);

  // Asserted over the whole serialized body, not just the signingKey object:
  // a leak added anywhere else in this response should fail this test too.
  assert.doesNotMatch(response.body, /PRIVATE KEY/);
  assert.ok(!response.body.includes(privateKey.trim().split("\n")[1]));
});

test("the entitlement catalog reports what the ledger holds, and needs an operator", async () => {
  const { app } = await makeApp();
  await issue(app, { entitlements: { seats: 5 } });
  await issue(app, { entitlements: { seats: 10, exports: true } });
  await issue(app, { entitlements: { seat: 3 } });
  const revoked = await issue(app, { entitlements: { seats: 5 } });
  await app.inject({
    method: "POST",
    url: `/admin/licenses/${revoked.license.id}/revoke`,
    headers: auth,
  });

  const response = await app.inject({ method: "GET", url: "/admin/entitlements", headers: auth });
  assert.equal(response.statusCode, 200);
  const { catalog, licensesScanned } = response.json();
  assert.equal(licensesScanned, 4);

  const byName = Object.fromEntries(catalog.map((entry: { name: string }) => [entry.name, entry]));
  assert.equal(byName.seats.licenseCount, 3);
  // The revoked license still carries the entitlement but is no longer in play.
  assert.equal(byName.seats.activeLicenseCount, 2);
  assert.deepEqual(byName.seats.types, ["number"]);
  // `seat` and `seats` stay separate keys — the console flags the resemblance,
  // but the server must not guess that they are the same thing.
  assert.equal(byName.seat.licenseCount, 1);
  assert.deepEqual(byName.exports.types, ["boolean"]);

  const anonymous = await app.inject({ method: "GET", url: "/admin/entitlements" });
  assert.equal(anonymous.statusCode, 401);
});

/**
 * One key holding a number on one license and a string on another is the bug
 * this page exists for: an app comparing `seats >= n` handles some licenses and
 * silently ignores the rest, and nothing per-license looks wrong.
 */
test("a key used with two different types is reported as both", async () => {
  const { app } = await makeApp();
  await issue(app, { entitlements: { seats: 5 } });
  await issue(app, { entitlements: { seats: "12" } });

  const response = await app.inject({ method: "GET", url: "/admin/entitlements", headers: auth });
  const seats = response.json().catalog.find((entry: { name: string }) => entry.name === "seats");
  assert.deepEqual(seats.types, ["number", "string"]);
  assert.equal(seats.licenseCount, 2);
  assert.deepEqual(seats.values.map((value: { value: string }) => value.value).sort(), ["12", "5"]);
});
