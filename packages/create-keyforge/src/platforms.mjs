/**
 * Deployment targets. Like generate.mjs, these are pure functions of the
 * deployer's answers so the test suite can parse every manifest they produce.
 *
 * Two rules run through this file:
 *
 *  - **Nothing carries upstream's identity.** Every manifest is written with
 *    the deployer's own project name. A scaffolded project that ships someone
 *    else's service name and home directory is worse than no manifest at all.
 *  - **No invented capability.** Where a platform has a repository manifest,
 *    one is generated. Where it does not (Koyeb declares services through CLI
 *    flags), the deployment definition is a script holding the real command —
 *    not a YAML file nothing will ever read.
 *
 * Free-tier descriptions are deliberately blunt. "Free" now means four
 * different things across these hosts, and a deployer who finds that out from
 * a bill has been failed by this file.
 */

import { commands, runtimeConfig } from "./toolchain.mjs";

/** Secrets a deployer must set on the host; never written into a manifest. */
const SECRET_ENV = [
  "LICENSE_SIGNING_KEY",
  "LICENSE_ADMIN_TOKEN",
  "LICENSE_AUTH_SECRET",
  "LICENSE_SEED_ADMIN_EMAIL",
  "LICENSE_SEED_ADMIN_PASSWORD",
];

/**
 * Every path any platform owns. The scaffolder prunes all of these and then
 * writes back only what the chosen target claims, so a project's repository
 * describes one deployment rather than seven.
 */
export const PLATFORM_PATHS = [
  "render.yaml",
  "fly.toml",
  "railway.json",
  "deploy",
  ".cpanel.yml",
  "docker-compose.yml",
  ".agents",
];

function ephemeralNote(answers, what) {
  if (answers.database === "postgres") return [];
  return [
    `${what} has no persistent disk, so the SQLite file — licenses, activations,` +
      " installations, audit log and operator accounts — is empty again after every" +
      " deploy. Either attach a disk, or set DATABASE_URL to a managed Postgres." +
      " LICENSE_SEED_ADMIN_EMAIL/PASSWORD will at least recreate your operator on boot.",
  ];
}

function seedSteps() {
  return [
    "#   then set LICENSE_SIGNING_KEY (your keygen output), LICENSE_ADMIN_TOKEN,",
    "#   LICENSE_AUTH_SECRET and the LICENSE_SEED_ADMIN_* pair in the dashboard",
  ];
}

const RENDER = {
  id: "render",
  title: "Render",
  description: "Free web service tier; sleeps when idle, no disk on free.",
  cost: "always-free",
  persistence: "ephemeral",
  files: (answers) => ({ "render.yaml": renderYaml(answers) }),
  keep: [],
  steps: (answers) => [
    "# push this repository to GitHub, then in the Render dashboard:",
    "#   New > Blueprint > pick this repo (it reads render.yaml)",
    ...seedSteps(),
    ...(answers.database === "postgres"
      ? ["# the blueprint provisions a free Postgres and wires DATABASE_URL for you"]
      : []),
  ],
  notes: (answers) => [
    ...ephemeralNote(answers, "Render's free plan"),
    "Free services sleep after inactivity; the first request after a sleep is slow.",
    ...(answers.database === "postgres"
      ? ["Render's free Postgres instances expire — check the current term before relying on one."]
      : []),
  ],
};

