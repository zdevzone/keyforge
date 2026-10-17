/**
 * Everything the scaffolder writes, as pure functions of the deployer's
 * answers. No filesystem, no network, no prompts — so the repository's own
 * test suite can feed the output of `buildConfig()` straight into the server's
 * real zod schema and prove a scaffolded project cannot start life invalid.
 *
 * That coupling is deliberate: when `src/config.ts` changes, the test breaks
 * here rather than in a stranger's terminal.
 */

import { getPlatform, platformNotes, platformSecrets, platformSteps } from "./platforms.mjs";
import { commands, devEngines, packageManagerField, runtimeConfig } from "./toolchain.mjs";

/** Kept in step with ADMIN_FEATURES in src/permissions.ts (asserted by tests). */
export const ADMIN_FEATURES = ["operators", "sessions", "bans", "impersonation"];

export const DATABASES = [
  {
    id: "sqlite",
    title: "SQLite",
    description: "One file, no server. Fine for most vendors; needs a persistent disk.",
  },
  {
    id: "postgres",
    title: "Postgres",
    description:
      "Managed database (Neon, Supabase, Render, your own). Survives hosts with no disk.",
  },
];

export const AUTH_SCOPES = [
  { id: "core", title: "core", description: "Manage operators and their sessions." },
  { id: "full", title: "full", description: "Core plus bans and impersonation." },
];

/**
 * Licensing models. These differ only in the plan presets they seed — the
 * server signs freeform entitlements and never interprets them, so a
 * "use case" is a starting shape for the issue form, not a mode the code
 * branches on. Deployers mix them freely afterwards.
 */
export const USE_CASES = [
  {
    id: "count",
    title: "Metered",
    description: "A numeric allowance per license (imports, renders, API calls).",
  },
  {
    id: "time",
    title: "Time-based",
    description: "Subscriptions that expire and are renewed.",
  },
  {
    id: "features",
    title: "Editions",
    description: "Feature flags and tiers: basic, pro, enterprise.",
  },
  {
    id: "blank",
    title: "Blank",
    description: "One plain plan; define your own entitlements later.",
  },
];

const PLAN_PRESETS = {
  count: {
    defaultPlan: "standard",
    defaultActivationLimit: 1,
    planPresets: {
      trial: { entitlements: { allowance: 500, trial: true }, durationDays: 14 },
      standard: { entitlements: { allowance: 200000 } },
      pro: { entitlements: { allowance: 1000000, pro: true }, activationLimit: 3 },
    },
  },
  time: {
    defaultPlan: "monthly",
    defaultActivationLimit: 1,
    planPresets: {
      trial: { entitlements: { tier: "full", trial: true }, durationDays: 14 },
      monthly: { entitlements: { tier: "full" }, durationDays: 31 },
      yearly: { entitlements: { tier: "full" }, durationDays: 365, activationLimit: 3 },
    },
  },
  features: {
    defaultPlan: "basic",
    defaultActivationLimit: 1,
    planPresets: {
      basic: { entitlements: { tier: "basic" } },
      pro: { entitlements: { tier: "pro", exports: true, api: true }, activationLimit: 3 },
      enterprise: {
        entitlements: { tier: "enterprise", exports: true, api: true, sso: true },
        activationLimit: 25,
      },
    },
  },
  blank: {
    defaultPlan: "standard",
    defaultActivationLimit: 1,
    planPresets: {
      standard: { entitlements: {} },
    },
  },
};

/**
 * A subscription that expires wants to hear from the server more often than a
 * perpetual license does; a month of offline grace on a monthly plan is a free
 * extra month. Everything else keeps the server's own default.
 */
const OFFLINE_GRACE_DAYS = { count: 30, time: 7, features: 30, blank: 30 };

export function isUseCase(value) {
  return USE_CASES.some((useCase) => useCase.id === value);
}

export function isDatabase(value) {
  return DATABASES.some((database) => database.id === value);
}

/**
 * Turn `--auth full|core|a,b,c` into the value `auth.admin` takes. Unknown
 * feature names are rejected here rather than at the deployer's first boot.
 */
