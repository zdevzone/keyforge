import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

import { buildLicenseApp } from "../dist/src/app.js";
import { createAuth, ensureAuthSchema, closeAuth, seedOperator } from "../dist/src/auth.js";
import { configSchema } from "../dist/src/config.js";
import { LicenseDatabase } from "../dist/src/db.js";
import { generateSigningKeyPair } from "../dist/src/sign.js";

const temp = await mkdtemp(join(tmpdir(), "kf-issuance-browser-")),
  artifacts = resolve(".artifacts/issuance-smoke");
await mkdir(artifacts, { recursive: true });
const origin = "http://127.0.0.1:4201",
  path = join(temp, "keyforge.sqlite"),
  secret = randomBytes(32).toString("hex"),
  password = "Browser-issuance-fixture-2026!";
await seedOperator({
  dbPath: path,
  secret,
  baseURL: origin,
  email: "admin@example.test",
  password,
});
const auth = createAuth({ dbPath: path, secret, baseURL: origin });
await ensureAuthSchema(auth);
const database = await LicenseDatabase.open({ sqlitePath: path });
const app = await buildLicenseApp({
  database,
  auth,
  authDbPath: path,
  adminToken: "browser-admin",
  privateKey: generateSigningKeyPair().privateKey,
  keyring: { active: "browser", keys: { browser: randomBytes(32).toString("hex") } },
  config: configSchema.parse({ limits: { enabled: false } }),
  uiDir: resolve("dist/public"),
  backups: { directory: join(temp, "backups") },
});
const headers = { authorization: "Bearer browser-admin" };
const admin = (method, suffix, payload) =>
  app.inject({ method, url: "/admin/products/default" + suffix, headers, payload });
