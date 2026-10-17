import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Fixture-only visual coverage; never run mutations against a hosted database. */
export async function auditConsoleUI(page, origin, { licenseId, supportId }, directory) {
  await mkdir(directory, { recursive: true });
  const routes = [
    "/",
    "/products",
    "/metering",
    "/entitlements",
    "/installations",
    "/machines",
    "/license-requests",
    "/licenses/" + licenseId,
    "/support",
    "/support/" + supportId,
    "/sales",
    "/reports",
    "/reports/financial",
    "/audit",
    "/inspect",
    "/operators",
    ...["account", "preferences", "notifications", "backups", "system"].map(
      (tab) => "/settings?tab=" + tab,
    ),
    "/welcome",
    "/docs",
    "/request-license",
  ];
  const results = [];
  async function settle() {
    await page.locator("main h1").waitFor();
    await page.waitForFunction(
      () =>
        ![...document.querySelectorAll("output")].some((e) =>
          /^Loading/.test(e.textContent.trim()),
        ),
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
  }
  for (const theme of ["light", "dark"]) {
    await page.goto(origin + "/products");
    const toggle = page.getByRole("button", { name: "Switch to " + theme + " theme", exact: true });
    if (await toggle.count()) await toggle.click();
    for (const [size, width, height] of [
      ["desktop", 1440, 1000],
      ["tablet", 900, 1000],
      ["mobile", 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      for (const route of routes) {
        await page.goto(origin + route);
        await settle();
        const finding = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          const colors = new Map();
          const rgba = (color) => {
            if (!colors.has(color)) {
              ctx.clearRect(0, 0, 1, 1);
              ctx.fillStyle = color;
              ctx.fillRect(0, 0, 1, 1);
              colors.set(
                color,
                [...ctx.getImageData(0, 0, 1, 1).data].map((v) => v / 255),
              );
            }
            return colors.get(color);
          };
          const over = (a, b) => [...a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3])), 1];
          const background = (el) => {
            const layers = [];
            for (let p = el; p; p = p.parentElement) {
              const c = rgba(getComputedStyle(p).backgroundColor);
              layers.push(c);
              if (c[3] === 1) break;
            }
            return layers.reverse().reduce((b, a) => over(a, b), [1, 1, 1, 1]);
          };
          const luminance = (c) =>
            c
              .slice(0, 3)
              .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
              .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
          const contrast = [];
          for (const el of document.querySelectorAll(
            'label, p, button, input:not([type="hidden"]), textarea, [data-slot="badge"], [data-slot="table-head"]',
          )) {
            const style = getComputedStyle(el),
              rect = el.getBoundingClientRect();
            if (
              !rect.width ||
              !rect.height ||
              style.visibility === "hidden" ||
              el.closest(':disabled,[aria-disabled="true"],.sr-only') ||
              Number(style.opacity) < 1
            )
              continue;
            const text = el.matches("input,textarea")
              ? el.getAttribute("placeholder")
              : el.textContent.trim();
            if (!text) continue;
            const bg = background(el),
              fg = over(
                rgba(
                  el.matches("input,textarea")
                    ? getComputedStyle(el, "::placeholder").color
                    : style.color,
                ),
                bg,
              );
            const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
            const ratio = (a + 0.05) / (b + 0.05);
            const large =
              parseFloat(style.fontSize) >= 24 ||
              (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
            if (ratio < (large ? 3 : 4.5) - 0.03)
              contrast.push({
                text: text.slice(0, 70),
                ratio: +ratio.toFixed(2),
                color: style.color,
                background: style.backgroundColor,
              });
          }
          return { overflow: document.documentElement.scrollWidth > innerWidth, contrast };
        });
        const name = (route === "/" ? "licenses" : route.slice(1)).replaceAll(/[^a-z0-9-]/gi, "-");
        await page.screenshot({
          path: join(directory, name + "-" + theme + "-" + size + ".png"),
          fullPage: true,
        });
        results.push({ route, theme, size, ...finding });
      }
      await writeFile(join(directory, "audit.json"), JSON.stringify(results, null, 2));
      if (size === "tablet") continue;
      await page.goto(origin + "/entitlements");
      await page.getByRole("button", { name: "Add entitlement", exact: true }).click();
      const dialog = page.getByRole("dialog");
      const key = dialog.getByLabel("Permanent key", { exact: true });
      await page.keyboard.press("Tab");
      await key.focus();
      assert.deepEqual(
        await key.evaluate((e) => {
          const s = getComputedStyle(e);
          return [s.outlineWidth, s.outlineOffset, s.boxShadow];
        }),
        ["2px", "-1px", "none"],
      );
      const label = await dialog
        .locator("label")
        .filter({ hasText: "Permanent key" })
        .boundingBox();
      const control = await key.boundingBox();
      assert.ok(label.y + label.height <= control.y);
      await page.screenshot({
        path: join(directory, "definition-" + theme + "-" + size + ".png"),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Import or export catalog", exact: true }).click();
      const file = dialog.getByLabel("Load catalog JSON", { exact: true });
      const exportButton = await dialog
        .getByRole("button", { name: "Export JSON", exact: true })
        .boundingBox();
      const upload = await file.boundingBox();
      if (size === "desktop")
        assert.ok(
          Math.abs(exportButton.y + exportButton.height - upload.y - upload.height) < 3,
          "Catalog actions align at their bottom edges",
        );
      assert.ok(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth));
      await page.screenshot({
        path: join(directory, "catalog-" + theme + "-" + size + ".png"),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Search licenses and commands", exact: true }).click();
      const search = dialog.getByRole("combobox", {
        name: "Search licenses and commands",
        exact: true,
      });
      await search.focus();
      assert.deepEqual(
        await search.evaluate((e) => {
          const s = getComputedStyle(e),
            group = getComputedStyle(e.closest('[data-slot="input-group"]'));
          return [s.outlineStyle, s.boxShadow, group.outlineWidth, group.outlineOffset];
        }),
        ["none", "none", "2px", "-1px"],
      );
      await page.screenshot({
        path: join(directory, "command-" + theme + "-" + size + ".png"),
        fullPage: true,
      });
      await page.keyboard.press("Escape");
    }
  }
  await writeFile(join(directory, "audit.json"), JSON.stringify(results, null, 2));
  assert.deepEqual(
    results.filter((r) => r.overflow).map((r) => [r.route, r.theme, r.size]),
    [],
    "No page overflow",
  );
  const contrasts = results.filter((r) => r.contrast.length);
  assert.deepEqual(contrasts, [], "Text and placeholder contrast meet AA in the audited controls");
  console.log(
    `UI consistency: ${routes.length} screens × 2 themes × 3 sizes, plus focused dialogs passed.`,
  );
}