export function parseAuthScope(value) {
  const raw = String(value ?? "").trim();
  if (raw === "core" || raw === "full") return raw;
  const features = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (features.length === 0) {
    throw new Error("--auth needs a value: full, core, or a comma-separated feature list.");
  }
  const unknown = features.filter((name) => !ADMIN_FEATURES.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown --auth feature(s): ${unknown.join(", ")}. ` +
        `Valid features are: ${ADMIN_FEATURES.join(", ")}.`,
    );
  }
  return [...new Set(features)];
}

/** Directory name -> npm-safe package name. */
export function toPackageName(directoryName) {
  const cleaned = String(directoryName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 214);
  return cleaned || "keyforge-server";
}

/** Directory name -> a product name a human would have typed. */
export function toProductName(directoryName) {
  const words = String(directoryName)
    .replace(/[-_.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1));
  return words.join(" ").slice(0, 60) || "Keyforge";
}

/**
 * Product name -> key prefix. Product keys get read aloud over the phone, so
 * the prefix is short, uppercase, and alphanumeric — the same constraint
 * `key.prefix` enforces in the server's config schema.
 */
export function toKeyPrefix(productName) {
  const words = String(productName)
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "KEY";
  // "Acme Photos" -> ACME, not ACMEPHOTOS: a prefix is read aloud with the
  // rest of the key, so the first word alone carries it unless it is too
  // short to recognise on its own.
  const first = words[0];
  return (first.length >= 3 ? first : words.join("")).slice(0, 10);
}

/**
 * The `keyforge.config.json` a scaffolded project starts with. Written out in
 * full rather than trimmed to non-defaults: the file is the deployer's map of
 * what is adjustable, and a knob they cannot see is a knob they will not turn.
 */
export function buildConfig(answers) {
  const useCase = answers.useCase ?? "blank";
  const licensing = PLAN_PRESETS[useCase] ?? PLAN_PRESETS.blank;
  return {
    branding: { name: answers.productName },
    key: { prefix: answers.keyPrefix, groupLength: 5, groups: 4 },
    tokens: { offlineGraceDays: OFFLINE_GRACE_DAYS[useCase] ?? 30 },
    limits: {
      enabled: true,
      activate: { max: 20, timeWindow: "1 minute" },
      validate: { max: 20, timeWindow: "1 minute" },
      register: { max: 30, timeWindow: "1 minute" },
      support: { max: 10, timeWindow: "1 hour" },
    },
    licenses: {
      defaultPlan: licensing.defaultPlan,
      defaultActivationLimit: licensing.defaultActivationLimit,
      planPresets: structuredClone(licensing.planPresets),
    },
    registry: { enabled: true, collectUserInfo: true },
    features: { audit: true, backups: true },
    auth: { admin: answers.authScope },
  };
}

function envBlock(lines) {
  return lines.join("\n");
}

/**
 * `.env.local` — the file every npm script in the template loads. Secrets are
 * generated, not placeheld: a deployer who never edits this file still gets a
 * unique admin token and session secret rather than a shared example value.
 * The signing key is the one thing left blank, because `npm run license
 * keygen` has to write it.
 */
export function buildEnvLocal(answers) {
  const lines = [
    `# ${answers.productName} license service — local environment.`,
    "# Secrets below were generated for this project. Never commit this file;",
    "# set the same variables in your host's dashboard when you deploy.",
    "",
    `# The trust root. Generate the pair with: ${commands(answers.packageManager).run("license")} keygen`,
    "LICENSE_SIGNING_KEY_FILE=./license-signing.key",
    "LICENSE_DATA_KEYRING_FILE=./secrets/data.keyring.json",
    "LICENSE_BACKUP_KEYRING_FILE=./secrets/backup.keyring.json",
    "",
    "# Bearer token for the admin CLI. Unset = CLI admin access disabled.",
    `LICENSE_ADMIN_TOKEN="${answers.adminToken}"`,
    "",
    "# Signs the console's session cookies. Unset = web console disabled.",
    `LICENSE_AUTH_SECRET="${answers.authSecret}"`,
    "",
    "LICENSE_PORT=4100",
    'LICENSE_SERVER_URL="http://localhost:4100/"',
    "",
  ];
  if (answers.database === "postgres") {
    lines.push(
      "# Ledger and operator accounts both live in Postgres. Any provider works;",
      "# paste the URL your provider gives you (Neon, Supabase, Render, your own).",
      "# Keep sslmode explicit on anything remote — it is a password-bearing",
      "# connection, and the driver's own default has changed between versions.",
      "DATABASE_URL=postgres://keyforge:keyforge@localhost:5432/keyforge",
      "# DATABASE_URL=postgres://user:password@ep-name-pooler.region.aws.neon.tech/neondb?sslmode=verify-full",
    );
  } else {
    lines.push(
      "# Unified SQLite database for licenses, operator accounts and sessions.",
      "LICENSE_DB_PATH=./db/licenses.sqlite",
    );
  }
  lines.push(
    "",
    "# Seed the first console operator at boot (idempotent — an existing",
    "# user's password is never changed). Handy on hosts with no shell.",
    "# LICENSE_SEED_ADMIN_EMAIL=you@example.com",
    '# LICENSE_SEED_ADMIN_PASSWORD="<long secret>"',
    "",
  );
  return envBlock(lines);
}

