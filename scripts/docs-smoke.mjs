import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium } from "playwright";

import { buildLicenseApp } from "../dist/src/app.js";
import { configSchema } from "../dist/src/config.js";
import { LicenseDatabase } from "../dist/src/db.js";
import { generateSigningKeyPair } from "../dist/src/sign.js";

const temp = await mkdtemp(join(tmpdir(), "keyforge-docs-"));
const database = await LicenseDatabase.open({ sqlitePath: join(temp, "docs.sqlite") });
const app = await buildLicenseApp({
  database,
  privateKey: generateSigningKeyPair().privateKey,
  kid: "docs-fixture",
  config: configSchema.parse({ limits: { enabled: false } }),
  uiDir: resolve("dist/public"),
  keyring: { active: "fixture", keys: { fixture: randomBytes(32).toString("hex") } },
});
let browser;
try {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage(),
    failures = [],
    privateRequests = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("request", (request) => {
    if (/^\/(admin|api)\//.test(new URL(request.url()).pathname))
      privateRequests.push(request.url());
  });
  await page.goto(origin + "/docs/getting-started#generate-secrets");
  await page.getByRole("heading", { name: "Generate secrets", exact: true }).waitFor();
  assert.equal(await page.title(), "Beginner guide — KeyForge documentation");
  assert.ok(
    await page.locator("#generate-secrets").evaluate((el) => el.getBoundingClientRect().top >= 70),
  );
  await page
    .locator(".docs-code-block")
    .filter({ hasText: "vp run secrets:init" })
    .first()
    .getByRole("button", { name: "Copy code", exact: true })
    .click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /vp run secrets:init/);
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog");
  await search.getByRole("combobox", { name: "Search all guides" }).fill("secrets:init");
  await search
    .getByRole("option")
    .filter({ hasText: "Beginner guide / Generate secrets" })
    .first()
    .waitFor();
  await search
    .getByRole("option")
    .filter({ hasText: "Beginner guide / Generate secrets" })
    .first()
    .click();
  await page.waitForURL(/getting-started#generate-secrets$/);
  await page.getByRole("button", { name: "Search documentation" }).click();
  await page
    .getByRole("combobox", { name: "Search all guides" })
    .fill("not-a-real-documentation-topic");
  await page.getByText("No matching guides. Try fewer words or browse the navigation.").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.goto(origin + "/docs");
  await page.getByRole("heading", { name: "KeyForge documentation", exact: true }).waitFor();
  await page.getByRole("link", { name: "Skip to documentation" }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(":focus").getAttribute("id"), "docs-main");
  const apiHref = await page
    .getByRole("link", { name: "Download client OpenAPI" })
    .getAttribute("href");
  const apiResponse = await page.request.get(origin + apiHref);
  assert.equal(apiResponse.status(), 200);
  assert.equal((await apiResponse.json()).openapi, "3.1.0");
  const captures = resolve(".impeccable/review/docs");
  await mkdir(captures, { recursive: true });
  for (const [name, width, height, theme] of [
    ["desktop", 1440, 1000, "light"],
    ["desktop-dark", 1440, 1000, "dark"],
    ["mobile", 390, 844, "light"],
    ["mobile-dark", 390, 844, "dark"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((value) => localStorage.setItem("keyforge.theme", value), theme);
    await page.goto(origin + "/docs");
    await page.getByRole("heading", { name: "KeyForge documentation", exact: true }).waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    const contrast = await page.evaluate(() => {
      const canvas = document.createElement("canvas"),
        context = canvas.getContext("2d");
      const luminance = (color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const style = getComputedStyle(
        document.querySelector('.docs-navigation a[aria-current="page"]'),
      );
      const a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(contrast >= 4.5, theme + " selected navigation contrast: " + contrast);
    await page.screenshot({ path: join(captures, name + ".png"), fullPage: true });
  }
  await page.getByRole("button", { name: "Open documentation navigation" }).click();
  await page.screenshot({ path: join(captures, "mobile-navigation.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Search documentation" }).click();
  await page.getByRole("combobox", { name: "Search all guides" }).fill("signing");
  await page.screenshot({ path: join(captures, "desktop-search.png") });
  await page.keyboard.press("Escape");
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin + "/docs/getting-started#generate-secrets");
    await page.getByRole("heading", { name: "Generate secrets", exact: true }).waitFor();
    await page.screenshot({ path: join(captures, "beginner-secrets-" + name + ".png") });
  }
  await page.goto(origin + "/docs");
  await page.getByRole("button", { name: "Open documentation navigation" }).click();
  await page.getByRole("dialog").getByRole("link", { name: "Beginner guide", exact: true }).click();
  await page.getByRole("heading", { name: "Beginner guide", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "On this page", exact: true }).click();
  await page
    .getByRole("navigation", { name: "On this page", exact: true })
    .getByRole("link", { name: "Understand the keys and credentials" })
    .click();
  await page.waitForURL(/#understand-the-keys-and-credentials$/);
  for (const route of [
    "getting-started",
    "configuration",
    "cli",
    "api",
    ...(existsSync("packages/keyforge-client/README.md") ? ["sdk"] : []),
    "documentation-site",
    ...(existsSync("docs/studio-proof-contract.md") ? ["studio-proof-contract"] : []),
  ]) {
    await page.goto(origin + "/docs/" + route);
    await page.locator(".docs-prose h1").waitFor();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      route + " overflowed",
    );
  }
  await page.goto(origin + "/docs/this-guide-does-not-exist");
  await page.getByRole("heading", { name: "Guide not found" }).waitFor();
  await page.getByRole("link", { name: "Open documentation", exact: true }).click();
  await page.getByRole("heading", { name: "KeyForge documentation", exact: true }).waitFor();
  await page.goto(origin + "/help");
  await page.waitForURL(origin + "/docs");
  await page.goto(origin + "/welcome");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "Docs", exact: true }).click();
  await page.waitForURL(origin + "/docs");
  assert.deepEqual(privateRequests, []);
  assert.deepEqual(failures, []);
  console.log(
    "Documentation browser checks passed: public deep links, Markdown navigation, full-text search, keyboard, clipboard, OpenAPI, themes, mobile, missing guides and no administrative requests.",
  );
} finally {
  await browser?.close();
  await app.close();
  await database.close();
  await rm(temp, { recursive: true, force: true });
}
