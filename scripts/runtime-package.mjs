import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const source = JSON.parse(await readFile("package.json", "utf8"));
const dependencies = {};
for (const name of Object.keys(source.dependencies || {})) {
  let entry;
  try {
    entry = require.resolve(name + "/package.json");
  } catch {
    entry = require.resolve(name);
  }
  let directory = dirname(entry);
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (pkg.name === name) {
        dependencies[name] = pkg.version;
        break;
      }
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot resolve installed version of " + name);
    directory = parent;
  }
}
await writeFile(
  "dist/runtime-package.json",
  JSON.stringify(
    {
      name: source.name,
      version: source.version,
      private: true,
      type: "module",
      packageManager: source.packageManager,
      engines: source.engines,
      dependencies,
      overrides: source.overrides,
      scripts: { start: "node --env-file-if-exists=.env dist/src/index.js" },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  "dist/runtime-pnpm-workspace.yaml",
  "allowBuilds:\n  better-sqlite3: true\n  msgpackr-extract: false\noverrides:\n  effect: " +
    source.overrides.effect +
    "\n",
);