/** The committable twin of `.env.local`: same variables, no values. */
export function buildEnvExample(answers) {
  const lines = [
    `# ${answers.productName} license service — copy to .env.local and fill in.`,
    `# Generate the signing key pair with: ${commands(answers.packageManager).run("license")} keygen`,
    "LICENSE_SIGNING_KEY_FILE=./license-signing.key",
    "LICENSE_DATA_KEYRING_FILE=./secrets/data.keyring.json",
    "LICENSE_BACKUP_KEYRING_FILE=./secrets/backup.keyring.json",
    '# LICENSE_SIGNING_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"',
    "",
    'LICENSE_ADMIN_TOKEN="<long random string; gates the admin CLI>"',
    'LICENSE_AUTH_SECRET="<long random string; signs console session cookies>"',
    "",
    "LICENSE_PORT=4100",
    'LICENSE_SERVER_URL="http://localhost:4100/"',
    "",
  ];
  if (answers.database === "postgres") {
    lines.push(
      "# Any Postgres provider; keep sslmode explicit on a remote host.",
      "DATABASE_URL=postgres://user:password@host/dbname?sslmode=verify-full",
      "",
    );
  } else {
    lines.push("LICENSE_DB_PATH=./db/licenses.sqlite", "");
  }
  lines.push(
    "# Optional boot-time operator seeding.",
    "# LICENSE_SEED_ADMIN_EMAIL=you@example.com",
    '# LICENSE_SEED_ADMIN_PASSWORD="<long secret>"',
    "",
  );
  return envBlock(lines);
}

/** Parsers used only by the scaffolder's manifest tests; see buildPackageJson. */
const UPSTREAM_ONLY_DEV_DEPENDENCIES = ["yaml", "smol-toml", "ajv", "ajv-formats"];

/**
 * The generated project's package.json, derived from the template's so it
 * keeps every script and dependency, minus the upstream project's identity.
 */
export function buildPackageJson(templatePackageJson, answers) {
  const pkg = { ...templatePackageJson };
  // Dependencies that exist only for upstream's own scaffolder tests, which
  // are not scaffolded. Carrying them would mean installing parsers a
  // deployer never runs.
  if (pkg.devDependencies) {
    pkg.devDependencies = { ...pkg.devDependencies };
    for (const name of UPSTREAM_ONLY_DEV_DEPENDENCIES) delete pkg.devDependencies[name];
  }
  for (const group of [pkg.dependencies, pkg.devDependencies])
    if (group) {
      if (group["vite-plus"] === "catalog:") group["vite-plus"] = "1.1.0";
      if (group.vite === "catalog:") group.vite = "npm:@voidzero-dev/vite-plus-core@1.1.0";
    }
  pkg.workspaces = ["ui"];
  pkg.name = answers.packageName;
  pkg.version = "0.1.0";
  pkg.description = `${answers.productName} license service (built on Keyforge).`;
  pkg.private = true;
  for (const field of ["repository", "bugs", "homepage", "author", "keywords"]) {
    delete pkg[field];
  }
  // Both declared so every machine agrees on the toolchain. onFail is "warn",
  // never "download" -- see toolchain.mjs for why that distinction has already
  // cost this project two red pipelines.
  pkg.packageManager = packageManagerField(answers.packageManager);
  pkg.devEngines = devEngines(answers.packageManager, answers.runtime);
  // Client tooling belongs to upstream's SDK workspace, which deployments prune.
  pkg.scripts = { ...pkg.scripts };
  delete pkg.scripts["test:packages"];
  if (pkg.scripts?.build)
    pkg.scripts.build = pkg.scripts.build.replace(
      " && vp -C packages/keyforge-client run build",
      "",
    );
  if (pkg.scripts?.typecheck)
    pkg.scripts.typecheck = pkg.scripts.typecheck.replace(
      " && vp -C packages/keyforge-client run typecheck",
      "",
    );
  pkg.scripts = retargetScripts(pkg.scripts, answers.packageManager);
  return pkg;
}

