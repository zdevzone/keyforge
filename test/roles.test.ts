import assert from "node:assert/strict";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import SQLite from "better-sqlite3";
import type { FastifyInstance } from "fastify";

import { buildLicenseApp } from "../src/app.js";
import { closeAuth, createAuth, ensureAuthSchema, seedOperator } from "../src/auth.js";
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
    keyring: { active: "test", keys: { test: randomBytes(32).toString("hex") } },
    adminToken: "cli-token",
    auth,
    authDbPath,
    config: configSchema.parse({ limits: { enabled: false }, ...configOverride }),
  });

  await app.inject({
    method: "PUT",
    url: "/admin/products/default/finance/prices/__product__",
    headers: { authorization: "Bearer cli-token" },
    payload: { amount: 0 },
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
      await closeAuth(auth);
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

test("notification history and bulk actions are personal to each operator, including support", async () => {
  const h = await makeHarness({}, bootstrap);
  try {
    const { adminCookie, supportCookie } = await seedOperators(h);
    const plan = (
      await h.app.inject({
        url: "/admin/products/default/catalog",
        headers: { cookie: adminCookie },
      })
    )
      .json()
      .plans.find((p: any) => p.id === "standard");
    await h.app.inject({
      method: "PUT",
      url: "/admin/products/default/plans/standard",
      headers: { cookie: adminCookie },
      payload: { ...plan, durationDays: 5 },
    });
    const issued = await h.app.inject({
      method: "POST",
      url: "/admin/products/default/licenses",
      headers: { cookie: adminCookie },
      payload: {
        requestId: randomUUID(),
        plan: "standard",
        issuedTo: "Notification customer",
      },
    });
    assert.equal(issued.statusCode, 201);
    const get = async (cookie: string) =>
      (
        await h.app.inject({ url: "/admin/products/default/notifications", headers: { cookie } })
      ).json().items;
    const adminItems = await get(adminCookie),
      supportItems = await get(supportCookie);
    assert.ok(adminItems.length && supportItems.length);
    const marked = await h.app.inject({
      method: "POST",
      url: "/admin/products/default/notifications/bulk",
      headers: { cookie: supportCookie },
      payload: { action: "read", scope: "all" },
    });
    assert.equal(marked.statusCode, 200);
    assert.ok((await get(supportCookie)).every((n: any) => n.read));
    assert.ok((await get(adminCookie)).every((n: any) => !n.read));
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: "/admin/products/default/notifications/bulk",
          headers: { cookie: supportCookie },
          payload: { action: "delete", scope: "all", confirmed: true },
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(await get(supportCookie), []);
    assert.equal((await get(adminCookie)).length, adminItems.length);
    assert.equal(
      (
        await h.app.inject({
          url: "/admin/products/default/licenses/" + issued.json().license.id,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
      200,
    );
  } finally {
    await h.cleanup();
  }
});

test("support is refused every license mutation, admin is allowed", async () => {
  const h = await makeHarness({}, bootstrap);
  try {
    const { adminCookie, supportCookie } = await seedOperators(h);

    // Admin can issue; support cannot.
    const issued = await h.app.inject({
      method: "POST",
      url: "/admin/products/default/licenses",
      headers: { cookie: adminCookie },
      payload: { requestId: randomUUID(), plan: "standard", issuedTo: "Customer" },
    });
    assert.equal(issued.statusCode, 201);
    const licenseId = issued.json().license.id;

    const refusedIssue = await h.app.inject({
      method: "POST",
      url: "/admin/products/default/licenses",
      headers: { cookie: supportCookie },
      payload: { issuedTo: "Sneaky" },
    });
    assert.equal(refusedIssue.statusCode, 403);
    assert.equal(refusedIssue.json().error, "insufficient_role");

    for (const call of [
      {
        method: "PATCH" as const,
        url: `/admin/products/default/licenses/${licenseId}`,
        payload: { issuedTo: "x" },
      },
      {
        method: "POST" as const,
        url: `/admin/products/default/licenses/${licenseId}/revoke`,
        payload: {},
      },
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
    for (const call of [
      { method: "GET" as const, url: "/admin/backups" },
      {
        method: "POST" as const,
        url: "/admin/backups/destinations",
        payload: { name: "Denied", url: "http://localhost/upload" },
      },
      {
        method: "PUT" as const,
        url: "/admin/backups/destinations/local/schedule",
        payload: { enabled: false, hourUTC: 2, retentionDays: 30 },
      },
    ])
      assert.equal(
        (await h.app.inject({ ...call, headers: { cookie: supportCookie } })).statusCode,
        403,
      );
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
      url: "/admin/products/default/licenses",
      headers: { cookie: adminCookie },
      payload: { requestId: randomUUID(), plan: "standard", issuedTo: "Customer" },
    });
    const { license, key } = issued.json();
    const installationSecret = randomBytes(32).toString("base64url");
    await h.app.inject({
      method: "POST",
      url: "/v1/products/default/register",
      headers: { authorization: "Bearer " + installationSecret },
      payload: { installationId: "machine-1", requestId: randomUUID() },
    });
    await h.app.inject({
      method: "POST",
      headers: { authorization: "Bearer " + installationSecret },
      url: "/v1/products/default/activate",
      payload: { key, installationId: "machine-1" },
    });

    for (const url of [
      "/admin/products/default/licenses",
      `/admin/products/default/licenses/${license.id}`,
      `/admin/products/default/licenses/${license.id}/activations`,
      "/admin/products/default/installations",
      "/admin/products/default/machines",
      "/admin/products/default/support",
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
      url: `/admin/products/default/licenses/${license.id}/deactivate`,
      headers: { cookie: supportCookie },
      payload: { installationId: "machine-1" },
    });
    assert.equal(released.statusCode, 200);
  } finally {
    await h.cleanup();
  }
});

/**
 * Clearing a machine is a support gesture, not an admin one. Gating it behind
 * the admin role would leave the people who actually answer the "my trial says
 * it is used up" call unable to do anything about it.
 */
test("support can clear a machine's trial", async () => {
  const h = await makeHarness({}, bootstrap);
  try {
    const { supportCookie } = await seedOperators(h);
    const hash = (label: string) => createHash("sha256").update(label).digest("hex");
    const machineSignals = [
      { kind: "machine-guid", hash: hash("guid-a") },
      { kind: "smbios-uuid", hash: hash("smbios-a") },
    ];
    for (const installationId of ["install-1", "install-2"]) {
      await h.app.inject({
        method: "POST",
        url: "/v1/products/default/register",
        headers: { authorization: "Bearer " + randomBytes(32).toString("base64url") },
        payload: { installationId, machineSignals, requestId: randomUUID() },
      });
    }

    const listed = await h.app.inject({
      method: "GET",
      url: "/admin/products/default/machines",
      headers: { cookie: supportCookie },
    });
    const [machine] = listed.json().machines;
    assert.equal(machine.trialState, "spent");

    const cleared = await h.app.inject({
      method: "POST",
      url: `/admin/products/default/machines/${machine.id}/clear`,
      headers: { cookie: supportCookie },
      payload: {},
    });
    assert.equal(cleared.statusCode, 200);

    // Attributed to the operator who did it, not to a shared "cli".
    const audit = await h.app.inject({
      method: "GET",
      url: "/admin/audit",
      headers: { cookie: supportCookie },
    });
    const entry = audit
      .json()
      .entries.find((row: { action: string }) => row.action === "machine.clear");
    assert.ok(entry, "the clear should be audited");
    assert.equal(entry.actor, "helper@example.com");
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
    CREATE TABLE keyforge_auth_user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      createdAt DATE NOT NULL,
      updatedAt DATE NOT NULL
    );
    INSERT INTO keyforge_auth_user (id, name, email, emailVerified, createdAt, updatedAt)
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
    await closeAuth(auth);
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

test("profile uploads and product reports preserve session and product boundaries", async () => {
  const h = await makeHarness({}, bootstrap);
  try {
    const { adminCookie, supportCookie } = await seedOperators(h);
    const headers = { cookie: supportCookie, origin: BASE_URL, host: "localhost" };
    const image =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
    const uploaded = await h.app.inject({
      method: "POST",
      url: "/api/auth/update-user",
      headers,
      payload: { image },
    });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const session = await h.app.inject({ url: "/api/auth/get-session", headers });
    assert.equal(session.json().user.image, image);
    const rejected = await h.app.inject({
      method: "POST",
      url: "/api/auth/update-user",
      headers,
      payload: { image: "data:image/svg+xml;base64,PHN2Zz4=" },
    });
    assert.equal(rejected.statusCode, 400);
    const changedRole = await h.app.inject({
      method: "POST",
      url: "/api/auth/update-user",
      headers,
      payload: { image, role: "admin" },
    });
    assert.equal(changedRole.statusCode, 400);
    const issue = await h.app.inject({
      method: "POST",
      url: "/admin/products/default/licenses",
      headers: { cookie: adminCookie },
      payload: { requestId: randomUUID(), plan: "standard", issuedTo: "Report customer" },
    });
    assert.equal(issue.statusCode, 201, issue.body);
    const report = await h.app.inject({
      url: "/admin/products/default/reports?type=licenses&customer=Report",
      headers,
    });
    assert.equal(report.statusCode, 200, report.body);
    assert.equal(report.json().rows.length, 1);
    assert.equal(report.body.includes("encryptedKey"), false);
    assert.equal(report.body.includes("keyHash"), false);
    assert.equal((await h.app.inject({ url: "/admin/products/default/reports" })).statusCode, 401);
    const product = await h.app.inject({
      method: "POST",
      url: "/admin/products",
      headers: { cookie: adminCookie },
      payload: { id: "other", name: "Other" },
    });
    assert.equal(product.statusCode, 200, product.body);
    const other = await h.app.inject({ url: "/admin/products/other/reports", headers });
    assert.equal(other.json().rows.length, 0);
    const audit = await h.app.inject({ url: "/admin/audit?limit=200", headers });
    const count = audit.json().entries.length;
    assert.ok(count > 0);
    const exactPage = await h.app.inject({ url: `/admin/audit?limit=${count}`, headers });
    assert.equal(
      exactPage.json().nextBefore,
      null,
      "A full final page must not advertise an empty next page",
    );
  } finally {
    await h.cleanup();
  }
});

test("ETB financial ledger separates sales, receipts, refunds and credits with admin-only access", async () => {
  const h = await makeHarness({}, bootstrap);
  try {
    const { adminCookie, supportCookie } = await seedOperators(h);
    const headers = { cookie: adminCookie };
    const base = "/admin/products/default/finance";
    const supportCatalog = (
      await h.app.inject({
        url: "/admin/products/default/catalog",
        headers: { cookie: supportCookie },
      })
    ).json();
    assert.ok(supportCatalog.plans.every((p: any) => p.price === undefined));
    const issued = await h.app.inject({
      method: "POST",
      url: "/admin/products/default/licenses",
      headers,
      payload: { requestId: randomUUID(), plan: "standard", issuedTo: "Finance customer" },
    });
    assert.equal(issued.statusCode, 201, issued.body);
    const licenseId = issued.json().license.id;
    assert.equal(
      (await h.app.inject({ url: base, headers }))
        .json()
        .licenses.find((l: any) => l.id === licenseId).hasSale,
      true,
    );
    for (const url of [base, base + "/report"])
      assert.equal(
        (await h.app.inject({ url, headers: { cookie: supportCookie } })).statusCode,
        403,
      );
    assert.equal(
      (
        await h.app.inject({
          method: "PUT",
          url: base + "/prices/__product__",
          headers,
          payload: { amount: 10000 },
        })
      ).statusCode,
      200,
    );
    const payload = {
      requestId: randomUUID(),
      licenseId,
      kind: "renewal",
      date: "2026-01-01",
      listAmount: 10000,
      discount: 1000,
      amount: 9000,
    };
    const sale = await h.app.inject({ method: "POST", url: base + "/sales", headers, payload });
    assert.equal(sale.statusCode, 200, sale.body);
    const saleId = sale.json().sale.id;
    assert.equal(
      (await h.app.inject({ method: "POST", url: base + "/sales", headers, payload })).json().sale
        .id,
      saleId,
    );
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: base + "/sales",
          headers,
          payload: { ...payload, amount: 8000, discount: 2000 },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: base + "/sales",
          headers: { cookie: supportCookie },
          payload,
        })
      ).statusCode,
      403,
    );
    const url = base + "/sales/" + saleId + "/entries";
    const pay = {
      requestId: randomUUID(),
      kind: "payment",
      amount: 6000,
      date: "2026-01-02",
      method: "Bank transfer",
      reference: "B-1",
    };
    const receipt = await h.app.inject({ method: "POST", url, headers, payload: pay });
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(
      (await h.app.inject({ method: "POST", url, headers, payload: pay })).statusCode,
      200,
    );
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...pay, requestId: randomUUID(), amount: 4000 },
        })
      ).statusCode,
      400,
    );
    const refund = {
      requestId: randomUUID(),
      kind: "refund",
      amount: 2000,
      date: "2026-01-03",
      paymentId: receipt.json().entry.id,
      reason: "Partial return",
    };
    assert.equal(
      (await h.app.inject({ method: "POST", url, headers, payload: refund })).statusCode,
      200,
    );
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url,
          headers,
          payload: { ...refund, requestId: randomUUID(), amount: 5000 },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url,
          headers,
          payload: {
            requestId: randomUUID(),
            kind: "credit",
            amount: 2000,
            date: "2026-01-03",
            reason: "Cancelled portion",
          },
        })
      ).statusCode,
      200,
    );
    const report = (
      await h.app.inject({ url: base + "/report?from=2026-01-02&to=2026-01-03", headers })
    ).json();
    assert.equal(report.salesValue, 0);
    assert.equal(report.received, 6000);
    assert.equal(report.refunds, 2000);
    assert.equal(report.netReceived, 4000);
    assert.equal(report.outstanding, 3000);
    assert.equal(
      (await h.app.inject({ url: base + "/report?to=2026-01-01", headers })).json().outstanding,
      9000,
    );
    await h.app.inject({
      method: "PUT",
      url: base + "/prices/__product__",
      headers,
      payload: { amount: 20000 },
    });
    assert.equal(
      (await h.app.inject({ url: base, headers })).json().sales.find((s: any) => s.id === saleId)
        .amount,
      9000,
    );
    const renewal = await h.app.inject({
      method: "POST",
      url: base + "/sales",
      headers,
      payload: { ...payload, requestId: randomUUID(), kind: "renewal", date: "2026-02-01" },
    });
    assert.equal(renewal.statusCode, 200, renewal.body);
    const after = (
      await h.app.inject({ url: "/admin/products/default/licenses/" + licenseId, headers })
    ).json().license;
    assert.equal(after.expiresAt, issued.json().license.expiresAt);
    assert.equal(after.status, "active");
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: base + "/sales",
          headers,
          payload: { ...payload, requestId: randomUUID(), currency: "USD" },
        })
      ).statusCode,
      400,
    );
  } finally {
    await h.cleanup();
  }
});