function renderYaml(answers) {
  const name = answers.packageName;
  const run = commands(answers.packageManager);
  const build =
    answers.packageManager === "vp"
      ? 'set -o pipefail && curl -fsSL https://vite.plus | VP_HOME="$HOME/.vite-plus" VP_VERSION=1.1.0 VP_NODE_MANAGER=no bash && export PATH="$HOME/.vite-plus/bin:$PATH" && NODE_ENV=development vp install --no-frozen-lockfile && vp run build:all'
      : `${run.install} && ${run.run("build")} && ${run.installIn("ui")} && ${run.runIn("ui", "build")}`;
  const lines = [
    `# Render blueprint for ${answers.productName}.`,
    "# Dashboard > New > Blueprint, pointed at this repository.",
    "services:",
    "  - type: web",
    `    name: ${name}`,
    "    runtime: node",
    "    plan: free",
    "    autoDeploy: true",
    // A plain install rather than the frozen one: a freshly scaffolded project
    // may not have committed its lockfile yet, and a first deploy that fails on
    // a missing lockfile is a bad introduction. Switch to the frozen form once
    // the lockfile is in the repository.
    `    buildCommand: ${build}`,
    `    startCommand: ${runtimeConfig(answers.runtime).startCommand}`,
    "    healthCheckPath: /healthz",
    "    envVars:",
    "      - key: NODE_VERSION",
    `        value: ${runtimeConfig(answers.runtime).version}`,
    "      - key: LICENSE_HOST",
    "        value: 0.0.0.0",
  ];
  if (answers.database === "postgres") {
    lines.push(
      "      - key: DATABASE_URL",
      "        fromDatabase:",
      `          name: ${name}-db`,
      "          property: connectionString",
    );
  } else {
    lines.push(
      "      # Free plan has no persistent disk: this file starts empty after every",
      "      # deploy. Attach a disk (paid) or switch to DATABASE_URL for real data.",
      "      - key: LICENSE_DB_PATH",
      "        value: ./db/licenses.sqlite",
    );
  }
  lines.push("      # Set these in the dashboard — they are never stored in this file.");
  for (const key of SECRET_ENV) lines.push(`      - key: ${key}`, "        sync: false");
  if (answers.database === "postgres") {
    lines.push("", "databases:", `  - name: ${name}-db`, "    plan: free");
  }
  return `${lines.join("\n")}\n`;
}

const FLY = {
  id: "fly",
  title: "Fly.io",
  description: "Pay-as-you-go with trial credit — no permanent free tier since 2024.",
  cost: "trial-credit",
  persistence: "durable",
  files: (answers) => ({ "fly.toml": flyToml(answers) }),
  keep: [],
  steps: (answers) => [
    "fly launch --no-deploy --copy-config   # keeps the fly.toml in this repo",
    ...(answers.database === "sqlite"
      ? [`fly volumes create ${volumeName(answers)} --size 1`]
      : ["fly postgres create   # then: fly postgres attach <name>"]),
    `fly secrets set ${SECRET_ENV.slice(0, 3).join("=… ")}=…`,
    "fly deploy",
  ],
  notes: (answers) => [
    "Fly removed its permanent free tier in late 2024: new accounts get trial credit," +
      " then pay for what runs. Check current pricing before deploying.",
    ...(answers.database === "sqlite"
      ? [
          "The SQLite file lives on a Fly volume, so it survives deploys — but a volume" +
            " is tied to one machine. Keep this app at a single machine, or move to Postgres.",
        ]
      : []),
  ],
};

function volumeName(answers) {
  return `${answers.packageName.replace(/-/g, "_")}_data`;
}

function flyToml(answers) {
  const sqlite = answers.database === "sqlite";
  const lines = [
    `# Fly.io configuration for ${answers.productName}.`,
    "# Create the app with: fly launch --no-deploy --copy-config",
    `app = "${answers.packageName}"`,
    'primary_region = "iad"',
    "",
    "[build]",
    '  dockerfile = "Dockerfile"',
    "",
    "[env]",
    '  LICENSE_HOST = "0.0.0.0"',
    '  LICENSE_PORT = "8080"',
  ];
  if (sqlite) lines.push('  LICENSE_DB_PATH = "/data/licenses.sqlite"');
  lines.push(
    "",
    "# Secrets (never in this file): set them with",
    `#   fly secrets set ${SECRET_ENV.join(" ")}`,
    "",
    "[http_service]",
    "  internal_port = 8080",
    "  force_https = true",
    '  auto_stop_machines = "stop"',
    "  auto_start_machines = true",
    "  min_machines_running = 0",
    "",
    "  [[http_service.checks]]",
    '    grace_period = "10s"',
    '    interval = "30s"',
    '    method = "GET"',
    '    path = "/healthz"',
    '    timeout = "5s"',
  );
  if (sqlite) {
    lines.push(
      "",
      "# The ledger lives on a volume, so it survives deploys. A volume belongs to",
      "# one machine: do not scale this app past a single instance on SQLite.",
      "[mounts]",
      `  source = "${volumeName(answers)}"`,
      '  destination = "/data"',
    );
  }
  return `${lines.join("\n")}\n`;
}

