import { parseArgs } from "node:util";

import {
  ADMIN_FEATURES,
  DATABASES,
  USE_CASES,
  isDatabase,
  isUseCase,
  parseAuthScope,
} from "./generate.mjs";
import { PLATFORMS, isPlatform } from "./platforms.mjs";
import { PACKAGE_MANAGERS, RUNTIMES, isPackageManager, isRuntime } from "./toolchain.mjs";

export const USAGE = `
create-keyforge — scaffold a self-hosted license server.

Usage
  node packages/create-keyforge/bin/create-keyforge.mjs <directory> [options]
  vp create keyforge -- <directory> [options]  (after package publication)

Options
  -d, --db <sqlite|postgres>   Database the ledger and operators run on.
      --auth <scope>           Operator-admin surface: full, core, or a
                               comma-separated list of ${ADMIN_FEATURES.join(", ")}.
      --use-case <model>       Plan presets to start from: ${USE_CASES.map((u) => u.id).join(", ")}.
      --deploy <target>        Where this will run: ${PLATFORMS.map((p) => p.id).join(", ")}.
                               Writes that host's deployment manifest and drops
                               the others. Defaults to local.
      --cpanel-user <name>     cPanel account name, for --deploy cpanel.
      --name <product>         Product name shown in the console and CLI.
      --key-prefix <PREFIX>    Prefix on generated product keys (e.g. ACME).
      --template <source>      Template to scaffold from: owner/repo[#ref], a
                               git URL, or a local directory. Defaults to the
                               Keyforge repository.
      --pm <manager>           Package manager: vp (default), npm, pnpm, yarn, bun.
      --runtime <runtime>      Runtime: node (default).
      --install                Install dependencies with the selected manager.
      --no-git                 Skip initializing a git repository.
      --force                  Scaffold into a non-empty directory.
  -y, --yes                    Accept defaults for anything not passed.
  -h, --help                   Show this help.
  -v, --version                Print the version.

Examples
  node packages/create-keyforge/bin/create-keyforge.mjs ../my-license-server --template .
  vp create keyforge -- acme-licensing --db postgres --auth full --use-case time -y
  vp create keyforge -- acme-licensing --auth operators,sessions,bans
  vp create keyforge -- acme-licensing --deploy render --db postgres -y
  vp create keyforge -- acme-licensing --pm vp --runtime node -y
`.trim();

/**
 * Parse argv into answers, leaving anything the deployer did not pass as
 * `undefined` so the prompts (or --yes defaults) can fill it in. Invalid
 * values are rejected here — before a template is downloaded — so a typo
 * costs a second rather than a half-written directory.
 */
export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        db: { type: "string", short: "d" },
        auth: { type: "string" },
        "use-case": { type: "string" },
        deploy: { type: "string" },
        "package-manager": { type: "string" },
        // `--pm` because nobody types the long one twice.
        pm: { type: "string" },
        runtime: { type: "string" },
        "cpanel-user": { type: "string" },
        name: { type: "string" },
        "key-prefix": { type: "string" },
        template: { type: "string" },
        install: { type: "boolean" },
        "no-git": { type: "boolean" },
        force: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    throw new Error(`${error.message}\n\n${USAGE}`);
  }

  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  if (values.version) return { version: true };

  if (positionals.length > 1) {
    throw new Error(`Expected one directory, got ${positionals.length}.\n\n${USAGE}`);
  }

  if (values.db !== undefined && !isDatabase(values.db)) {
    throw new Error(
      `Unknown --db ${JSON.stringify(values.db)}. Valid: ${DATABASES.map((d) => d.id).join(", ")}.`,
    );
  }
  if (values["use-case"] !== undefined && !isUseCase(values["use-case"])) {
    throw new Error(
      `Unknown --use-case ${JSON.stringify(values["use-case"])}. ` +
        `Valid: ${USE_CASES.map((u) => u.id).join(", ")}.`,
    );
  }
  if (values.deploy !== undefined && !isPlatform(values.deploy)) {
    throw new Error(
      `Unknown --deploy ${JSON.stringify(values.deploy)}. ` +
        `Valid targets: ${PLATFORMS.map((p) => p.id).join(", ")}.`,
    );
  }
  // --pm is an alias, so only one of the two may be given: silently preferring
  // one would make the other look broken.
  if (values["package-manager"] !== undefined && values.pm !== undefined) {
    throw new Error("Pass either --package-manager or --pm, not both.");
  }
  const packageManager = values["package-manager"] ?? values.pm;
  if (packageManager !== undefined && !isPackageManager(packageManager)) {
    throw new Error(
      `Unknown --package-manager ${JSON.stringify(packageManager)}. ` +
        `Valid: ${PACKAGE_MANAGERS.map((entry) => entry.id).join(", ")}.`,
    );
  }
  if (values.runtime !== undefined && !isRuntime(values.runtime)) {
    throw new Error(
      `Unknown --runtime ${JSON.stringify(values.runtime)}. ` +
        `Valid: ${RUNTIMES.map((entry) => entry.id).join(", ")}.`,
    );
  }

  const authScope = values.auth === undefined ? undefined : parseAuthScope(values.auth);

  if (values["key-prefix"] !== undefined && !/^[A-Z0-9]{1,10}$/.test(values["key-prefix"])) {
    throw new Error("--key-prefix must be 1-10 uppercase letters or digits, e.g. ACME.");
  }
  if (values.name !== undefined && (values.name.length < 1 || values.name.length > 60)) {
    throw new Error("--name must be between 1 and 60 characters.");
  }

  return {
    directory: positionals[0],
    database: values.db,
    authScope,
    useCase: values["use-case"],
    platform: values.deploy,
    packageManager,
    runtime: values.runtime,
    cpanelUser: values["cpanel-user"],
    productName: values.name,
    keyPrefix: values["key-prefix"],
    template: values.template,
    install: values.install === true,
    git: values["no-git"] !== true,
    force: values.force === true,
    yes: values.yes === true,
  };
}
