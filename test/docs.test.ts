import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Reference documentation rots the moment someone adds a route and forgets the
 * doc. Nothing else in CI would notice: the service works, the tests pass, and
 * the gap only shows up when an integrator cannot find the endpoint they were
 * told to call.
 *
 * So these tests read the source and assert the docs mention what it contains.
 * Deliberately shallow — presence, not prose. A test that tried to check
 * whether an endpoint is described *well* would fail on every reword and get
 * deleted within a month.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const apiDoc = read("docs/api.md");
const cliDoc = read("docs/cli.md");
const appSource = read("src/app.ts");

test("every HTTP route is documented in docs/api.md", () => {
  // Route path literals, whichever verb helper registers them.
  const routes = new Set(
    [...appSource.matchAll(/\.(get|post|patch|put|delete)<[^>]*>?\s*\(\s*"([^"]+)"/g)].map(
      (match) => match[2],
    ),
  );
  for (const match of appSource.matchAll(/\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)) {
    routes.add(match[2]);
  }
  // The auth plugin registers this one through a wildcard route option.
  if (/url:\s*"\/api\/auth\/\*"/.test(appSource)) routes.add("/api/auth/*");

  assert.ok(routes.size >= 15, `expected to find the route table, found ${routes.size}`);

  const missing = [...routes].filter((route) => !apiDoc.includes(route));
  assert.deepEqual(missing, [], `undocumented routes: ${missing.join(", ")}`);
});

test("every error code the service can return is in the docs/api.md table", () => {
  // Multi-line calls included — the long messages wrap, and a code that only
  // appears in a wrapped call is exactly the kind that gets missed by hand.
  const codes = new Set(
    [...appSource.matchAll(/errorResponse\(\s*reply,\s*\d+,\s*"([a-z_]+)"/g)].map(
      (match) => match[1],
    ),
  );
  assert.ok(codes.size >= 20, `expected the error catalogue, found ${codes.size}`);

  const missing = [...codes].filter((code) => !apiDoc.includes(`\`${code}\``));
  assert.deepEqual(missing, [], `error codes missing from the table: ${missing.join(", ")}`);
});

test("every CLI command is documented in docs/cli.md", () => {
  const commands = (source: string) =>
    [...source.matchAll(/^\s*case "([a-z:]+)":/gm)].map((match) => match[1]);

  const license = commands(read("scripts/license-tool.mjs"));
  const db = commands(read("scripts/db-tool.mjs"));
  assert.ok(license.length >= 7, `expected the license commands, found ${license.join(", ")}`);
  assert.ok(db.length >= 3, `expected the db commands, found ${db.join(", ")}`);

  const missing = [
    ...license.map((name) => `npm run license -- ${name}`),
    ...db.map((name) => `npm run db -- ${name}`),
  ].filter((invocation) => !cliDoc.includes(invocation));
  assert.deepEqual(missing, [], `undocumented commands: ${missing.join(", ")}`);

  assert.match(cliDoc, /npm run admin:create/, "admin:create should be documented too");
});

/**
 * npm swallows `--flags` as its own unless `--` separates them.
 *
 * On `npm run db` that is merely annoying: the command reports a missing
 * `--from` and stops. On `npm run license` it is dangerous — `npm run license
 * issue --plan pro --to "Acme"` *succeeds*, issuing a license on the default
 * plan, to nobody, with no entitlements, and prints a sellable product key.
 * Nothing looks wrong.
 *
 * Both were found by running the documented commands rather than reading them,
 * once per milestone. This test is the cheaper replacement for that discovery.
 */
test("documented invocations pass their flags through npm", () => {
  const sources: [string, string][] = [
    ["docs/cli.md", cliDoc],
    ["README.md", read("README.md")],
    ["scripts/license-tool.mjs", read("scripts/license-tool.mjs")],
    ["scripts/db-tool.mjs", read("scripts/db-tool.mjs")],
  ];

  const offenders: string[] = [];
  for (const [name, text] of sources) {
    for (const line of text.split("\n")) {
      // The docs show the broken form once, deliberately labelled, because
      // teaching the pitfall is the point.
      if (line.includes("WRONG")) continue;
      for (const match of line.matchAll(/npm run (license|db) (?!-- )([a-z:]+)(.*)/g)) {
        // Only invocations that actually carry flags are broken by npm; a bare
        // `npm run license keygen` in prose is fine.
        if (match[3].includes("--")) offenders.push(`${name}: ${match[0].trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these need "npm run <tool> -- <command>":\n  ${offenders.join("\n  ")}`,
  );
});

/**
 * The README is an index now: the reference it used to carry inline lives under
 * docs/, and the only way there is a link. Naming two files here would let the
 * five it does not name rot unnoticed -- so read the directory, and let adding
 * a doc be what makes this fail until it is linked.
 */
test("every doc is linked from the README, so none of them can go missing", () => {
  const readme = read("README.md");
  const docs = readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md"));
  assert.ok(docs.length >= 5, "expected the docs directory to be populated");

  const unlinked = docs.filter((name) => !readme.includes(`docs/${name}`));
  assert.deepEqual(
    unlinked,
    [],
    `add these to the README's documentation table:\n  ${unlinked.join("\n  ")}`,
  );
});
