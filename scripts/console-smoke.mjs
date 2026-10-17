import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

import { buildLicenseApp } from "../dist/src/app.js";
import { createAuth, ensureAuthSchema, closeAuth, seedOperator } from "../dist/src/auth.js";
import { configSchema } from "../dist/src/config.js";
import { LicenseDatabase } from "../dist/src/db.js";
import { generateSigningKeyPair } from "../dist/src/sign.js";
import { auditConsoleUI } from "./ui-consistency-audit.mjs";

const temp = await mkdtemp(join(tmpdir(), "keyforge-console-"));
const artifacts = resolve(".artifacts/console-smoke");
await mkdir(artifacts, { recursive: true });
const authPath = join(temp, "keyforge.sqlite");
const origin = "http://127.0.0.1:4199";
const secret = randomBytes(32).toString("hex");
const password = "Local-browser-fixture-2026!";
await seedOperator({
  dbPath: authPath,
  secret,
  baseURL: origin,
  email: "admin@example.test",
  password,
  name: "Fixture Admin",
});
const auth = createAuth({ dbPath: authPath, secret, baseURL: origin });
await ensureAuthSchema(auth);
const database = await LicenseDatabase.open({ sqlitePath: authPath });
const app = await buildLicenseApp({
  database,
  auth,
  authDbPath: authPath,
  adminToken: "fixture-admin-token",
  privateKey: generateSigningKeyPair().privateKey,
  keyring: { active: "fixture", keys: { fixture: randomBytes(32).toString("hex") } },
  backups: {
    directory: join(temp, "backups"),
    keyring: { active: "fixture", keys: { fixture: randomBytes(32).toString("hex") } },
  },
  config: configSchema.parse({ limits: { support: { max: 100, timeWindow: "1 hour" } } }),
  uiDir: resolve("dist/public"),
});
const uploads = [];
const uploadServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  uploads.push(Buffer.concat(chunks));
  res.writeHead(201);
  res.end();
});
await new Promise((resolve) => uploadServer.listen(0, "127.0.0.1", resolve));
const uploadURL = "http://127.0.0.1:" + uploadServer.address().port + "/upload";
let browser;
try {
  const headers = { authorization: "Bearer fixture-admin-token" };
  await app.inject({
    method: "PUT",
    url: "/admin/products/default/definitions/imports",
    headers,
    payload: { id: "imports", type: "number", description: "Imports", minimum: 0, archived: false },
  });
  const initialPlan = (await app.inject({ url: "/admin/products/default/catalog", headers }))
    .json()
    .plans.find((p) => p.id === "standard");
  await app.inject({
    method: "PUT",
    url: "/admin/products/default/plans/standard",
    headers,
    payload: { ...initialPlan, price: 90000, currency: "ETB", entitlements: { imports: 100 } },
  });
  const issue = await app.inject({
    method: "POST",
    url: "/admin/products/default/licenses",
    headers,
    payload: { requestId: randomUUID(), plan: "standard", issuedTo: "Browser fixture" },
  });
  assert.equal(issue.statusCode, 201, issue.body);
  await app.inject({
    method: "PUT",
    url: "/admin/products/default/meters/imports",
    headers,
    payload: {
      id: "imports",
      entitlement: "imports",
      period: "monthly",
      description: "Imported records",
      archived: false,
    },
  });
  const serviceCredential = await app.inject({
    method: "POST",
    url: "/admin/products/default/credentials",
    headers,
    payload: { name: "Browser report fixture", permissions: ["usage:consume"] },
  });
  const usage = await app.inject({
    method: "POST",
    url: "/v1/products/default/usage/consume",
    headers: { authorization: "Bearer " + serviceCredential.json().secret },
    payload: {
      licenseId: issue.json().license.id,
      meterId: "imports",
      eventId: randomUUID(),
      units: 60,
    },
  });
  assert.equal(usage.statusCode, 200, usage.body);
  const credential = randomBytes(32).toString("base64url");
  const deviceHeaders = { authorization: "Bearer " + credential };
  await app.inject({
    method: "POST",
    url: "/v1/products/default/register",
    headers: deviceHeaders,
    payload: { installationId: "browser-install", requestId: randomUUID() },
  });
  await app.inject({
    method: "POST",
    url: "/v1/products/default/activate",
    headers: deviceHeaders,
    payload: { installationId: "browser-install", key: issue.json().key },
  });
  const backfill = await app.inject({
    method: "PUT",
    url: "/v1/products/default/installations/browser-install/device-signals",
    headers: deviceHeaders,
    payload: {
      machineSignals: ["machine-guid", "smbios-uuid", "volume-serial"].map((kind, index) => ({
        kind,
        hash: String(index + 1).repeat(64),
      })),
    },
  });
  assert.equal(backfill.statusCode, 200, backfill.body);
  const requestId = randomUUID();
  const ticket = await app.inject({
    method: "POST",
    url: "/v1/products/default/installations/browser-install/support",
    headers: { ...deviceHeaders, "idempotency-key": requestId },
    payload: {
      requestId,
      category: "technical",
      urgency: "normal",
      licenseId: issue.json().license.id,
      subject: "Browser support fixture",
      message: "Confirm the operator can take action.",
      createdAt: new Date().toISOString(),
    },
  });
  assert.equal(ticket.statusCode, 202, ticket.body);
  await app.listen({ port: 4199, host: "127.0.0.1" });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const failures = [];
  const analyticsRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/_vercel/insights/"))
      analyticsRequests.push(request.url());
  });
  page.on("pageerror", (error) => failures.push(error.message));
  const publicAdminRequests = [];
  const recordPublicRequest = (req) => {
    if (new URL(req.url()).pathname.startsWith("/admin/")) publicAdminRequests.push(req.url());
  };
  page.on("request", recordPublicRequest);
  await page.goto(origin + "/");
  await page.waitForURL(origin + "/welcome");
  await page.getByRole("heading", { name: "License your software. Host it yourself." }).waitFor();
  const review = resolve(".impeccable/review");
  await mkdir(review, { recursive: true });
  for (const [name, width, height, theme] of [
    ["desktop", 1440, 1000, "light"],
    ["desktop-dark", 1440, 1000, "dark"],
    ["mobile", 390, 844, "light"],
    ["mobile-dark", 390, 844, "dark"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((value) => localStorage.setItem("keyforge.theme", value), theme);
    await page.reload();
    await page.getByRole("heading", { name: "License your software. Host it yourself." }).waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
      window.scrollTo(0, 0);
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(review, name + ".png"), fullPage: true });
    if (theme === "light") await page.screenshot({ path: join(review, name + "-hero.png") });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => localStorage.setItem("keyforge.theme", "light"));
  await page.reload();
  assert.equal(
    await page.getByRole("link", { name: "Download source", exact: true }).getAttribute("href"),
    "https://github.com/zdevzone/keyforge/archive/refs/heads/main.zip",
  );
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").textContent(), "Skip to content");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(":focus").getAttribute("id"), "welcome-main");
  await page.getByRole("button", { name: "Can I download and host KeyForge myself?" }).click();
  await page.getByText("Yes. KeyForge is MIT-licensed source code.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Can I download and host KeyForge myself?" }).click();
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await page.reload();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Features", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(publicAdminRequests, []);
  page.off("request", recordPublicRequest);
  await page.goto(origin + "/licenses/protected-deep-link");
  await page.waitForURL(origin + "/login");
  await page.goto(origin + "/login");
  await page.getByLabel("Email", { exact: true }).fill("admin@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Open account menu" }).waitFor();
  // The Polaris shell keeps search, details, and creation usable at both widths.
  await page.getByRole("heading", { name: "License overview" }).waitFor();
  await page.screenshot({ path: join(artifacts, "licenses-desktop.png"), fullPage: true });
  async function choose(label, option) {
    const input = page.getByRole("combobox", { name: label, exact: true });
    const searchable = await input.evaluate((element) => element.tagName === "INPUT");
    await input.click();
    if (searchable) await input.fill(option);
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  await page.getByRole("button", { name: "Search licenses and commands", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Search licenses and commands", exact: true })
    .fill("no-matching-customer");
  await page
    .getByRole("combobox", { name: "Search licenses and commands", exact: true })
    .press("Enter");
  await page.getByText("No licenses match the current filter.").waitFor();
  await page.keyboard.press("Control+k");
  await page
    .getByRole("combobox", { name: "Search licenses and commands", exact: true })
    .fill("Browser fixture");
  await page.getByRole("option", { name: /Search licenses for/ }).waitFor();
  await page.screenshot({ path: join(artifacts, "command-palette-desktop.png"), fullPage: true });
  await page
    .getByRole("combobox", { name: "Search licenses and commands", exact: true })
    .press("Enter");
  await page.getByRole("link", { name: "Browser fixture", exact: true }).click();
  await page.getByRole("tab", { name: "Activations", exact: true }).click();
  await page.getByRole("button", { name: "Release", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.screenshot({ path: join(artifacts, "license-detail-desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: "Activations", exact: true }).click();
  await page.getByRole("columnheader", { name: "Reported machine group", exact: true }).waitFor();
  await page.getByText("Available", { exact: true }).waitFor();
  await page.screenshot({
    path: join(artifacts, "activation-history-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "activation-history-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const route of ["installations", "machines"]) {
    await page.goto(origin + "/" + route);
    await page.getByText("Available", { exact: true }).waitFor();
    for (const [suffix, width, height] of [
      ["desktop", 1440, 1000],
      ["mobile", 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: join(artifacts, route + "-" + suffix + ".png"),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/");
  await page.getByRole("button", { name: "Issue license", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: join(artifacts, "issue-license-desktop.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.goto(origin + "/products");
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: join(artifacts, "add-product-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  // Policy edits target their row even when another product is active.
  assert.equal(await page.locator("main form").count(), 0);
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Atlas API");
  await page.getByLabel("Permanent product ID", { exact: true }).fill("atlas-api");
  await page.getByRole("button", { name: "Create product", exact: true }).click();
  const atlas = page.getByRole("row").filter({ hasText: "Atlas API" });
  await atlas.getByRole("button", { name: "Edit policy", exact: true }).click();
  await page.getByLabel("Offline grace days", { exact: true }).fill("-1");
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await page.getByLabel("Offline grace days", { exact: true }).fill("17");
  await page.screenshot({ path: join(artifacts, "product-policy-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await atlas.getByRole("button", { name: "Edit policy", exact: true }).waitFor();
  assert.equal(
    await atlas
      .getByRole("button", { name: "Edit policy", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(
    (await app.inject({ method: "GET", url: "/admin/products", headers }))
      .json()
      .products.find((p) => p.id === "atlas-api").graceDays,
    17,
  );
  await page.getByLabel("Filter products", { exact: true }).fill("Atlas");
  assert.equal(await page.getByRole("row").count(), 2);
  await page.getByLabel("Filter products", { exact: true }).fill("");
  await page.getByRole("button", { name: /Sort by Product/ }).click();
  await page.screenshot({ path: join(artifacts, "products-desktop.png"), fullPage: true });
  const searchBounds = await page.getByLabel("Filter products", { exact: true }).boundingBox();
  const statusBounds = await page
    .getByRole("combobox", { name: "Product status", exact: true })
    .boundingBox();
  const columnsBounds = await page
    .getByRole("button", { name: "Columns", exact: true })
    .boundingBox();
  assert.ok(
    Math.abs(searchBounds.y + searchBounds.height - statusBounds.y - statusBounds.height) < 5,
    "Product search and status share a toolbar row",
  );
  assert.ok(
    Math.abs(searchBounds.y + searchBounds.height - columnsBounds.y - columnsBounds.height) < 5,
    "Columns stays beside filters",
  );
  assert.ok(statusBounds.width < 300, "Status picker fits its content");
  const productPicker = page.getByRole("combobox", { name: "Active product", exact: true });
  const initialProduct = "Keyforge";
  await productPicker.click();
  await page.getByRole("option", { name: "Atlas API", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.querySelector(".console-product")?.textContent?.includes("Atlas API"),
  );
  assert.ok((await productPicker.textContent()).includes("Atlas API"));
  await choose("Active product", initialProduct);
  await page.goto(origin + "/entitlements");
  await page.getByRole("button", { name: "Add entitlement", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await choose("Value type", "boolean");
  await page.screenshot({
    path: join(artifacts, "entitlement-editor-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.locator("main form").count(), 0);
  await page.getByRole("tab", { name: "Plans", exact: true }).click();
  await page.getByRole("button", { name: "Add plan", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.goto(origin + "/metering");
  await page.getByRole("button", { name: "Add meter", exact: true }).click();
  await choose("Quota period", "monthly (UTC)");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Add credential", exact: true }).click();
  await page.getByLabel("Integration name", { exact: true }).fill("Browser dialog service");
  await page.getByRole("button", { name: "Create usage credential", exact: true }).click();
  await page.getByText("Shown once. Store in the service's secret manager.").waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.equal(await page.locator("main form").count(), 0);
  await page.goto(origin + "/licenses/" + issue.json().license.id);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: /Expires.*never/ }).click();
  await page.screenshot({ path: join(artifacts, "date-picker-desktop.png"), fullPage: true });
  const picked = await page
    .locator('[role="dialog"] [data-date][tabindex="0"]')
    .last()
    .getAttribute("data-date");
  await page.locator('[role="dialog"] [data-date][tabindex="0"]').last().click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Edit license", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/admin/products/default/licenses/" + issue.json().license.id,
        headers,
      })
    )
      .json()
      .license.expiresAt.slice(0, 10),
    picked,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [route, name] of [
    ["/", "licenses"],
    ["/licenses/" + issue.json().license.id, "license-detail"],
    ["/metering", "metering"],
    ["/products", "products"],
  ]) {
    await page.goto(origin + route);
    await page.locator("main h1").waitFor();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      name + " overflows",
    );
    await page.screenshot({ path: join(artifacts, name + "-mobile.png"), fullPage: true });
  }
  await page.goto(origin + "/");
  await page.getByRole("button", { name: "Issue license", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "Issue form overflows",
  );
  await page.screenshot({ path: join(artifacts, "issue-license-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Products", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.screenshot({ path: join(artifacts, "add-product-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page
    .getByRole("row")
    .filter({ hasText: "Atlas API" })
    .getByRole("button", { name: "Edit policy", exact: true })
    .click();
  await page.screenshot({ path: join(artifacts, "product-policy-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Active product", exact: true }).click();
  await page.getByRole("option", { name: "Atlas API", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "combobox-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Search licenses and commands", exact: true }).click();
  await page.screenshot({ path: join(artifacts, "command-palette-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await page.goto(origin + "/licenses/" + issue.json().license.id);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: /Expires.*never/ }).click();
  await page.screenshot({ path: join(artifacts, "date-picker-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByRole("dialog", { name: /Expires.*calendar/ }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Edit license", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/admin/products/default/licenses/" + issue.json().license.id,
        headers,
      })
    ).json().license.expiresAt,
    null,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/metering");
  await page.getByRole("img", { name: "Consumed units for imports", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "metering-desktop.png"), fullPage: true });
  // Synthetic report series exercises dense charts without changing the ledger clock.
  await page.route(origin + "/admin/products/default/meters", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.usage = Array.from({ length: 12 }, (_, index) => ({
      id: "chart-fixture-" + index,
      licenseId: issue.json().license.id,
      meterId: "imports",
      period: `2026-${String(index + 1).padStart(2, "0")}`,
      consumed: 10 + index * 5,
    }));
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByText("Scroll horizontally to see all recorded periods.").waitFor();
  await page.screenshot({ path: join(artifacts, "metering-dense-mobile.png"), fullPage: true });
  await page.unroute(origin + "/admin/products/default/meters");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Open account menu" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByLabel("Phone", { exact: true }).fill("+251 555 0100");
  const avatar = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1366d9";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "white";
    ctx.font = "bold 30px sans-serif";
    ctx.fillText("KF", 9, 43);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(avatar, "base64"),
  });
  await page.getByRole("img", { name: "Profile preview" }).waitFor();
  await page.getByRole("button", { name: "Save profile" }).click();
  await page.getByText("Saved.", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".console-account img")?.getAttribute("src")?.startsWith("data:image/"),
  );
  await page.reload();
  await page.getByRole("img", { name: "Profile preview" }).waitFor();
  await page.screenshot({ path: join(artifacts, "profile-desktop.png"), fullPage: true });
  const replacementAvatar = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#334155";
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const originalImage = await page.locator(".console-account img").getAttribute("src");
  await page.getByLabel("Choose profile image", { exact: true }).setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: Buffer.from(replacementAvatar, "base64"),
  });
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.waitForFunction((previous) => {
    const src = document.querySelector(".console-account img")?.getAttribute("src");
    return src && src !== previous;
  }, originalImage);
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".console-account img"));
  await page.reload();
  await page.getByRole("button", { name: "Upload profile image", exact: true }).waitFor();
  assert.equal(await page.locator(".console-account img").count(), 0);
  await page.getByLabel("Choose profile image", { exact: true }).setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(avatar, "base64"),
  });
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector(".console-account img"));

  await page.goto(origin + "/support/" + ticket.json().request.id);
  await choose("Status", "in progress");
  await page.getByRole("button", { name: "Update request" }).click();
  await page.getByText("Request updated.", { exact: true }).waitFor();
  await page.getByLabel("Customer reply", { exact: true }).fill("We are investigating this issue.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await page.getByText("We are investigating this issue.", { exact: true }).first().waitFor();
  const customer = await app.inject({
    method: "GET",
    url: "/v1/products/default/installations/browser-install/support/" + ticket.json().request.id,
    headers: deviceHeaders,
  });
  assert.ok(customer.body.includes("We are investigating"));
  await page.getByLabel("Internal note", { exact: false }).check();
  await page
    .getByLabel("Internal note", { exact: true })
    .fill("Private follow-up: confirm the installation version.");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.getByText("Internal note added.", { exact: true }).waitFor();
  await choose("Conversation history", "Internal operator notes");
  await page
    .getByText("Private follow-up: confirm the installation version.", { exact: true })
    .waitFor();
  await page.getByRole("heading", { level: 1 }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, "support-notes-desktop.png"), fullPage: true });
  await choose("Conversation history", "Customer conversation");
  await page.getByRole("heading", { level: 1 }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, "support-desktop.png"), fullPage: true });
  const latestTicket = (
    await app.inject({
      url: "/admin/products/default/support/" + ticket.json().request.id,
      headers,
    })
  ).json().request;
  const followup = await app.inject({
    method: "POST",
    url:
      "/v1/products/default/installations/browser-install/support/" +
      ticket.json().request.id +
      "/messages",
    headers: deviceHeaders,
    payload: {
      requestId: randomUUID(),
      message: "Thank you. I still need help with this installation.",
      revision: latestTicket.revision,
    },
  });
  assert.equal(followup.statusCode, 200, followup.body);

  await page.goto(origin + "/sales?license=" + issue.json().license.id);
  await page.getByRole("button", { name: "Mark as paid", exact: true }).click();
  await page.getByLabel("Transaction reference", { exact: true }).fill("BROWSER-RECEIPT");
  await page.screenshot({ path: join(artifacts, "payment-dialog-desktop.png"), fullPage: true });
  await page.getByRole("dialog").getByRole("button", { name: "Mark as paid", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const financial = (
    await app.inject({ url: "/admin/products/default/finance/report", headers })
  ).json();
  assert.equal(financial.salesValue, 90000);
  assert.equal(financial.received, 90000);
  assert.equal(financial.outstanding, 0);
  await page.screenshot({ path: join(artifacts, "sales-desktop.png"), fullPage: true });
  await page.goto(origin + "/reports/financial");
  await page.getByRole("button", { name: "Export balances CSV", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "financial-desktop.png"), fullPage: true });
  const financeDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export balances CSV", exact: true }).click();
  const financeFile = await financeDownload;
  assert.ok(financeFile.suggestedFilename().includes("ETB"));
  await page.getByLabel("Customer", { exact: true }).fill("Browser fixture");
  await page.getByText(/Product: Keyforge.*Customer: Browser fixture/).waitFor();
  await page.emulateMedia({ media: "print" });
  assert.ok(await page.locator(".report-scope").isVisible());
  assert.ok((await page.locator(".report-scope").innerText()).includes("Period:"));
  await page.screenshot({ path: join(artifacts, "financial-filtered-print.png"), fullPage: true });
  assert.equal(await page.locator(".report-print tbody tr").count(), 1);
  assert.ok(await page.locator(".report-print").isVisible());
  await page.pdf({ path: join(artifacts, "financial-report.pdf"), format: "A4" });
  await page.emulateMedia({ media: "screen" });
  await page.goto(origin + "/notifications");
  await page.getByRole("heading", { name: "Notifications", exact: true }).waitFor();
  // Capture enough real customer events to exercise page-vs-matching bulk selection.
  for (let index = 0; index < 24; index++) {
    const eventId = randomUUID();
    const response = await app.inject({
      method: "POST",
      url: "/v1/products/default/installations/browser-install/support",
      headers: { ...deviceHeaders, "idempotency-key": eventId },
      payload: {
        requestId: eventId,
        licenseId: issue.json().license.id,
        category: "technical",
        urgency: "normal",
        subject: "Notification fixture " + index,
        message: "A customer update for notification testing.",
        createdAt: new Date().toISOString(),
      },
    });
    assert.equal(response.statusCode, 202, response.body);
  }
  await page.reload();
  await page.getByRole("checkbox", { name: "Select current page", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll("main tbody tr").length === 20);
  await page.getByRole("button", { name: /Recent notifications/ }).click();
  await page.getByRole("link", { name: "View all notifications", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("list", { name: "Recent notifications", exact: true })
      .locator(":scope > li")
      .count(),
    5,
  );
  await page.screenshot({
    path: join(artifacts, "notification-dropdown-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "View all notifications", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await page.getByRole("button", { name: /Select all .* matching notifications/ }).click();
  await page.getByRole("button", { name: "Mark selected as read", exact: true }).click();
  await page.getByText("Notifications updated.", { exact: true }).waitFor();
  await choose("Show notifications", "Read");
  await page.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await page.getByRole("button", { name: "Mark selected as unread", exact: true }).click();
  await choose("Show notifications", "Unread");
  await page.waitForFunction(() => document.querySelectorAll("main tbody tr").length === 20);
  await page.getByRole("checkbox", { name: "Select current page", exact: true }).click();
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  await page.getByRole("dialog", { name: "Delete notifications?", exact: true }).waitFor();
  await page.screenshot({
    path: join(artifacts, "notification-delete-confirm-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.locator("main tbody tr").count(), 20);
  await page.getByRole("button", { name: "Delete selected", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete notifications?", exact: true })
    .waitFor({ state: "hidden" });
  await choose("Show notifications", "All");
  await page.locator("main tbody").getByRole("checkbox").first().click();
  await page.getByRole("button", { name: "Mark selected as unread", exact: true }).click();
  await page.getByRole("button", { name: "Mark all notifications as read", exact: true }).click();
  await page.getByText("Notifications updated.", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "notifications-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Switch to dark theme", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({
    path: join(artifacts, "notifications-dark-desktop.png"),
    fullPage: true,
  });
  await page.reload();
  assert.ok(await page.evaluate(() => document.documentElement.classList.contains("dark")));
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await page.goto(origin + "/settings?tab=preferences");
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  await choose("Theme", "Dark");
  await page.screenshot({ path: join(artifacts, "preferences-dark-desktop.png"), fullPage: true });
  await choose("Theme", "Light");
  await page.goto(origin + "/support");
  await choose("Inbox", "All conversations");
  await page
    .getByText("Thank you. I still need help with this installation.", { exact: true })
    .waitFor();
  const beforePrivate = (
    await app.inject({
      url: "/admin/products/default/support/" + ticket.json().request.id,
      headers,
    })
  ).json().request;
  await app.inject({
    method: "POST",
    url: "/admin/products/default/support/" + ticket.json().request.id + "/messages",
    headers,
    payload: {
      requestId: randomUUID(),
      message: "Check the customer's app version before replying.",
      internal: true,
      revision: beforePrivate.revision,
    },
  });
  await page.reload();
  await choose("Inbox", "All conversations");
  await page.getByText("Private note:", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "inbox-desktop.png"), fullPage: true });
  for (const route of ["entitlements", "products", "backups", "installations", "system"]) {
    await page.goto(origin + "/" + route);
    await page.locator("main").waitFor();
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.screenshot({ path: join(artifacts, route + "-desktop.png"), fullPage: true });
  }
  await page.goto(origin + "/backups");
  const blobPanel = page.getByRole("region", {
    name: "Vercel Blob (private) backup destination",
    exact: true,
  });
  await blobPanel.getByRole("button", { name: "Configure storage", exact: true }).click();
  const storageDialog = page.getByRole("dialog", {
    name: "Vercel Blob (private) storage settings",
    exact: true,
  });
  await storageDialog
    .getByLabel("Private Blob read/write token", { exact: true })
    .fill("local-browser-provider-fixture");
  await page.screenshot({ path: join(artifacts, "storage-settings-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "storage-settings-mobile.png"), fullPage: true });
  assert.equal(await storageDialog.evaluate((e) => e.scrollWidth > e.clientWidth), false);
  await storageDialog.getByRole("button", { name: "Save storage settings", exact: true }).click();
  await storageDialog.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await blobPanel.getByRole("button", { name: "Configure storage", exact: true }).click();
  assert.equal(
    await storageDialog.getByLabel("Private Blob read/write token", { exact: true }).inputValue(),
    "",
  );
  const storageBefore = (await app.inject({ url: "/admin/backups", headers })).json().storage.blob;
  const storagePoll = page.waitForResponse(
    async (response) =>
      response.url().endsWith("/admin/backups") &&
      response.request().method() === "GET" &&
      response.status() === 200 &&
      (await response.json()).storage.blob.revision > storageBefore.revision,
  );
  const concurrentStorage = await app.inject({
    method: "PUT",
    url: "/admin/backups/providers/blob",
    headers,
    payload: { revision: storageBefore.revision, token: "concurrent-browser-provider-fixture" },
  });
  assert.equal(concurrentStorage.statusCode, 200, concurrentStorage.body);
  await storagePoll;
  const staleSave = page.waitForResponse(
    (response) =>
      response.url().endsWith("/admin/backups/providers/blob") &&
      response.request().method() === "PUT",
  );
  await storageDialog.getByRole("button", { name: "Save storage settings", exact: true }).click();
  assert.equal(
    (await staleSave).status(),
    409,
    "Polling must not silently refresh an open editor's concurrency revision",
  );
  await storageDialog.getByRole("alert").waitFor();
  await storageDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download database now/ }).click();
  const download = await downloadEvent;
  assert.ok(download.suggestedFilename().endsWith(".sqlite"));
  assert.equal(await download.failure(), null);
  await page.getByRole("button", { name: "Add upload endpoint", exact: true }).click();
  await page.getByLabel("Destination name", { exact: true }).fill("Public upload fixture");
  await page.getByLabel("Upload URL", { exact: true }).fill(uploadURL);
  await page.getByRole("button", { name: "Save endpoint", exact: true }).click();
  const destination = page.getByRole("region", {
    name: "Public upload fixture backup destination",
  });
  await destination.waitFor();
  await destination.getByRole("button", { name: "Edit schedule", exact: true }).click();
  const schedule = page.getByRole("dialog", {
    name: "Public upload fixture backup schedule",
    exact: true,
  });
  await schedule.getByRole("switch", { name: "Scheduled backups" }).focus();
  await schedule.getByRole("switch", { name: "Scheduled backups" }).press("Space");
  assert.equal(await schedule.getByRole("switch", { name: "Scheduled backups" }).isChecked(), true);
  await schedule.getByLabel("Daily time (UTC)", { exact: true }).fill("03:45");
  await schedule.getByRole("button", { name: "Save schedule", exact: true }).click();
  await page.waitForResponse((r) => r.url().endsWith("/admin/backups") && r.status() === 200);
  const state = (await app.inject({ method: "GET", url: "/admin/backups", headers })).json();
  const configured = state.destinations.find((d) => d.name === "Public upload fixture");
  assert.equal(configured.schedule.enabled, true);
  assert.equal(configured.schedule.hourUTC, 3);
  assert.equal(configured.schedule.minuteUTC, 45);
  await destination.getByRole("button", { name: "Back up now", exact: true }).click();
  await page.getByText("Completed", { exact: true }).waitFor();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].includes(Buffer.from("SQLite format 3")), false);
  const encryptedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  assert.ok((await encryptedDownload).suggestedFilename().endsWith(".kfbackup"));
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.getByText("Restore verified", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open account menu" }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, "backups-desktop.png"), fullPage: true });
  // Cursor audit pages never accumulate rows; previous restores the same snapshot.
  for (let index = 0; index < 55; index++)
    await database.appendAudit({ actor: "browser", action: "fixture.page", detail: { index } });
  await page.goto(origin + "/audit");
  await page.getByRole("heading", { name: "Audit log" }).waitFor();
  const auditPageButton = await page
    .getByRole("button", { name: "Page 1", exact: true })
    .boundingBox();
  assert.ok(
    auditPageButton.width >= 38 && auditPageButton.height >= 38,
    "Pagination controls must have usable pointer targets",
  );
  const firstAudit = await page.locator("main tbody tr").first().textContent();
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await page.getByText(/Page 2 ·/).waitFor();
  assert.ok((await page.locator("main tbody tr").count()) <= 50);
  await page.getByRole("button", { name: "Previous page", exact: true }).click();
  await page.getByText(/Page 1 ·/).waitFor();
  assert.equal(await page.locator("main tbody tr").first().textContent(), firstAudit);
  await page.getByRole("button", { name: "Open account menu" }).focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(artifacts, "audit-desktop.png"), fullPage: true });
  await page.goto(origin + "/settings");
  await page.getByRole("heading", { name: "Your sessions" }).waitFor();
  await page.getByRole("tab", { name: "Preferences", exact: true }).click();
  await page.getByRole("heading", { name: "Notification preferences", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "preferences-desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: "System", exact: true }).click();
  await page.getByText("Configuration boundaries", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "system-tab-desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: "Account", exact: true }).click();
  await page.screenshot({ path: join(artifacts, "settings-desktop.png"), fullPage: true });
  await page.goto(origin + "/reports");
  await page.getByRole("heading", { name: /License status ·/ }).waitFor();
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  assert.ok((await csvDownload).suggestedFilename().endsWith(".csv"));
  await choose("Report", "Usage by customer");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByRole("heading", { name: /Usage by customer · 1 record/ }).waitFor();
  await page.getByText("imports: 60 units", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "reports-desktop.png"), fullPage: true });
  await page.emulateMedia({ media: "print" });
  assert.equal(await page.locator(".report-print").isVisible(), true);
  assert.equal(await page.locator(".report-screen").isVisible(), false);
  await page.pdf({ path: join(artifacts, "report.pdf"), format: "A4", printBackground: true });
  await page.emulateMedia({ media: "screen" });
  for (let index = 0; index < 24; index++) {
    const issued = await app.inject({
      method: "POST",
      url: "/admin/products/default/licenses",
      headers,
      payload: {
        requestId: randomUUID(),
        plan: "standard",
        issuedTo: index === 0 ? "=SUM(1,1)" : `Export customer ${index}`,
      },
    });
    assert.equal(issued.statusCode, 201, issued.body);
  }
  await choose("Report", "License status");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByRole("heading", { name: /License status · 25 records/ }).waitFor();
  assert.equal(await page.locator(".report-screen tbody tr").count(), 20);
  const completeExport = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const stream = await (await completeExport).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString("utf8");
  assert.equal(csv.split("\r\n").length, 26);
  assert.ok(csv.includes("'=SUM(1,1)"));
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  assert.equal(await page.locator(".report-screen tbody tr").count(), 5);
  await page.getByLabel("Customer contains").fill("No matching customer");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByRole("heading", { name: /License status · 0 records/ }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Export CSV", exact: true }).isDisabled(),
    true,
  );
  // A longer product catalog switches to searchable choice and paginates after sorting.
  for (let index = 0; index < 21; index++) {
    const response = await app.inject({
      method: "POST",
      url: "/admin/products",
      headers,
      payload: {
        id: `fixture-${index}`,
        name: `Fixture product ${String(index).padStart(2, "0")}`,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  await page.goto(origin + "/products");
  await page.getByRole("heading", { name: "Products", exact: true }).waitFor();
  assert.equal(await page.locator("main tbody tr").count(), 20);
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  assert.equal(await page.locator("main tbody tr").count(), 3);
  await page.getByLabel("Filter products").fill("Fixture product 00");
  assert.equal(await page.locator("main tbody tr").count(), 1);
  await choose("Active product", "Keyforge");
  await page.getByLabel("Filter products").fill("");
  await page.screenshot({ path: join(artifacts, "products-paged-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Edit policy", exact: true }).first().hover();
  await page.getByRole("tooltip", { name: "Edit policy", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of [
    "sales",
    "reports/financial",
    "notifications",
    "support",
    "profile",
    "settings",
    "reports",
    "audit",
    "entitlements",
    "backups",
    "support/" + ticket.json().request.id,
  ]) {
    await page.goto(origin + "/" + route);
    await page.locator("main h1").waitFor();
    if (route === "reports")
      await page.getByRole("heading", { name: /License status ·/ }).waitFor();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      route + " overflows",
    );
    await page.screenshot({
      path: join(artifacts, route.replaceAll("/", "-") + "-mobile.png"),
      fullPage: true,
    });
  }
  await auditConsoleUI(
    page,
    origin,
    { licenseId: issue.json().license.id, supportId: ticket.json().request.id },
    join(artifacts, "consistency"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/settings?tab=preferences");
  await page.getByRole("heading", { name: "Appearance", exact: true }).waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: join(artifacts, "preferences-dark-mobile.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole("button", { name: /Recent notifications/ }).click();
  await page.getByRole("link", { name: "View all notifications", exact: true }).waitFor();
  await page.screenshot({
    path: join(artifacts, "notification-dropdown-dark-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "View all notifications", exact: true }).click();
  await page.getByRole("button", { name: "Switch to light theme", exact: true }).click();
  await page.getByRole("button", { name: "Delete all notifications", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await page.getByText("No notifications.", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("No notifications.", { exact: true }).waitFor();
  // Account-preserving reset is tested only against this temporary fixture.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + "/settings?tab=system");
  await page.getByRole("button", { name: "Reset application data", exact: true }).click();
  let resetDialog = page.getByRole("dialog", { name: "Reset application data?", exact: true });
  let resetButton = resetDialog.getByRole("button", {
    name: "Delete all application data",
    exact: true,
  });
  assert.ok(await resetButton.isDisabled());
  await resetDialog.getByLabel("Type DELETE ALL to confirm", { exact: true }).fill("delete all");
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.ok(await resetButton.isDisabled());
  assert.ok(
    await resetDialog
      .getByRole("checkbox", { name: "Back up existing data before resetting", exact: true })
      .isChecked(),
  );
  await page.screenshot({ path: join(artifacts, "system-reset-desktop.png"), fullPage: true });
  await resetDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    (await app.inject({ url: "/admin/products/default/licenses", headers })).json().total > 0,
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Reset application data", exact: true }).click();
  resetDialog = page.getByRole("dialog", { name: "Reset application data?", exact: true });
  resetButton = resetDialog.getByRole("button", {
    name: "Delete all application data",
    exact: true,
  });
  await resetDialog.getByLabel("Type DELETE ALL to confirm", { exact: true }).fill("DELETE ALL");
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.ok(await resetButton.isEnabled());
  await resetDialog.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: join(artifacts, "system-reset-mobile.png"), fullPage: true });
  await resetButton.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifacts, "system-reset-mobile-actions.png"),
    fullPage: true,
  });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await resetButton.click();
  await page
    .getByText("Application data was reset. The seeded administrator was preserved.", {
      exact: false,
    })
    .waitFor();
  assert.equal(
    (await app.inject({ url: "/admin/products/default/licenses", headers })).json().total,
    0,
  );
  const resetBackups = (await app.inject({ url: "/admin/backups", headers })).json().jobs;
  assert.equal(resetBackups.length, 1);
  assert.ok(resetBackups[0].verifiedAt);
  await page.screenshot({
    path: join(artifacts, "system-reset-complete-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: join(artifacts, "system-reset-complete-desktop.png"),
    fullPage: true,
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(analyticsRequests, [], "Self-hosted builds must not load Vercel Analytics");
  console.log(
    "Console browser checks passed: login, account menu, profile save, support status/reply, customer delivery, manual download, public endpoint upload, independent UTC schedule, archive verification and mobile layout.",
  );
} catch (error) {
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({ path: join(artifacts, "failure.png"), fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise((resolve) => {
    uploadServer.close(resolve);
    uploadServer.closeAllConnections();
  });
  await app.close();
  await closeAuth(auth);
  await database.close();
  await rm(temp, { recursive: true, force: true });
}
