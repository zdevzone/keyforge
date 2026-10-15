import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, join } from "node:path";

import { chromium } from "playwright";

import { workspacePath } from "../dist/src/maintenance.js";

const manifest = JSON.parse(await readFile(".artifacts/demo/manifest.json", "utf8"));
const origin = process.env.LICENSE_SERVER_URL || process.env.RENDER_EXTERNAL_URL || manifest.origin;
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname) || manifest.version !== 1)
  throw Error("Feature checks require the local seeded demo.");
const artifacts = resolve(".artifacts/feature-checks");
await mkdir(artifacts, { recursive: true });
const secrets = [
  ...Object.values(manifest.operators).map((o) => o.password),
  ...manifest.licenses.map((l) => l.key),
  ...manifest.installations.map((i) => i.secret),
  ...manifest.credentials.map((c) => c.secret),
].filter(Boolean);
const safe = (value) =>
  secrets.reduce((v, s) => v.replaceAll(s, "[redacted]"), String(value)).slice(0, 1800);
const reusePages = process.argv.includes("--reuse-coverage");
const reuse = reusePages || process.argv.includes("--reuse-backups");
const previous = reuse ? JSON.parse(await readFile(join(artifacts, "report.json"), "utf8")) : null;
const reusable = new Set([
  "all detected real backup providers upload, download and verify",
  "custom anonymous multipart/raw uploads and failure downloads",
  "independent UTC schedules and a real scheduled local backup",
  "raw SQLite manual console downloads",
]);
const report = {
  origin,
  startedAt: new Date().toISOString(),
  pages: [],
  checks: [],
  browserErrors: [],
};
const runId = randomBytes(4).toString("hex");
const productId = "browser-product-" + runId,
  meterId = "browser-meter-" + runId,
  importedId = "browser-imported-" + runId,
  operatorEmail = "browser.operator." + runId + "@keyforge.test",
  productName = "Browser product " + runId,
  serviceName = "Browser service " + runId;
