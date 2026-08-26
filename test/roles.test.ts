import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import SQLite from "better-sqlite3";
import type { FastifyInstance } from "fastify";

import { buildLicenseApp } from "../src/app.js";
import { createAuth, ensureAuthSchema, seedOperator } from "../src/auth.js";
import { configSchema } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { resolveAdminFeatures } from "../src/permissions.js";
import { generateSigningKeyPair } from "../src/sign.js";

/**
 * Role enforcement lives on the server, so these tests drive the HTTP surface
 * with real session cookies rather than asserting on UI state.
 */

const { privateKey } = generateSigningKeyPair();
const SECRET = "roles-test-secret-0123456789abcdef0123456789";
const BASE_URL = "http://localhost";

interface Harness {
  app: FastifyInstance;
  cleanup: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<string>;
  authDbPath: string;
}

async function makeHarness(
  configOverride: Record<string, unknown> = {},
  seed: (authDbPath: string) => Promise<void> = async () => {},
): Promise<Harness> {
  const authDbPath = join(tmpdir(), `keyforge-roles-${randomUUID()}.sqlite`);
  await seed(authDbPath);
  const auth = createAuth({ dbPath: authDbPath, secret: SECRET, baseURL: BASE_URL });
  await ensureAuthSchema(auth);
  const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  const app = await buildLicenseApp({
    database,
    privateKey,
    adminToken: "cli-token",
    auth,
    authDbPath,
    config: configSchema.parse({ limits: { enabled: false }, ...configOverride }),
  });

  const signIn = async (email: string, password: string): Promise<string> => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: BASE_URL, host: "localhost" },
      payload: { email, password },
    });
    assert.equal(response.statusCode, 200, `sign-in for ${email}: ${response.body}`);
    const cookies = response.headers["set-cookie"];
    const list = Array.isArray(cookies) ? cookies : [cookies];
    const session = list.find((c) => String(c).includes("session_token"));
    assert.ok(session, "sign-in must set a session cookie");
    return String(session).split(";")[0];
  };

  return {
    app,
    authDbPath,
    signIn,
    cleanup: async () => {
      await app.close();
      await database.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        await rm(`${authDbPath}${suffix}`, { force: true });
      }
    },
  };
}

/** Seeds an admin and a support operator through the running app. */
async function seedOperators(h: Harness) {
  const adminCookie = await h.signIn("boss@example.com", "admin-password-1");
  const created = await h.app.inject({
    method: "POST",
    url: "/api/auth/admin/create-user",
    headers: { cookie: adminCookie, origin: BASE_URL, host: "localhost" },
    payload: {
      email: "helper@example.com",
      password: "support-password-1",
      name: "Helper",
      role: "support",
    },
  });
  assert.equal(created.statusCode, 200, `create-user: ${created.body}`);
  const supportCookie = await h.signIn("helper@example.com", "support-password-1");
  return { adminCookie, supportCookie };
}

const bootstrap = async (authDbPath: string) => {
  await seedOperator({
    dbPath: authDbPath,
    secret: SECRET,
    baseURL: BASE_URL,
    email: "boss@example.com",
    password: "admin-password-1",
  });
};

test("support is refused every license mutation, admin is allowed", async () => {
  const h = await makeHarness({}, bootstrap);
  try {
    const { adminCookie, supportCookie } = await seedOperators(h);

    // Admin can issue; support cannot.
    const issued = await h.app.inject({
      method: "POST",
      url: "/admin/licenses",
      headers: { cookie: adminCookie },
      payload: { issuedTo: "Customer", entitlements: { seats: 2 } },
    });
    assert.equal(issued.statusCode, 201);
    const licenseId = issued.json().license.id;

    const refusedIssue = await h.app.inject({
      method: "POST",
      url: "/admin/licenses",
      headers: { cookie: supportCookie },
      payload: { issuedTo: "Sneaky" },
    });
    assert.equal(refusedIssue.statusCode, 403);
    assert.equal(refusedIssue.json().error, "insufficient_role");

    for (const call of [
      { method: "PATCH" as const, url: `/admin/licenses/${licenseId}`, payload: { issuedTo: "x" } },
      { method: "POST" as const, url: `/admin/licenses/${licenseId}/revoke`, payload: {} },
    ]) {
      const response = await h.app.inject({ ...call, headers: { cookie: supportCookie } });
      assert.equal(response.statusCode, 403, `${call.method} ${call.url}`);
    }

    const refusedBackup = await h.app.inject({
      method: "GET",
      url: "/admin/backup/licenses",
      headers: { cookie: supportCookie },
    });
    assert.equal(refusedBackup.statusCode, 403);
  } finally {
    await h.cleanup();
  }
});