/**
 * Rewrite the template's own scripts for the chosen manager.
 *
 * Easy to miss, and the reason this feature is more than cosmetic: several
 * template scripts shell out to npm by name -- `build:ui` is
 * `npm --prefix ui run build`, and `build:all` calls `npm --prefix ui ci`.
 * Those keep *working* on a pnpm or Bun project, because npm ships with Node,
 * which is exactly what makes them dangerous: `ui/` would quietly be installed
 * by npm with an npm lockfile while the rest of the project used something
 * else. Two managers, two lockfiles, one directory.
 *
 * Only the npm-invoking scripts are touched; everything else is left alone.
 *
 * @param {Record<string, string> | undefined} scripts
 * @param {import("./toolchain.d.mts").PackageManagerId} packageManager
 */
export function retargetScripts(scripts, packageManager) {
  if (!scripts) return scripts;

  const rewritten = {};
  for (const [name, value] of Object.entries(scripts)) {
    rewritten[name] = retargetNpmCommands(value, packageManager);
  }
  return rewritten;
}

/**
 * Rewrite npm invocations inside an arbitrary chunk of text.
 *
 * Shared by the package scripts and the CI workflow, both of which name npm
 * directly. `npm test` is included because it is a real npm subcommand rather
 * than a script invocation, and every other manager spells it differently.
 *
 * @param {string} text
 * @param {import("./toolchain.d.mts").PackageManagerId} packageManager
 */
export function retargetNpmCommands(text, packageManager) {
  if (packageManager !== "vp") {
    const command = commands(packageManager);
    text = text
      .replaceAll(/vp -C (\S+) run (\S+)/g, (_, dir, task) => command.runIn(dir, task))
      .replaceAll(/vp run (\S+)/g, (_, task) => command.run(task))
      .replaceAll(/vp install --frozen-lockfile/g, command.frozenInstall)
      .replaceAll(/vp install/g, command.install);
  }
  if (packageManager === "npm") return text;
  const run = commands(packageManager);
  return (
    text
      // Directory-scoped forms first: they are a superset of the plain ones, so
      // rewriting `npm run` first would strip the `--prefix` and lose the
      // directory entirely.
      // `npm run <script> -- <flags>` first: the separator belongs to npm, and
      // leaving it behind would emit `bun run license -- keycheck`, which is
      // precisely the wrongness this whole table exists to prevent.
      .replaceAll(/npm run (\S+) -- /g, (_, script) => `${run.run(script)} `)
      .replaceAll(/npm --prefix (\S+) run (\S+)/g, (_, dir, script) => run.runIn(dir, script))
      .replaceAll(/npm --prefix (\S+) ci/g, (_, dir) => run.frozenInstallIn(dir))
      .replaceAll(/npm --prefix (\S+) install/g, (_, dir) => run.installIn(dir))
      .replaceAll(/npm run (\S+)/g, (_, script) => run.run(script))
      .replaceAll(/(?<![\w-])npm ci(?![\w-])/g, run.frozenInstall)
      .replaceAll(/(?<![\w-])npm install(?![\w-])/g, run.install)
      .replaceAll(/(?<![\w-])npm test(?![\w-])/g, run.run("test"))
  );
}

/**
 * Retarget a reference document, including the one section that is npm-only.
 *
 * docs/cli.md opens by explaining that npm swallows `--flags` after a script
 * name, which is true and important — for npm. Rewriting its commands without
 * touching the prose would leave a pnpm project with a section warning about a
 * bug it cannot have, illustrated by two now-identical examples.
 *
 * @param {string} contents
 * @param {import("./toolchain.d.mts").PackageManagerId} packageManager
 */