const p = (await admin("GET", "/catalog")).json().plans.find((v) => v.id === "standard");
await admin("PUT", "/plans/standard", { ...p, price: 150000, currency: "ETB", durationDays: 365 });
let browser;
try {
  await app.listen({ port: 4201, host: "127.0.0.1" });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage(),
    customer = await context.newPage();
  const failures = [];
  for (const tab of [page, customer]) {
    tab.setDefaultTimeout(15000);
    tab.on("pageerror", (e) => failures.push(e.message));
  }
  async function choose(tab, label, option) {
    const field = tab.getByRole("combobox", { name: label, exact: true });
    const searchable = await field.evaluate((e) => e.tagName === "INPUT");
    await field.click();
    if (searchable) await field.fill(option);
    else {
      const search = tab.getByRole("combobox", {
        name: "Search " + label.toLowerCase(),
        exact: true,
      });
      if (await search.isVisible()) await search.fill(option);
    }
    await tab.getByRole("option", { name: option, exact: true }).click();
  }
  await customer.goto(origin + "/request-license");
  await customer.getByLabel("Your name", { exact: true }).fill("Preinstall Buyer");
  await customer.getByLabel("Email", { exact: true }).fill("buyer@example.test");
  await choose(customer, "Product", "Keyforge");
  await choose(customer, "Requested plan", "standard");
  await customer.screenshot({ path: join(artifacts, "request-desktop.png"), fullPage: true });
  await customer.getByRole("button", { name: "Request license", exact: true }).click();
  await customer.getByText(/Awaiting operator approval/).waitFor();
  const privateLink = customer.url();
  assert.ok(privateLink.includes("#"));
  await page.goto(origin + "/login");
  await page.getByLabel("Email", { exact: true }).fill("admin@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "License requests", exact: true }).click();
  await page.getByText("buyer@example.test", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Issue license", exact: true }).click();
  await page.getByRole("region", { name: "Selected plan terms" }).waitFor();
  assert.equal(
    await page.getByRole("dialog").getByLabel("Activation limit", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("dialog").getByLabel("Entitlement key", { exact: true }).count(),
    0,
  );
  await page.screenshot({ path: join(artifacts, "issue-unpaid-desktop.png"), fullPage: true });
  const issuedResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/admin/products/default/licenses"),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Issue license", exact: true })
    .click();
  const issued = await (await issuedResponse).json();
  assert.equal(issued.sale.status, "unpaid");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await customer.reload();
  await customer.getByRole("button", { name: "Retrieve license key", exact: true }).click();
  await customer.locator("code").waitFor();
  assert.equal(await customer.locator("code").innerText(), issued.key);
  await customer.screenshot({
    path: join(artifacts, "request-issued-desktop.png"),
    fullPage: true,
  });
  await page.goto(origin + "/sales");
  await page.getByRole("button", { name: "Mark as paid", exact: true }).click();
  await page.getByLabel("Transaction reference", { exact: true }).fill("BANK-BROWSER-1");
  await page.screenshot({ path: join(artifacts, "mark-paid-desktop.png"), fullPage: true });
  await page.getByRole("dialog").getByRole("button", { name: "Mark as paid", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const financial = (await admin("GET", "/finance/report")).json();
  assert.equal(financial.received, 150000);
  assert.equal(financial.salesValue, 150000);
  assert.equal(financial.outstanding, 0);
  // A longer recipient list uses the searchable picker. Its manual-delivery
  // option deliberately has an empty ID and must still satisfy required choice.
  for (let index = 0; index < 8; index++) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/license-requests",
      remoteAddress: "192.0.2." + (index + 1),
      headers: { authorization: "Bearer " + randomBytes(32).toString("hex") },
      payload: {
        id: randomUUID(),
        productId: "default",
        plan: "standard",
        name: "Pending buyer " + index,
        email: `pending${index}@example.test`,
      },
    });
    assert.equal(response.statusCode, 202, response.body);
  }
  await page.goto(origin + "/");
  await page.getByRole("button", { name: "Issue license", exact: true }).click();
  await choose(page, "Customer / delivery", "Manual delivery / service customer");
  await page.getByLabel("Customer name", { exact: true }).fill("Paid Buyer");
  await page.getByRole("checkbox", { name: "Already paid", exact: true }).click();
  await page.getByLabel("Transaction reference", { exact: true }).fill("BANK-BROWSER-2");
  await page.screenshot({ path: join(artifacts, "issue-paid-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("dialog").evaluate((e) => {
    e.scrollTop = 0;
  });
  await page.screenshot({ path: join(artifacts, "issue-paid-mobile.png"), fullPage: true });
  assert.equal(
    await page.getByRole("dialog").evaluate((e) => e.scrollWidth > e.clientWidth),
    false,
  );
  await page.getByRole("dialog").evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  await page.screenshot({ path: join(artifacts, "issue-paid-mobile-payment.png"), fullPage: true });
  const paidResponse = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/admin/products/default/licenses"),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Issue license", exact: true })
    .click();
  assert.equal((await (await paidResponse).json()).sale.status, "paid");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.goto(origin + "/settings");
  await page.getByRole("heading", { name: "Profile image", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "account-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(artifacts, "account-desktop.png"), fullPage: true });
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await page.getByRole("combobox", { name: "Show notifications", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Backups", exact: true }).click();
  await page.getByRole("heading", { name: "Manual download", exact: true }).waitFor();
  await page.goto(origin + "/reports/financial");
  await page.getByRole("button", { name: "Export balances CSV", exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "financial-report-desktop.png"), fullPage: true });
  await customer.setViewportSize({ width: 390, height: 844 });
  await customer.goto(privateLink);
  await customer.getByRole("button", { name: "Retrieve license key", exact: true }).waitFor();
  await customer.screenshot({ path: join(artifacts, "request-mobile.png"), fullPage: true });
  assert.equal(
    await customer.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  assert.deepEqual(failures, []);
  console.log(
    "Issuance browser checks passed: preinstallation request/private retrieval, plan-only unpaid and paid issuance, later payment, Settings tabs and responsive account layout.",
  );
} finally {
  await browser?.close();
  await app.close();
  await closeAuth(auth);
  await database.close();
  await rm(temp, { recursive: true, force: true });
}
