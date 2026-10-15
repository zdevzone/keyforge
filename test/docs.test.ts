import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildLicenseApp } from "../src/app.js";
import { LicenseDatabase } from "../src/db.js";
import { generateSigningKeyPair } from "../src/sign.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
test("every registered HTTP route is documented", async () => {
  const routes: string[] = [];
  const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  const app = await buildLicenseApp({
    database,
    privateKey: generateSigningKeyPair().privateKey,
    uiDir: join(root, ".no-ui"),
    onRoute: (method, url) => {
      if (method !== "HEAD") routes.push(url);
    },
  });
  try {
    await app.ready();
    assert.ok(routes.length >= 50);
    assert.deepEqual(
      [...new Set(routes)].filter((route) => !read("docs/api.md").includes(route)),
      [],
    );
  } finally {
    await app.close();
    await database.close();
  }
});
test("domain error codes are documented across all route modules", () => {
  const codes = new Set<string>();
  for (const path of [
    "src/app.ts",
    "src/platform.ts",
    "src/license-delivery.ts",
    "src/finance.ts",
    "src/notifications.ts",
    "src/platform-store.ts",
    "src/backups.ts",
    "src/system-reset.ts",
    "src/maintenance.ts",
    "src/backup-destinations.ts",
  ])
    for (const pattern of [
      /new DomainError\(\s*"([a-z_]+)"/g,
      /fail\(reply,\s*\d+,\s*"([a-z_]+)"/g,
      /error:\s*"([a-z_]+)"/g,
    ])
      for (const match of read(path).matchAll(pattern)) codes.add(match[1]);
  assert.ok(codes.size >= 50);
  assert.deepEqual(
    [...codes].filter((code) => !read("docs/api.md").includes("`" + code + "`")),
    [],
  );
});
test("every administrative CLI command is documented using Vite+", () => {
  for (const [file, script] of [
    ["scripts/license-tool.mjs", "license"],
    ["scripts/db-tool.mjs", "db"],
  ])
    for (const match of read(file).matchAll(/^\s*case "([a-z:]+)":/gm))
      assert.ok(read("docs/cli.md").includes("vp run " + script + " " + match[1]));
  for (const script of ["admin:create", "secrets:init", "backup:restore"])
    assert.ok(read("docs/cli.md").includes("vp run " + script));
});
test("project documentation uses Vite+ commands", () => {
  const offenders: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        entry.name.endsWith(".md") &&
        /\b(?:npm (?:run|install|ci|test|create)|npx\s)/.test(readFileSync(file, "utf8"))
      )
        offenders.push(file);
    }
  }
  walk(root);
  assert.deepEqual(offenders, []);
});
test("integration and operation guides are discoverable through the README documentation index", () => {
  const readme = read("README.md");
  assert.ok(readme.includes("docs/index.md"));
  const index = read("docs/index.md");
  for (const doc of [
    "api",
    "cli",
    "configuration",
    "backups",
    "deploy",
    "verify-token",
    "dependent-app-integration",
    "dependent-app-ai-context",
    "integration-review",
  ])
    assert.ok(
      readme.includes("docs/" + doc + ".md") || index.includes("(" + doc + ".md"),
      `${doc} must be linked from the README or its documentation index`,
    );
});