export function retargetDocs(contents, packageManager) {
  if (packageManager === "npm") return retargetNpmCommands(contents, packageManager);
  const replaced = contents.replace(
    /## Passing flags through npm\n[\s\S]*?\nEvery example below uses the form that works\.\n/,
    `## Passing flags through ${packageManager}\n\n` +
      `${packageManager} passes flags straight through to the script, so commands read the\n` +
      "way you would write them. (npm is the exception: it swallows flags after a\n" +
      "script name unless you separate them with `--`, which is why upstream's own\n" +
      "documentation is written that way.)\n",
  );

  // One section is left exactly as written: "If you re-run `vp migrate`"
  // explains npm's own devEngines behaviour, so its `npm install` is the
  // subject of the sentence rather than an instruction to this project. A
  // substitution there produces "npm 10 rejects the field and `bun install`
  // exits 1", which is not true of anything.
  const { before, protectedSection, after } = carveOut(replaced, "## If you re-run `vp migrate`");

  // Only rewrite inside code — fenced blocks and inline spans. Rewriting prose
  // corrupts it: "npm 10 rejects the field and `npm install` exits 1" is a
  // sentence *about npm*, and a blanket substitution turns it into
  // "npm 10 rejects the field and `bun install` exits 1", which is nonsense.
  // Commands live in code; explanations live in prose.
  const rewrite = (text) =>
    text
      .replace(/```[\s\S]*?```/g, (block) => retargetNpmCommands(block, packageManager))
      // Inline spans may wrap across a newline in hand-wrapped markdown, which is
      // how `npm run\nbuild:all` slipped through a single-line pattern.
      .replace(/`[^`]*`/g, (span) =>
        retargetNpmCommands(span.replace(/\s*\n\s*/g, " "), packageManager) ===
        span.replace(/\s*\n\s*/g, " ")
          ? span
          : retargetNpmCommands(span.replace(/\s*\n\s*/g, " "), packageManager),
      );

  return rewrite(before) + protectedSection + rewrite(after);
}

/**
 * Carve one section out of a document, from its heading to the next top-level
 * heading. Bounded on purpose: an unbounded split protected everything that
 * followed, including the `admin:create` reference, and left npm commands in a
 * Bun project's own documentation.
 */
function carveOut(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return { before: text, protectedSection: "", after: "" };
  const rest = text.slice(start + heading.length);
  const nextTop = rest.search(/\n# /);
  const end = nextTop === -1 ? text.length : start + heading.length + nextTop;
  return {
    before: text.slice(0, start),
    protectedSection: text.slice(start, end),
    after: text.slice(end),
  };
}

/**
 * Rewrite the copied GitHub Actions workflow for the chosen manager.
 *
 * The same trap as the Dockerfile, and one a generated project would only find
 * on its first push: `actions/setup-node` gives the runner npm and corepack,
 * so a pnpm project whose workflow still says `npm ci` installs with the wrong
 * manager and ignores its own lockfile.
 *
 * @param {string} contents
 * @param {import("./toolchain.d.mts").PackageManagerId} packageManager
 */
export function retargetWorkflow(contents, packageManager) {
  // Package release tests belong to upstream, whose workspaces are pruned.
  contents = contents.replace(/^      - if: .*\n        run: vp run test:packages\n/gm, "");
  if (packageManager === "npm") return contents;
  const run = commands(packageManager);
  const prepare =
    packageManager === "vp"
      ? "npm install -g vite-plus@1.1.0"
      : run.corepack
        ? `corepack enable && corepack prepare ${packageManagerField(packageManager)} --activate`
        : `npm install -g ${packageManagerField(packageManager)}`;

  const rewritten = retargetNpmCommands(contents, packageManager);

  // One preparation step per job, immediately after the setup-node step that
  // puts npm and corepack on the runner in the first place.
  return rewritten.replaceAll(
    /^(\s*)- uses: actions\/setup-node@[^\s]+(?:[ \t]+#[^\n]*)?\n((?:\1  .*\n)*)/gm,
    (match, indent, _block) =>
      `${match}${indent}- name: Enable ${packageManager}\n${indent}  run: ${prepare}\n`,
  );
}

/**
 * Rewrite the copied Dockerfile's install lines for the chosen manager.
 *
 * The only place the scaffolder edits a template file rather than writing or
 * replacing one, so it is deliberately narrow: it rewrites the lockfile COPY
 * lines and the install commands, and nothing else. The base images and the
 * layer structure are upstream's and stay upstream's.
 *
 * It **throws** when the expected lines are absent. A Dockerfile that silently
 * kept `npm ci` while the project used pnpm would fail at image-build time on
 * the deployer's machine, with nothing pointing back at the scaffolder; a
 * missing pattern here means upstream's Dockerfile changed shape and this
 * function needs updating, which is worth failing the scaffold to say.
 *
 * @param {string} contents
 * @param {{ packageManager: import("./toolchain.d.mts").PackageManagerId }} answers
 */
export function retargetDockerfileContents(contents, packageManagerOrAnswers) {
  const id =
    typeof packageManagerOrAnswers === "string"
      ? packageManagerOrAnswers
      : packageManagerOrAnswers.packageManager;
  if (!contents.includes("# KEYFORGE_TOOLCHAIN_TEMPLATE"))
    throw new Error(
      "The template Dockerfile no longer has the toolchain marker. Update retargetDockerfileContents.",
    );
  const run = commands(id),
    runtime = runtimeConfig("node");
  const production =
    id === "yarn"
      ? "vp pm workspaces focus -A --production"
      : id === "npm"
        ? "vp install --frozen-lockfile --omit=dev"
        : "vp install --frozen-lockfile --prod";
  return [
    "# KEYFORGE_TOOLCHAIN_TEMPLATE",
    "FROM " + runtime.dockerImage + " AS build",
    "WORKDIR /app",
    "RUN npm install -g vite-plus@1.1.0",
    "COPY package.json " + run.lockfile + " pnpm-workspace.yaml ./",
    "COPY ui/package.json ui/",
    "RUN vp install --frozen-lockfile",
    "COPY tsconfig.json tsconfig.test.json ./",
    "COPY src src",
    "COPY scripts scripts",
    "COPY docs docs",
    "COPY ui ui",
    "RUN " + run.run("build") + " && " + run.runIn("ui", "build"),
    "FROM " + runtime.dockerImage + " AS deps",
    "WORKDIR /app",
    "RUN npm install -g vite-plus@1.1.0",
    "COPY package.json " + run.lockfile + " pnpm-workspace.yaml ./",
    "COPY ui/package.json ui/",
    "RUN " + production,
    "FROM postgres:18.6-bookworm AS pgtools",
    "FROM " + runtime.dockerSlimImage,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "RUN apt-get update && apt-get install -y --no-install-recommends libpq5 liblz4-1 libzstd1 ca-certificates && rm -rf /var/lib/apt/lists/*",
    "COPY --from=pgtools /usr/lib/postgresql/18/bin/pg_dump /usr/lib/postgresql/18/bin/pg_restore /usr/local/bin/",
    "COPY --from=pgtools /usr/lib/x86_64-linux-gnu/libpq.so.5* /usr/lib/x86_64-linux-gnu/",
    "COPY --from=deps /app/node_modules node_modules",
    "COPY --from=build /app/dist dist",
    "COPY --from=build /app/dist/runtime-package.json package.json",
    "COPY scripts scripts",
    "ENV LICENSE_DB_PATH=/data/licenses.sqlite",
    "ENV LICENSE_HOST=0.0.0.0",
    "VOLUME /data",
    "EXPOSE 4100",
    'CMD ["node", "dist/src/index.js"]',
    "",
  ].join("\n");
}

export function nextSteps(answers) {
  const run = commands(answers.packageManager);
  const steps = [
    `cd ${answers.relativeDirectory}`,
    ...(answers.installed ? [] : [run.install]),
    `${run.run("license")} keygen`.padEnd(29) + "# writes the signing key pair into db/",
  ];
  if (answers.database === "postgres") {
    steps.push("# point DATABASE_URL at your Postgres instance in .env.local");
  }
  steps.push(
    run.run("build:all").padEnd(29) + "# server -> dist/, console -> dist/public",
    run.runWithFlags("admin:create", '--email you@example.com --password "<strong-password>"'),
    run.run("start").padEnd(29) + "# console on http://localhost:4100/",
  );
  const deploy = platformSteps(answers);
  if (deploy.length > 0) {
    steps.push(`# deploy to ${getPlatform(answers.platform).title}:`, ...deploy);
  }
  return steps;
}