const RAILWAY = {
  id: "railway",
  title: "Railway",
  description: "Trial credit, then roughly $5/month — usage billed on top.",
  cost: "trial-credit",
  persistence: "ephemeral",
  files: (answers) => ({ "railway.json": railwayJson(answers) }),
  keep: [],
  steps: (answers) => [
    "railway init            # or link this repo from the Railway dashboard",
    ...(answers.database === "postgres"
      ? ["railway add --database postgres   # DATABASE_URL is injected for you"]
      : ["# add a volume mounted where LICENSE_DB_PATH points, or data resets on deploy"]),
    `railway variables --set ${SECRET_ENV[0]}=…   # repeat for each secret`,
    "railway up",
  ],
  notes: (answers) => [
    "Railway's free allowance is trial credit, not an ongoing free tier — a service" +
      " that stays up costs money. Check current pricing before deploying.",
    ...ephemeralNote(answers, "A Railway service without a volume"),
    "Railway injects PORT; this service reads it when LICENSE_PORT is unset.",
  ],
};

function railwayJson(answers) {
  return `${JSON.stringify(
    {
      $schema: "https://railway.com/railway.schema.json",
      build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
      deploy: {
        healthcheckPath: "/healthz",
        restartPolicyType: "ON_FAILURE",
        restartPolicyMaxRetries: 3,
        ...(answers.database === "sqlite" ? { numReplicas: 1 } : {}),
      },
    },
    null,
    2,
  )}\n`;
}

const KOYEB = {
  id: "koyeb",
  title: "Koyeb",
  description: "One genuinely free instance per organization (512MB, 0.1 vCPU).",
  cost: "always-free",
  persistence: "ephemeral",
  files: (answers) => ({ "deploy/koyeb.sh": koyebScript(answers) }),
  keep: [],
  steps: () => [
    "# edit deploy/koyeb.sh with your GitHub repository, then:",
    "bash deploy/koyeb.sh",
  ],
  notes: (answers) => [
    "Koyeb's free instance is one per organization and has no persistent volume.",
    ...ephemeralNote(answers, "Koyeb's free instance"),
  ],
};

function koyebScript(answers) {
  const sqlite = answers.database === "sqlite";
  const env = [
    "    --env LICENSE_HOST=0.0.0.0 \\",
    "    --env LICENSE_PORT=8000 \\",
    ...(sqlite
      ? ["    --env LICENSE_DB_PATH=./db/licenses.sqlite \\"]
      : ["    --env DATABASE_URL='{{secret.DATABASE_URL}}' \\"]),
    ...SECRET_ENV.map((key) => `    --env ${key}='{{secret.${key}}}' \\`),
  ];
  return `#!/usr/bin/env bash
# Deployment definition for ${answers.productName} on Koyeb.
#
# Koyeb has no repository manifest — services are declared through CLI flags,
# so this script *is* the configuration. Keep it in version control and edit it
# rather than clicking through the dashboard.
#
# Prerequisites:
#   koyeb login
#   koyeb secrets create LICENSE_SIGNING_KEY   # once per secret below
set -euo pipefail

APP="${answers.packageName}"
REPO="github.com/your-account/${answers.packageName}"
BRANCH="main"

koyeb app create "$APP" 2>/dev/null || echo "app $APP already exists"

koyeb service create web \\
    --app "$APP" \\
    --git "$REPO" \\
    --git-branch "$BRANCH" \\
    --git-builder docker \\
    --instance-type free \\
    --regions fra \\
    --scale 1 \\
    --ports 8000:http \\
    --routes /:8000 \\
    --checks 8000:http:/healthz \\
${env.join("\n")}
    --env NODE_ENV=production
`;
}