test("support can read everything and release a seat", async () => {
  const h = await makeHarness({}, bootstrap);
  try {
    const { adminCookie, supportCookie } = await seedOperators(h);
    const issued = await h.app.inject({
      method: "POST",
      url: "/admin/licenses",
      headers: { cookie: adminCookie },
      payload: { issuedTo: "Customer" },
    });
    const { license, key } = issued.json();
    await h.app.inject({
      method: "POST",
      url: "/v1/activate",
      payload: { key, installationId: "machine-1" },
    });

    for (const url of [
      "/admin/licenses",
      `/admin/licenses/${license.id}`,
      `/admin/licenses/${license.id}/activations`,
      "/admin/installations",
      "/admin/audit",
      "/admin/config",
    ]) {
      const response = await h.app.inject({
        method: "GET",
        url,
        headers: { cookie: supportCookie },
      });
      assert.equal(response.statusCode, 200, `support GET ${url}`);
    }

    // The seat transfer a support desk actually needs to perform.
    const released = await h.app.inject({
      method: "POST",
      url: `/admin/licenses/${license.id}/deactivate`,
      headers: { cookie: supportCookie },
      payload: { installationId: "machine-1" },
    });
    assert.equal(released.statusCode, 200);
  } finally {
    await h.cleanup();
  }
});

test("/admin/config reports the viewer's own role", async () => {
  const h = await makeHarness({}, bootstrap);
  try {
    const { adminCookie, supportCookie } = await seedOperators(h);
    const asAdmin = await h.app.inject({
      method: "GET",
      url: "/admin/config",
      headers: { cookie: adminCookie },
    });
    assert.equal(asAdmin.json().viewer.role, "admin");

    const asSupport = await h.app.inject({
      method: "GET",
      url: "/admin/config",
      headers: { cookie: supportCookie },
    });
    assert.equal(asSupport.json().viewer.role, "support");

    // The CLI token predates roles and stays an admin.
    const asCli = await h.app.inject({
      method: "GET",
      url: "/admin/config",
      headers: { authorization: "Bearer cli-token" },
    });
    assert.equal(asCli.json().viewer.role, "admin");
    assert.equal(asCli.json().viewer.actor, "cli");
  } finally {
    await h.cleanup();
  }
});

test("operators created before roles existed are restored to admin, not demoted", async () => {
  // A pre-M3 auth database: Better Auth's own tables, no role column at all.
  const legacyPath = join(tmpdir(), `keyforge-legacy-auth-${randomUUID()}.sqlite`);
  const legacy = new SQLite(legacyPath);
  legacy.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      createdAt DATE NOT NULL,
      updatedAt DATE NOT NULL
    );
    INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES ('old-1', 'Founder', 'founder@example.com', 1, '2025-01-01', '2025-01-01');
  `);
  legacy.close();

  try {
    const auth = createAuth({ dbPath: legacyPath, secret: SECRET, baseURL: BASE_URL });
    const promoted = await ensureAuthSchema(auth);
    assert.equal(promoted, 1, "the pre-roles operator should be promoted");

    const context = await auth.$context;
    const user = (await context.adapter.findOne({
      model: "user",
      where: [{ field: "email", value: "founder@example.com" }],
    })) as { role?: string } | null;
    assert.equal(user?.role, "admin", "an operator who had full access must keep it");

    // Booting again promotes nobody — the backfill is idempotent.
    assert.equal(await ensureAuthSchema(auth), 0);
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      await rm(`${legacyPath}${suffix}`, { force: true });
    }
  }
});

test("auth.admin scope decides which admin endpoints exist", async () => {
  const core = await makeHarness({ auth: { admin: "core" } }, bootstrap);
  try {
    const cookie = await core.signIn("boss@example.com", "admin-password-1");
    const impersonate = await core.app.inject({
      method: "POST",
      url: "/api/auth/admin/impersonate-user",
      headers: { cookie, origin: BASE_URL, host: "localhost" },
      payload: { userId: "whoever" },
    });
    assert.equal(impersonate.statusCode, 404);
    assert.equal(impersonate.json().error, "admin_feature_disabled");

    // "core" still includes operator management.
    const list = await core.app.inject({
      method: "GET",
      url: "/api/auth/admin/list-users?limit=10",
      headers: { cookie, origin: BASE_URL, host: "localhost" },
    });
    assert.equal(list.statusCode, 200);
  } finally {
    await core.cleanup();
  }

  const full = await makeHarness({ auth: { admin: "full" } }, bootstrap);
  try {
    const cookie = await full.signIn("boss@example.com", "admin-password-1");
    const impersonate = await full.app.inject({
      method: "POST",
      url: "/api/auth/admin/impersonate-user",
      headers: { cookie, origin: BASE_URL, host: "localhost" },
      payload: { userId: "whoever" },
    });
    // The plugin also answers 404 for a user that does not exist, so status
    // alone cannot tell "feature switched off" from "no such user" — the error
    // code is what distinguishes the gate from the plugin behind it.
    assert.notEqual(
      impersonate.json().error,
      "admin_feature_disabled",
      "with full scope the request must reach the plugin, not the feature gate",
    );
  } finally {
    await full.cleanup();
  }
});

test("an unknown auth.admin feature name is a startup error", () => {
  assert.deepEqual([...resolveAdminFeatures("core")], ["operators", "sessions"]);
  assert.equal(resolveAdminFeatures("full").size, 4);
  assert.deepEqual([...resolveAdminFeatures(["bans"])], ["bans"]);
  assert.throws(() => resolveAdminFeatures(["operators", "telepathy"]), /telepathy/);
});
