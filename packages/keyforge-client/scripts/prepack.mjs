import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const require = createRequire(import.meta.url);
// Works for npm publish/pack as well as vp: packing a clean checkout must
// compile the SDK rather than silently ship only its README and skill.
execFileSync(
  process.execPath,
  [
    join(dirname(require.resolve("typescript/package.json")), "bin/tsc"),
    "-p",
    fileURLToPath(new URL("tsconfig.json", root)),
  ],
  { stdio: "inherit" },
);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
for (const entry of Object.values(pkg.exports)) {
  for (const target of Object.values(entry)) {
    if (!target.startsWith("./dist/") || !statSync(new URL(target, root)).isFile())
      throw new Error(`Missing SDK package export: ${target}`);
  }
}