const DOCKER = {
  id: "docker",
  title: "Docker / any VPS",
  description: "Your own machine or VPS. Durable, costs whatever the box costs.",
  cost: "self-hosted",
  persistence: "durable",
  files: (answers) => ({ "docker-compose.yml": composeYaml(answers) }),
  keep: [],
  steps: (answers) => [
    "# put the same variables from .env.local into .env (Compose reads it)",
    answers.database === "postgres"
      ? "docker compose up --build       # ledger and postgres together"
      : "docker compose up --build       # SQLite in the named volume",
  ],
  notes: (answers) => [
    answers.database === "postgres"
      ? "The compose file runs Postgres beside the service; its data lives in a named volume."
      : "The SQLite ledger lives in a named volume, so it survives container rebuilds.",
  ],
};

function composeYaml(answers) {
  const name = answers.packageName;
  const postgres = answers.database === "postgres";
  const lines = [
    `# ${answers.productName} — Docker Compose deployment.`,
    "# Secrets come from a .env file beside this one (Compose substitutes them).",
    "services:",
    `  ${name}:`,
    "    build: .",
    "    ports:",
    '      - "4100:4100"',
    "    volumes:",
    `      - ${name}-data:/data`,
    "      - ./keyforge.config.json:/app/keyforge.config.json:ro",
    "    environment:",
    "      # Required: the PEM private key (or mount a file and set _FILE).",
    "      LICENSE_SIGNING_KEY: ${LICENSE_SIGNING_KEY:?set it in .env}",
    "      # Optional surfaces — each stays disabled while unset.",
    "      LICENSE_ADMIN_TOKEN: ${LICENSE_ADMIN_TOKEN:-}",
    "      LICENSE_AUTH_SECRET: ${LICENSE_AUTH_SECRET:-}",
    "      LICENSE_SEED_ADMIN_EMAIL: ${LICENSE_SEED_ADMIN_EMAIL:-}",
    "      LICENSE_SEED_ADMIN_PASSWORD: ${LICENSE_SEED_ADMIN_PASSWORD:-}",
    "      LICENSE_SERVER_URL: ${LICENSE_SERVER_URL:-}",
  ];
  if (postgres) {
    lines.push(
      "      # Compose does not nest substitutions: change POSTGRES_PASSWORD and you",
      "      # must set DATABASE_URL to match.",
      "      DATABASE_URL: ${DATABASE_URL:-postgres://keyforge:keyforge@postgres:5432/keyforge}",
      "    depends_on:",
      "      postgres:",
      "        condition: service_healthy",
      "",
      "  postgres:",
      "    image: postgres:18.6",
      "    environment:",
      "      POSTGRES_USER: keyforge",
      "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-keyforge}",
      "      POSTGRES_DB: keyforge",
      "    volumes:",
      `      - ${name}-pgdata:/var/lib/postgresql`,
      "    healthcheck:",
      '      test: ["CMD-SHELL", "pg_isready -U keyforge"]',
      "      interval: 10s",
      "      timeout: 5s",
      "      retries: 5",
    );
  } else {
    lines.push(
      "      # Unset = SQLite in the named volume above.",
      "      DATABASE_URL: ${DATABASE_URL:-}",
    );
  }
  lines.push("", "volumes:", `  ${name}-data:`);
  if (postgres) lines.push(`  ${name}-pgdata:`);
  return `${lines.join("\n")}\n`;
}

