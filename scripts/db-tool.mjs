/**
 * The database tool: move a ledger between databases, keep a standby in step
 * with the live one, and check that it really is in step.
 *
 * This is the counterpart to `license-tool.mjs`, and the split is deliberate.
 * That tool goes through the running service's admin API, because the service
 * owns its ledger and a second writer would eventually disagree with it. This
 * one works on databases at rest — bulk snapshots, not writes to a live
 * service — so run it against a standby, or against a ledger nothing is
 * serving.
 *
 *   npm run build          # this tool runs the compiled server code
 *   npm run db -- mirror --to ./backup/licenses.sqlite
 *
 * A mirror is a backup, not a replica: it is as old as the last time it ran,
 * and the service never writes to it. Promotion is a decision you make by
 * hand — see docs/backups.md.
 */
import { existsSync } from "node:fs";

const [, , command, ...rest] = process.argv;

function env(name) {
  const value = process.env[name];
  if (!value) return value;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function flag(name, fallback = undefined) {
  const index = rest.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = rest[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
}

function usage() {
  console.log(`Database tool — copy, mirror and compare license ledgers.

  npm run db -- copy --from <url|file> --to <url|file> [--replace]
      Copy every ledger table from one database to another, in either
      direction and across engines (SQLite <-> Postgres). The destination is
      migrated first and written in one transaction. Refuses a destination
      that already holds data unless --replace is given.

  npm run db -- mirror --to <url|file> [--from <url|file>]
      A copy aimed at a standby, safe to run on a schedule. --from defaults to
      this deployment's own database (DATABASE_URL, else LICENSE_DB_PATH), and
      --replace is implied: the standby is overwritten every run.

  npm run db -- verify --from <url|file> --to <url|file>
      Compare the two: row counts and a content checksum per table. Exits 1 on
      a mismatch, so cron can tell you the mirror stopped working.

  A target is a postgres:// URL or a SQLite file path. Only the four ledger
  tables travel; operator accounts come back through boot-time seeding
  (LICENSE_SEED_ADMIN_EMAIL / LICENSE_SEED_ADMIN_PASSWORD).

  Run \`npm run build\` first — this tool uses the compiled server code.
`);
}

/**
 * Where this deployment keeps its own ledger, read exactly as the server reads
 * it, so `mirror --to …` needs no second argument on a host.
 */
function deploymentTarget() {
  return env("DATABASE_URL") ?? env("LICENSE_DB_PATH") ?? "licenses.sqlite";
}

async function replica() {
  try {
    return await import("../dist/src/replica.js");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      console.error("Build the server first: npm run build");
      process.exit(1);
    }
    throw error;
  }
}

function fail(error) {
  console.error(error?.message ?? String(error));
  process.exit(1);
}

function requireFlag(name, value) {
  if (typeof value !== "string" || !value) {
    console.error(`Pass --${name} <postgres-url or sqlite-file>.`);
    process.exit(1);
  }
  return value;
}

/**
 * A SQLite path that does not exist is a typo, not an empty ledger — and
 * opening it would helpfully create the empty file, then copy or compare
 * nothing. Only destinations of a copy are allowed not to exist yet.
 */
function assertExists(target) {
  if (
    "sqlitePath" in target &&
    target.sqlitePath !== ":memory:" &&
    !existsSync(target.sqlitePath)
  ) {
    fail(new Error(`No such SQLite database: ${target.sqlitePath}`));
  }
}

async function copy({ fromSpec, toSpec, replace, label }) {
  const { copyLedger, describeTarget, resolveTarget } = await replica();
  const from = resolveTarget(fromSpec);
  const to = resolveTarget(toSpec);
  assertExists(from);

  console.log(`${label} ${describeTarget(from)} -> ${describeTarget(to)}`);
  const result = await copyLedger({ from, to, replace }).catch(fail);
  for (const [table, count] of Object.entries(result.copied)) {
    console.log(`  ${table.padEnd(14)} ${String(count).padStart(7)}`);
  }
  const total = Object.values(result.copied).reduce((sum, count) => sum + count, 0);
  console.log(
    `${total} row${total === 1 ? "" : "s"} copied ${result.from} -> ${result.to}` +
      `${result.replaced ? ", replacing what was there" : ""}.`,
  );
}

switch (command) {
  case "copy":
    await copy({
      fromSpec: requireFlag("from", flag("from")),
      toSpec: requireFlag("to", flag("to")),
      replace: flag("replace") === true,
      label: "Copying",
    });
    break;

  case "mirror":
    // --replace is implied: a mirror that refused to overwrite its standby
    // would work exactly once, then fail every night afterwards.
    await copy({
      fromSpec: typeof flag("from") === "string" ? flag("from") : deploymentTarget(),
      toSpec: requireFlag("to", flag("to")),
      replace: true,
      label: "Mirroring",
    });
    console.log("This is a backup, not a replica — it is as old as this run.");
    break;

  case "verify": {
    const { describeTarget, resolveTarget, verifyLedger } = await replica();
    const from = resolveTarget(
      typeof flag("from") === "string" ? flag("from") : deploymentTarget(),
    );
    const to = resolveTarget(requireFlag("to", flag("to")));
    // Both sides are read here, so neither may be conjured into existence.
    assertExists(from);
    assertExists(to);
    console.log(`Comparing ${describeTarget(from)} with ${describeTarget(to)}`);
    const result = await verifyLedger({ from, to }).catch(fail);
    for (const verdict of result.tables) {
      console.log(
        `  ${verdict.table.padEnd(14)} ${String(verdict.from).padStart(7)} ${String(
          verdict.to,
        ).padStart(7)}  ${verdict.match ? "ok" : "MISMATCH"}`,
      );
      if (verdict.difference) console.log(`    ${verdict.difference}`);
    }
    if (!result.match) {
      console.error("\nThe two databases differ. Re-run the mirror, or investigate above.");
      process.exit(1);
    }
    console.log("\nIdentical.");
    break;
  }

  default:
    usage();
    if (command) process.exit(1);
}
