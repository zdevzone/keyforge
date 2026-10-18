import { readFile, writeFile } from "node:fs/promises";

import { buildLicenseApp } from "../dist/src/app.js";
import { LicenseDatabase } from "../dist/src/db.js";
import { generateSigningKeyPair } from "../dist/src/sign.js";

const routes = [];
const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
const app = await buildLicenseApp({
  database,
  privateKey: generateSigningKeyPair().privateKey,
  uiDir: "./.no-ui",
  onRoute: (method, url) => routes.push({ method, url }),
});
try {
  await app.ready();
} finally {
  await app.close();
  await database.close();
}
const codes = new Set(["license_expired", "license_revoked", "rate_limited", "not_found"]);
for (const path of [
  "src/app.ts",
  "src/platform.ts",
  "src/license-delivery.ts",
  "src/finance.ts",
  "src/import-licensing.ts",
  "src/notifications.ts",
  "src/platform-store.ts",
  "src/backups.ts",
  "src/system-reset.ts",
  "src/maintenance.ts",
  "src/backup-destinations.ts",
  "src/backup-storage.ts",
]) {
  const source = await readFile(path, "utf8");
  for (const pattern of [
    /new DomainError\(\s*"([a-z_]+)"/g,
    /fail\(reply,\s*\d+,\s*"([a-z_]+)"/g,
    /error:\s*"([a-z_]+)"/g,
  ])
    for (const match of source.matchAll(pattern)) codes.add(match[1]);
}
const table =
  "| Method | Path |\n| --- | --- |\n" +
  routes
    .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))
    .map((r) => "| " + r.method + " | `" + r.url + "` |")
    .join("\n");
const current = await readFile("docs/api.md", "utf8");
const routeTable = /\| Method \| Path \|\r?\n\| --- \| --- \|\r?\n(?:\|[^\n]*\r?\n)*/;
const errorTable = /\| Code \|\r?\n\| --- \|\r?\n(?:\|[^\n]*\r?\n)*/;
if (!routeTable.test(current) || !errorTable.test(current))
  throw Error("API documentation table markers are missing; no documentation was changed.");
// Preserve curated contracts and manually documented errors; regenerate only the inventories.
for (const match of current.match(errorTable)[0].matchAll(/\| \x60([a-z_]+)\x60 \|/g))
  codes.add(match[1]);
const errors =
  "| Code |\n| --- |\n" +
  [...codes]
    .sort()
    .map((code) => "| \x60" + code + "\x60 |")
    .join("\n") +
  "\n";
await writeFile(
  "docs/api.md",
  current.replace(routeTable, table + "\n").replace(errorTable, errors),
);
console.log(
  "Documented " + routes.length + " registered routes and " + codes.size + " domain errors.",
);