const CPANEL = {
  id: "cpanel",
  title: "cPanel / Passenger",
  description: "Shared hosting you already pay for. Deploys prebuilt artifacts.",
  cost: "your-own-host",
  persistence: "durable",
  files: (answers) => ({ ".cpanel.yml": cpanelYaml(answers) }),
  // The cPanel deployment notes are the one piece of upstream guidance that
  // stays relevant for this target.
  keep: [".agents"],
  steps: (answers) => [
    commands(answers.packageManager).run("build:all").padEnd(24) +
      "# cPanel deploys artifacts; never build on the host",
    "git add -f dist && git commit -m 'Deploy build'",
    "# then pull the repository from cPanel's Git Version Control page",
  ],
  notes: (answers) => [
    answers.cpanelUser
      ? `.cpanel.yml deploys to /home/${answers.cpanelUser}/repo/${answers.packageName}.`
      : "Edit CPANEL_USER in .cpanel.yml before deploying — it is a placeholder.",
    "Passenger starts the app itself, so dist/ must be committed: build locally or in CI.",
  ],
};

function cpanelYaml(answers) {
  const user = answers.cpanelUser || "<your-cpanel-user>";
  return `---
# Deploys prebuilt artifacts for ${answers.productName}.
# Build locally or in CI (${commands(answers.packageManager).run("build:all")}); never build inside cPanel.
deployment:
  tasks:
    - |
      export CPANEL_USER="${user}"
      export APP_DIR="/home/$CPANEL_USER/repo/${answers.packageName}"

      # 1. Directories Passenger and the SQLite ledger need.
      /bin/mkdir -p "$APP_DIR" "$APP_DIR/tmp" "$APP_DIR/db"

      # 2. Only the runtime artifacts: compiled server, console, CLI.
      /bin/cp -R dist "$APP_DIR/"
      /bin/cp dist/runtime-package.json "$APP_DIR/package.json"
      /bin/cp dist/runtime-pnpm-workspace.yaml "$APP_DIR/pnpm-workspace.yaml"
      /bin/cp -R scripts "$APP_DIR/"
      /bin/cp keyforge.config.json "$APP_DIR/" 2>/dev/null || true

      # 3. Never overwrite a live ledger — create it only when absent.
      if [ ! -f "$APP_DIR/db/licenses.sqlite" ]; then
        /bin/touch "$APP_DIR/db/licenses.sqlite"
      fi

      # 4. Restart Passenger so the new build is served.
      /bin/touch "$APP_DIR/tmp/restart.txt"
`;
}

const LOCAL = {
  id: "local",
  title: "Local / decide later",
  description: "Run it on this machine. No deployment files; add one any time.",
  cost: "self-hosted",
  persistence: "local",
  files: () => ({}),
  keep: [],
  steps: () => [],
  notes: () => [],
};

export const PLATFORMS = [LOCAL, DOCKER, RENDER, FLY, RAILWAY, KOYEB, CPANEL];

export const DEFAULT_PLATFORM = "local";

export function isPlatform(value) {
  return PLATFORMS.some((entry) => entry.id === value);
}

export function getPlatform(id) {
  const found = PLATFORMS.find((entry) => entry.id === id);
  if (!found) {
    throw new Error(
      `Unknown deployment target ${JSON.stringify(id)}. ` +
        `Valid targets: ${PLATFORMS.map((entry) => entry.id).join(", ")}.`,
    );
  }
  return found;
}

/** Files to write for the chosen target: { relativePath: contents }. */
export function platformFiles(answers) {
  return getPlatform(answers.platform).files(answers);
}

/** Template paths this target needs that the platform prune would remove. */
export function platformKeeps(answers) {
  return getPlatform(answers.platform).keep;
}

/** Deployment commands, appended after the build-and-seed sequence. */
export function platformSteps(answers) {
  return getPlatform(answers.platform).steps(answers);
}

/** Warnings worth reading before deploying — ephemeral disks, real costs. */
export function platformNotes(answers) {
  return getPlatform(answers.platform).notes(answers);
}

/** Secrets the deployer must set on the host themselves. */
export function platformSecrets() {
  return [...SECRET_ENV];
}