function describeAuthScope(scope) {
  if (scope === "core") return "core — manage operators and their sessions";
  if (scope === "full") return "full — operators, sessions, bans, impersonation";
  return `${scope.join(", ")}`;
}

/**
 * The scaffolded project's own README. Upstream's documentation is kept
 * alongside it (as docs/keyforge.md) rather than left in place: this project
 * belongs to the deployer now, and its front page should say what *they*
 * chose, not what the template's authors did.
 */
export function buildReadme(answers) {
  const run = commands(answers.packageManager);
  const useCase = USE_CASES.find((entry) => entry.id === answers.useCase);
  const plans = Object.keys(buildConfig(answers).licenses.planPresets).join(", ");
  const database =
    answers.database === "postgres"
      ? "Postgres (set `DATABASE_URL`)"
      : "SQLite (one file, set `LICENSE_DB_PATH`)";
  return `# ${answers.productName} license service

Signed offline license tokens, activation seats, an install census, and an
admin console for ${answers.productName} — one process, one config file.

Built from [Keyforge](https://github.com/zdevzone/keyforge); the full upstream
documentation is kept in [docs/keyforge.md](docs/keyforge.md).

## This deployment

| | |
| --- | --- |
| Database | ${database} |
| Licensing model | ${useCase?.title ?? answers.useCase} — ${useCase?.description ?? ""} |
| Starting plans | ${plans} |
| Product key format | \`${answers.keyPrefix}-XXXXX-XXXXX-XXXXX-XXXXX\` |
| Operator admin scope | ${describeAuthScope(answers.authScope)} |
| Deployment target | ${getPlatform(answers.platform).title} |

Deployment policy lives in \`keyforge.config.json\`. Its catalog seeds the first
product; later plan and entitlement changes are saved in the database through
the console. Secrets live in \`.env.local\`, never in the policy file.

## Run it

\`\`\`bash
${run.install}
${`${run.run("license")} keygen`.padEnd(29)}# one-time: the Ed25519 signing key pair
${run.run("build:all").padEnd(29)}# server -> dist/, console -> dist/public
${run.runWithFlags("admin:create", '--email you@example.com --password "<strong-password>"')}
${run.run("start").padEnd(29)}# console on http://localhost:4100/
\`\`\`

The private signing key is the trust root: it exists only on this server, and
your app ships the public half to verify tokens offline. Never commit it.

## Plans

${plans
  .split(", ")
  .map((plan) => `- \`${plan}\``)
  .join("\n")}