if (reuse) {
  report.pages = reusePages ? previous.pages : [];
  report.checks = previous.checks.filter(
    (c) =>
      c.status === "passed" &&
      ((reusePages && (c.name.startsWith("desktop page ") || c.name.startsWith("mobile page "))) ||
        c.name.startsWith("real ") ||
        reusable.has(c.name)),
  );
  report.coverageReusedFrom = previous.startedAt;
}
const uploaded = [];
const uploadServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  uploaded.push({ path: req.url, method: req.method, bytes: Buffer.concat(chunks) });
  res.writeHead(req.url === "/fail" ? 503 : 201);
  res.end();
});
await new Promise((done) => uploadServer.listen(0, "127.0.0.1", done));
const uploadURL = "http://127.0.0.1:" + uploadServer.address().port;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.setDefaultTimeout(12000);
page.on("pageerror", (e) => report.browserErrors.push(safe(e.message)));
page.on("dialog", (dialog) => dialog.accept());
const check = async (name, work) => {
  if (
    reuse &&
    reusable.has(name) &&
    report.checks.some((c) => c.name === name && c.status === "passed")
  )
    return;
  const start = Date.now();
  try {
    const value = await work();
    report.checks.push({ name, status: "passed", milliseconds: Date.now() - start });
    console.log("PASS " + name);
    return value;
  } catch (error) {
    report.checks.push({ name, status: "failed", error: safe(error.message) });
    console.log("FAIL " + name + ": " + safe(error.message));
    await page.keyboard.press("Escape").catch(() => {});
    return undefined;
  }
};
const api = async (method, path, body, secret) => {
  const response = await context.request.fetch(origin + path, {
    method,
    data: body,
    headers: { origin, ...(secret ? { authorization: "Bearer " + secret } : {}) },
  });
  if (!response.ok())
    throw Error("HTTP " + response.status() + " " + path + ": " + safe(await response.text()));
  return response.json();
};
const go = async (path) => {
  await page.goto(origin + path);
  await page.locator("main h1").first().waitFor();
  await page
    .getByRole("status")
    .waitFor({ state: "hidden", timeout: 12000 })
    .catch(() => {});
};
const choose = async (id) => {
  await page.getByRole("combobox", { name: "Product" }).selectOption(id);
};
const login = async (operator) => {
  await page.goto(origin + "/login");
  await page.getByLabel("Email", { exact: true }).fill(operator.email);
  await page.getByLabel("Password", { exact: true }).fill(operator.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Open account menu" }).waitFor();
};
const card = (heading) =>
  page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const waitJob = async (id) => {
  for (let i = 0; i < 100; i++) {
    const state = await api("GET", "/admin/backups");
    const job = state.jobs.find((j) => j.id === id);
    if (job && ["completed", "failed"].includes(job.status)) return job;
    await pause(1000);
  }
  throw Error("Backup did not finish.");
};
let extraContext;
try {
  await login(manifest.operators.admin);
  await check("health, console and authenticated admin API", async () => {
    assert.equal((await api("GET", "/healthz")).ok, true);
    assert.equal((await api("GET", "/admin/config")).viewer.role, "admin");
  });
  const routes = [
    "/",
    "/products",
    "/entitlements",
    "/metering",
    "/installations",
    "/machines",
    "/support",
    "/audit",
    "/operators",
    "/profile",
    "/settings",
    "/inspect",
    "/backups",
    "/system",
    "/help",
    "/licenses/" + manifest.licenses[0].license.id,
    "/support/" + manifest.support[0].id,
  ];
  for (const width of reusePages ? [] : [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const route of routes)
      await check((width === 390 ? "mobile" : "desktop") + " page " + route, async () => {
        await go(route);
        assert.equal(await page.locator("main h1").count(), 1);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          "page overflows",
        );
        const filename =
          (route === "/" ? "licenses" : route.slice(1).replaceAll("/", "-")) + "-" + width + ".png";
        await page.screenshot({ path: join(artifacts, filename), fullPage: true });
        report.pages.push({ route, width, screenshot: filename });
      });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await check("mobile drawer closes after navigation", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await go("/profile");
    await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
    await page.getByRole("link", { name: "Support", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await check("account menu profile/security/help links and role", async () => {
    await go("/");
    await page.getByRole("button", { name: "Open account menu" }).click();
    for (const name of [
      "Profile",
      "Account security",
      "Service settings",
      "Help & documentation",
      "Sign out",
    ])
      assert.equal(await page.getByRole("menuitem", { name, exact: true }).count(), 1);
    await page.keyboard.press("Escape");
  });
  await check("profile contact and timezone save", async () => {
    await go("/profile");
    await page.getByLabel("Phone", { exact: true }).fill("+251 555 0100");
    await page.getByLabel("Job title", { exact: true }).fill("Demo operator");
    await page.getByLabel("Timezone", { exact: true }).fill("Africa/Nairobi");
    await page.getByRole("button", { name: "Save profile", exact: true }).click();
    await page.getByText("Saved.", { exact: true }).waitFor();
  });
  await check("own sessions revoke another device", async () => {
    extraContext = await browser.newContext({ userAgent: "Keyforge feature peer " + runId });
    const response = await extraContext.request.post(origin + "/api/auth/sign-in/email", {
      data: manifest.operators.admin,
      headers: { origin },
    });
    assert.equal(response.status(), 200);
    const peer = (await response.json()).token;
    await go("/profile");
    const rows = page
      .locator("main li")
      .filter({ has: page.getByRole("button", { name: "Revoke session", exact: true }) });
    assert.ok((await rows.count()) >= 2);
    const sessions = await api("GET", "/api/auth/list-sessions");
    const other = sessions.find((s) => s.token === peer);
    assert.ok(other);
    await rows
      .filter({ hasText: other.userAgent })
      .getByRole("button", { name: "Revoke session", exact: true })
      .click();
    await page.getByText("Session revoked.", { exact: true }).waitFor();
    assert.equal(
      await (await extraContext.request.get(origin + "/api/auth/get-session")).json(),
      null,
    );
  });
  await check("license filters and empty search", async () => {
    await go("/");
    await page.getByRole("button", { name: "Expired", exact: true }).click();
    await page.getByText("Expired Evaluation", { exact: true }).waitFor();
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByPlaceholder("Search by customer, plan or id…").fill("no-such-demo-customer");
    await page.getByText(/No licenses/).waitFor();
    await page.getByPlaceholder("Search by customer, plan or id…").fill("");
    await page.getByText("Acme Design", { exact: true }).waitFor();
  });
  const suffix = randomBytes(4).toString("hex");
  const quota = "browser-quota-" + suffix,
    planId = "browser-plan-" + suffix;
  await check("entitlement definition create", async () => {
    await go("/entitlements");
    await page.getByRole("button", { name: "Add entitlement", exact: true }).click();
    const editor = card("Add entitlement");
    await editor.getByLabel("Permanent key").fill(quota);
    await editor.getByLabel("Description", { exact: true }).fill("Browser tested quota");
    await editor.getByLabel("Default value (optional)", { exact: true }).fill("8");
    await editor.getByLabel("Maximum (optional)", { exact: true }).fill("100");
    await editor.getByRole("button", { name: "Save entitlement", exact: true }).click();
    await page.getByText(quota, { exact: true }).waitFor();
  });
  await check("plan create with typed entitlement and usage tab", async () => {
    await page.getByRole("tab", { name: "Plans", exact: true }).click();
    await page.getByRole("button", { name: "Add plan", exact: true }).click();
    const editor = card("Add plan");
    await editor.getByLabel("Permanent plan ID").fill(planId);
    await editor.getByLabel("Description", { exact: true }).fill("Browser tested preset");
    await editor.getByRole("button", { name: "Add entitlement", exact: true }).click();
    await editor.getByLabel("Entitlement key").selectOption(quota);
    await editor.getByLabel("Entitlement value", { exact: true }).fill("100");
    await editor.getByLabel("Price (ETB)", { exact: true }).fill("1000");
    await editor.getByLabel("Activation seats", { exact: true }).fill("2");
    await editor.getByLabel("Duration days (empty for perpetual)", { exact: true }).fill("30");
    await editor.getByRole("button", { name: "Save plan", exact: true }).click();
    await page.getByText(planId, { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Usage", exact: true }).click();
    await page.getByRole("heading", { name: "Entitlement adoption", exact: true }).waitFor();
  });
  await check("catalog export and previewed import", async () => {
    await go("/entitlements");
    await page.getByText("Import or export catalog", { exact: true }).click();
    const event = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSON", exact: true }).click();
    const download = await event;
    const catalog = JSON.parse(await readFile(await download.path(), "utf8"));
    catalog.definitions.push({
      id: importedId,
      type: "boolean",
      description: "Imported browser flag",
      archived: false,
    });
    await page.getByLabel("Load catalog JSON").setInputFiles({
      name: "catalog.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(catalog)),
    });
    await page.getByRole("button", { name: "Preview import", exact: true }).click();
    await page.getByText("Preview ready.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Apply previewed changes", exact: true }).click();
    await page.getByText("Catalog imported.", { exact: true }).waitFor();
    assert.ok(
      (await api("GET", "/admin/products/default/catalog")).definitions.some(
        (d) => d.id === importedId,
      ),
    );
  });
  const issued = await check("issue license from a plan and save initial key", async () => {
    await go("/");
    await page.getByRole("button", { name: "Issue license", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Customer / delivery", exact: true }).click();
    await page
      .getByRole("option", { name: "Manual delivery / service customer", exact: true })
      .click();
    await dialog.getByLabel("Customer name", { exact: true }).fill("Browser verified customer");
    const planChoice = dialog.getByRole("combobox", { name: "Plan", exact: true });
    const searchable = await planChoice.evaluate((e) => e.tagName === "INPUT");
    await planChoice.click();
    if (searchable) await planChoice.fill(planId);
    await page.getByRole("option", { name: planId, exact: true }).click();
    const event = page.waitForResponse(
      (r) =>
        r.url().endsWith("/admin/products/default/licenses") && r.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Issue license", exact: true }).click();
    const result = await (await event).json();
    secrets.push(result.key);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    return result;
  });
  await check("license edit and password-confirmed product-key reveal/copy/hide", async () => {
    assert.ok(issued);
    await go("/licenses/" + issued.license.id);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("Customer", { exact: true })
      .fill("Browser verified customer edited");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Browser verified customer edited", exact: true })
      .waitFor();
    assert.equal(
      (await api("GET", "/admin/products/default/licenses/" + issued.license.id)).license.expiresAt,
      issued.license.expiresAt,
      "editing a customer must preserve expiry",
    );
    const keys = card("Product key");
    await keys
      .getByLabel("Current password", { exact: true })
      .fill(manifest.operators.admin.password);
    await keys.getByRole("button", { name: "Reveal key", exact: true }).click();
    await keys.getByText(issued.key, { exact: true }).waitFor();
    await keys.getByRole("button", { name: "Copy key", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), issued.key);
    await keys.getByRole("button", { name: "Hide", exact: true }).click();
  });
  const device = await check("dependent-app register, validate, activate and refresh", async () => {
    assert.ok(issued);
    const secret = randomBytes(32).toString("base64url"),
      id = "browser-" + randomUUID();
    secrets.push(secret);
    await api(
      "POST",
      "/v1/products/default/register",
      { installationId: id, requestId: randomUUID(), platform: "Windows", appVersion: "test" },
      secret,
    );
    assert.equal(
      (
        await api(
          "POST",
          "/v1/products/default/validate",
          { installationId: id, key: issued.key },
          secret,
        )
      ).valid,
      true,
    );
    const result = await api(
      "POST",
      "/v1/products/default/activate",
      { installationId: id, key: issued.key },
      secret,
    );
    assert.ok(result.token);
    assert.ok(
      (
        await api(
          "POST",
          "/v1/products/default/refresh",
          { installationId: id, licenseId: issued.license.id },
          secret,
        )
      ).token,
    );
    return { id, secret, token: result.token };
  });
  await check("token inspector validates an issued token", async () => {
    await go("/inspect");
    await page
      .getByLabel("Signed license or trial token")
      .fill(device?.token || manifest.installations[0].token);
    await page.getByRole("button", { name: "Verify and inspect", exact: true }).click();
    await page.getByText("Diagnostics complete.", { exact: true }).waitFor();
    await page.getByText("Verified", { exact: true }).waitFor();
  });
  await check("installations link to the manager's product key", async () => {
    await go("/installations");
    const row = page.getByRole("row").filter({ hasText: manifest.installations[0].installationId });
    assert.ok(await row.count());
    await row.locator('a[href^="/licenses/"]').click();
    await page.getByRole("heading", { name: "Product key", exact: true }).waitFor();
  });
  await check("activation release and dependent-app reactivation/deactivation", async () => {
    assert.ok(device);
    await go("/licenses/" + issued.license.id);
    await page.getByRole("button", { name: "Release", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Release seat", exact: true })
      .click();
    await page.getByText(/^released /).waitFor();
    await api(
      "POST",
      "/v1/products/default/activate",
      { installationId: device.id, key: issued.key },
      device.secret,
    );
    await api(
      "POST",
      "/v1/products/default/deactivate",
      { installationId: device.id, licenseId: issued.license.id },
      device.secret,
    );
  });
  await check("machine trial reset", async () => {
    await choose("default");
    const trial = manifest.installations.find((i) => i.trialToken);
    await api(
      "POST",
      "/v1/products/default/register",
      {
        installationId: trial.installationId,
        requestId: randomUUID(),
        machineSignals: ["machine-guid", "smbios-uuid"].map((kind) => ({
          kind,
          hash: createHash("sha256")
            .update(trial.installationId + kind)
            .digest("hex"),
        })),
      },
      trial.secret,
    );
    await go("/machines");
    await page
      .getByRole("row")
      .filter({ hasText: trial.installationId })
      .getByRole("button", { name: "Clear", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Clear machine", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  });
  await check("support assignment, status, customer reply and internal note", async () => {
    await go("/support/" + manifest.support[0].id);
    await page.getByLabel("Customer reply", { exact: true }).fill("Browser reply " + runId);
    await page.getByLabel("Status").selectOption("waiting_customer");
    await page.getByLabel("Assigned operator").selectOption(manifest.operators.support.email);
    await page.getByRole("button", { name: "Update request", exact: true }).click();
    await page.getByText("Request updated.", { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel("Customer reply", { exact: true }).inputValue(),
      "Browser reply " + runId,
    );
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await page.getByText("Browser reply " + runId, { exact: true }).waitFor();
    await page.getByLabel("Internal note — hidden from customers", { exact: true }).check();
    await page.getByLabel("Internal note", { exact: true }).fill("Browser private note " + runId);
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await page.getByText("Browser private note " + runId, { exact: true }).waitFor();
    const installation = manifest.installations[0];
    const customer = await api(
      "GET",
      "/v1/products/default/installations/" +
        installation.installationId +
        "/support/" +
        manifest.support[0].id,
      undefined,
      installation.secret,
    );
    assert.equal(JSON.stringify(customer).includes("Browser private note " + runId), false);
  });
  await check("meter create and real quota consumption", async () => {
    await go("/metering");
    await page.getByRole("button", { name: "Add meter", exact: true }).click();
    const editor = card("Meter definition");
    await editor.getByLabel("Permanent meter ID").fill(meterId);
    await editor.getByLabel("Numeric quota entitlement").selectOption(quota);
    await editor.getByRole("button", { name: "Save meter", exact: true }).click();
    await page.getByText(meterId, { exact: true }).waitFor();
    const cred = manifest.credentials.find((c) => c.productId === "default");
    const eventId = randomUUID();
    const a = await api(
      "POST",
      "/v1/products/default/usage/consume",
      { licenseId: issued.license.id, meterId, units: 3, eventId },
      cred.secret,
    );
    const b = await api(
      "POST",
      "/v1/products/default/usage/consume",
      { licenseId: issued.license.id, meterId, units: 3, eventId },
      cred.secret,
    );
    assert.deepEqual(a, b);
  });
  await check("catalog edits and archives preserve issued license snapshots", async () => {
    assert.ok(issued);
    await go("/entitlements");
    const definition = card("Defined entitlements")
      .locator(".py-4")
      .filter({ has: page.getByText(quota, { exact: true }) });
    await definition.getByRole("button", { name: "Edit", exact: true }).click();
    await card("Edit definition")
      .getByLabel("Description", { exact: true })
      .fill("Edited quota " + runId);
    await card("Edit definition")
      .getByRole("button", { name: "Save entitlement", exact: true })
      .click();
    await page.getByText("Edited quota " + runId + " · number", { exact: true }).waitFor();
    const imported = card("Defined entitlements")
      .locator(".py-4")
      .filter({ has: page.getByText(importedId, { exact: true }) });
    await imported.getByRole("button", { name: "Edit", exact: true }).click();
    await card("Edit definition").getByLabel("Archive definition").check();
    await card("Edit definition")
      .getByRole("button", { name: "Save entitlement", exact: true })
      .click();
    await card("Edit definition").waitFor({ state: "hidden" });
    await page.getByRole("tab", { name: "Plans", exact: true }).click();
    const plan = card("Plans")
      .locator(".py-4")
      .filter({ has: page.getByText(planId, { exact: true }) });
    await plan.getByRole("button", { name: "Edit", exact: true }).click();
    await card("Edit plan").getByLabel("Activation seats", { exact: true }).fill("3");
    await card("Edit plan").getByLabel("Archive plan").check();
    await card("Edit plan").getByRole("button", { name: "Save plan", exact: true }).click();
    await card("Edit plan").waitFor({ state: "hidden" });
    const catalog = await api("GET", "/admin/products/default/catalog");
    assert.equal(catalog.definitions.find((d) => d.id === importedId).archived, true);
    assert.equal(catalog.plans.find((p) => p.id === planId).archived, true);
    const license = (await api("GET", "/admin/products/default/licenses/" + issued.license.id))
      .license;
    assert.equal(license.activationLimit, 2);
    assert.equal(license.entitlements[quota], 100);
  });
  await check("service credential creation and revocation", async () => {
    await go("/metering");
    await page.getByLabel("Integration name", { exact: true }).fill(serviceName);
    await page.getByRole("button", { name: "Create usage credential", exact: true }).click();
    await page.getByText("Credential created. Copy it now.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Hide", exact: true }).click();
    const row = page.locator("li").filter({ hasText: serviceName });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await row.getByText("Revoked", { exact: true }).waitFor();
  });
  await check("product create, policy update and signing-key rotation", async () => {
    await go("/products");
    await page.getByLabel("Name", { exact: true }).last().fill(productName);
    await page.getByLabel("Permanent product ID").fill(productId);
    await page.getByRole("button", { name: "Create product", exact: true }).click();
    await page.getByRole("button", { name: productName, exact: true }).click();
    await page.getByLabel("Offline grace days", { exact: true }).fill("14");
    const savedPolicy = page.waitForResponse(
      (r) => r.url().endsWith("/admin/products/" + productId) && r.request().method() === "PATCH",
    );
    await page.getByRole("button", { name: "Save policy", exact: true }).click();
    assert.equal((await savedPolicy).status(), 200);
    await page.getByLabel("Offline grace days", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Stage new signing key", exact: true }).click();
    await page.getByText(/Staged/).waitFor();
    await page.getByLabel("Dependent apps now trust this public key").check();
    const activated = page.waitForResponse(
      (r) =>
        r.url().includes("/keys/") &&
        r.url().endsWith("/activate") &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Activate staged key", exact: true }).click();
    assert.equal((await activated).status(), 200);
    await page
      .getByText(/Active/)
      .first()
      .waitFor();
    const product = (await api("GET", "/admin/products")).products.find((p) => p.id === productId);
    assert.equal(
      product.keys.some((k) => k.pending),
      false,
    );
    assert.equal(product.graceDays, 14);
    await choose("default");
  });
  await check("operator create, role change, password reset, sessions and removal", async () => {
    await go("/operators");
    await page.getByRole("button", { name: "Add operator", exact: true }).click();
    const dialog = page.getByRole("dialog"),
      password = "Browser-test-password-2026!";
    secrets.push(password);
    await dialog.getByLabel("Email", { exact: true }).fill(operatorEmail);
    await dialog.getByLabel("Password", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "Add operator", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: operatorEmail });
    await row.waitFor();
    await row.getByRole("button", { name: "Make admin", exact: true }).click();
    await row.getByRole("button", { name: "Make support", exact: true }).waitFor();
    await row.getByRole("button", { name: "Set password", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByLabel("New password", { exact: true })
      .fill(password + "2");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Set password", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await row.getByRole("button", { name: "Sessions", exact: true }).click();
    await page.getByText("No active sessions.", { exact: true }).waitFor();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .first()
      .click();
    await row.getByRole("button", { name: "Remove", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove operator", exact: true })
      .click();
    await row.waitFor({ state: "hidden" });
  });
  await check("own password change and restore", async () => {
    const next = manifest.operators.admin.password + "-updated";
    secrets.push(next);
    for (const [current, value] of [
      [manifest.operators.admin.password, next],
      [next, manifest.operators.admin.password],
    ]) {
      await go("/settings");
      await page.getByLabel("Current password", { exact: true }).fill(current);
      await page.getByLabel("New password", { exact: true }).fill(value);
      await page.getByLabel("Confirm", { exact: true }).fill(value);
      await page.getByRole("button", { name: "Change password", exact: true }).click();
      await page.getByText(/Password changed/).waitFor();
    }
  });
  await check("license revoke", async () => {
    await go("/licenses/" + issued.license.id);
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Revoke license", exact: true })
      .click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      (await api("GET", "/admin/products/default/licenses/" + issued.license.id)).license.status,
      "revoked",
    );
  });
  await check("all detected real backup providers upload, download and verify", async () => {
    await go("/backups");
    for (const id of ["s3", "r2", "uploadthing"]) {
      const state = await api("GET", "/admin/backups"),
        provider = state.destinations.find((d) => d.id === id);
      assert.equal(provider.configured, true, id + " credentials not configured");
      const section = page.getByRole("region", { name: provider.name + " backup destination" });
      const response = page.waitForResponse(
        (r) => r.url().endsWith("/admin/backups") && r.request().method() === "POST",
      );
      await section.getByRole("button", { name: "Back up now", exact: true }).click();
      const initial = await (await response).json(),
        job = await waitJob(initial.job.id);
      assert.equal(job.status, "completed", id + ": " + job.error);
      const cache = await workspacePath(
        process.cwd(),
        join(process.env.LICENSE_BACKUP_DIR || "backups", job.id + ".kfbackup"),
      );
      await rm(cache, { force: true });
      const downloaded = await context.request.get(
        origin + "/admin/backups/" + job.id + "/download",
      );
      assert.equal(downloaded.status(), 200, id + " remote download");
      const bytes = await downloaded.body();
      assert.equal(createHash("sha256").update(bytes).digest("hex"), job.checksum);
      await writeFile(cache, bytes, { mode: 0o600 });
      await api("POST", "/admin/backups/" + job.id + "/verify", {});
      console.log("PASS real " + id + " upload / remote download / verify");
      report.checks.push({
        name: "real " + id + " upload/remote-download/verify",
        status: "passed",
        jobId: job.id,
      });
    }
  });
  await check("custom anonymous multipart/raw uploads and failure downloads", async () => {
    for (const [name, path, method, format] of [
      ["Browser multipart endpoint", "/form", "POST", "multipart"],
      ["Browser raw endpoint", "/raw", "PUT", "raw"],
      ["Browser rejected endpoint", "/fail", "POST", "raw"],
    ]) {
      await go("/backups");
      await page.getByRole("button", { name: "Add upload endpoint", exact: true }).click();
      await page.getByLabel("Destination name", { exact: true }).fill(name);
      await page.getByLabel("Upload URL", { exact: true }).fill(uploadURL + path);
      await page.getByLabel("HTTP method").selectOption(method);
      await page.getByLabel("Upload format").selectOption(format);
      await page.getByRole("button", { name: "Save endpoint", exact: true }).click();
      const section = page.getByRole("region", { name: name + " backup destination" });
      await section.waitFor();
      const event = page.waitForResponse(
        (r) => r.url().endsWith("/admin/backups") && r.request().method() === "POST",
      );
      await section.getByRole("button", { name: "Back up now", exact: true }).click();
      const initial = await (await event).json(),
        job = await waitJob(initial.job.id);
      assert.equal(job.status, path === "/fail" ? "failed" : "completed");
      const response = await context.request.get(origin + "/admin/backups/" + job.id + "/download");
      assert.equal(response.status(), 200);
      if (path === "/fail") assert.match(job.error, /HTTP 503/);
      const config = (await api("GET", "/admin/backups")).destinations.find(
        (d) => d.name === name,
      ).config;
      await api("PUT", "/admin/backups/destinations/" + job.destination, {
        ...config,
        id: undefined,
        archived: true,
      });
    }
    assert.equal(uploaded.length, 3);
    assert.equal(uploaded[1].method, "PUT");
  });
  await check("independent UTC schedules and a real scheduled local backup", async () => {
    await go("/backups");
    const before = (await api("GET", "/admin/backups")).jobs.map((j) => j.id);
    const section = page.getByRole("region", { name: "Local storage backup destination" });
    const time = new Date(Date.now() + 60000),
      text =
        String(time.getUTCHours()).padStart(2, "0") +
        ":" +
        String(time.getUTCMinutes()).padStart(2, "0");
    const toggle = section.getByRole("switch", { name: "Scheduled backups" });
    await toggle.focus();
    if (!(await toggle.isChecked())) await toggle.press("Space");
    await section.getByLabel("Daily time (UTC)").fill(text);
    await section.getByRole("button", { name: "Save schedule", exact: true }).click();
    let scheduled;
    for (let i = 0; i < 100; i++) {
      const state = await api("GET", "/admin/backups");
      scheduled = state.jobs.find((j) => j.destination === "local" && !before.includes(j.id));
      if (scheduled && scheduled.status === "completed") break;
      await pause(1000);
    }
    assert.equal(scheduled?.status, "completed");
    const state = await api("GET", "/admin/backups"),
      local = state.destinations.find((d) => d.id === "local").schedule;
    await api("PUT", "/admin/backups/destinations/local/schedule", {
      enabled: false,
      hourUTC: local.hourUTC,
      minuteUTC: local.minuteUTC,
      retentionDays: local.retentionDays,
      revision: local.revision,
    });
    for (const id of ["s3", "r2", "uploadthing"])
      assert.equal(Boolean(state.destinations.find((d) => d.id === id).schedule?.enabled), false);
  });
  await check("raw SQLite manual console downloads", async () => {
    await go("/backups");
    for (const name of ["Download license database now", "Download operator database"]) {
      const event = page.waitForEvent("download");
      await page.getByRole("button", { name, exact: true }).click();
      const dl = await event;
      assert.ok(dl.suggestedFilename().endsWith(".sqlite"));
      assert.equal(await dl.failure(), null);
    }
  });
  await check("support session permissions and sign-out/sign-in transition", async () => {
    await go("/");
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await page.waitForURL("**/login");
    await login(manifest.operators.support);
    assert.equal(await page.getByRole("button", { name: "Issue license", exact: true }).count(), 0);
    assert.equal((await api("GET", "/admin/config")).viewer.role, "support");
    const denied = await context.request.get(origin + "/admin/backups");
    assert.equal(denied.status(), 403);
    await choose("default");
    await go("/support/" + manifest.support[1].id);
    await page.getByLabel("Status").selectOption("resolved");
    await page.getByRole("button", { name: "Update request", exact: true }).click();
    await go("/licenses/" + manifest.licenses[0].license.id);
    assert.equal(await page.getByRole("button", { name: "Reveal key", exact: true }).count(), 0);
  });
} catch (error) {
  report.checks.push({
    name: "feature setup or teardown",
    status: "failed",
    error: safe(error.message),
  });
} finally {
  await extraContext?.close();
  await browser.close();
  await new Promise((done) => {
    uploadServer.close(done);
    uploadServer.closeAllConnections();
  });
  report.finishedAt = new Date().toISOString();
  await writeFile(join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    "Feature checks: " +
      report.checks.filter((c) => c.status === "passed").length +
      " passed; " +
      report.checks.filter((c) => c.status !== "passed").length +
      " failed.",
  );
  if (report.checks.some((c) => c.status !== "passed") || report.browserErrors.length)
    process.exitCode = 1;
}