In the console, review these plans and set an explicit ETB price before issuing
a license. Issuance selects an existing plan, snapshots its terms and price,
and records an unpaid sale or the payment you enter. Later plan changes do not
rewrite old licenses or sales. Your app enforces the signed entitlements.

## A second copy of the ledger

\`\`\`bash
${run.runWithFlags("db", "mirror --to ./standby/licenses.sqlite").padEnd(52)}# any engine, either direction
${run.runWithFlags("db", "verify --to ./standby/licenses.sqlite").padEnd(52)}# exits 1 when it drifts
\`\`\`

A mirror is a backup, not a replica — it is as old as its last run, and
promoting one is a decision you make by hand. Procedure in
[docs/backups.md](docs/backups.md).
${deploySection(answers)}`;
}

/**
 * The deployment half of the project README: the host's own commands, the
 * secrets it needs, and — the part worth writing down — what that host does
 * *not* keep. Somebody reads this six months from now wondering where their
 * licenses went.
 */
function deploySection(answers) {
  const platform = getPlatform(answers.platform);
  if (platform.id === "local") {
    return `
## Deploying

No deployment target was chosen, so this project has no host manifest. Add one
any time by scaffolding again with \`--deploy render|fly|railway|koyeb|docker|cpanel\`,
or copy the recipe you want from
[the Keyforge deployment guide](https://github.com/zdevzone/keyforge/blob/main/docs/deploy.md).
`;
  }
  const steps = platformSteps(answers);
  const notes = platformNotes(answers);
  return `
## Deploying — ${platform.title}

${platform.description}

\`\`\`bash
${steps.join("\n")}
\`\`\`

Set these on the host; they are never written into a manifest or committed:

${platformSecrets()
  .map((key) => `- \`${key}\``)
  .join("\n")}

${notes.map((note) => `> ${note}`).join("\n>\n")}
`;
}
