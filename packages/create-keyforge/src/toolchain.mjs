/**
 * The package manager and the runtime a scaffolded project will use.
 *
 * Two separate axes, on purpose. Bun is both a package manager and a runtime,
 * and the two get mixed freely — `bun install` with a Node runtime is a common
 * setup, and so is npm with Bun. Collapsing them into one "bun" choice would
 * make adding a Bun *runtime* later a rewrite rather than an entry in a table.
 *
 * Everything the scaffolder writes — the README, the next-steps list, every
 * platform manifest, the Dockerfile — goes through `commands()`, so a command
 * string appears in exactly one place per manager.
 */

/** @typedef {"npm" | "pnpm" | "yarn" | "bun"} PackageManagerId */
/** @typedef {"node"} RuntimeId */

export const PACKAGE_MANAGERS = [
  {
    id: "npm",
    title: "npm",
    description: "Ships with Node. No extra install on any host.",
  },
  {
    id: "pnpm",
    title: "pnpm",
    description: "Hard-linked store; the fastest cold install of the four.",
  },
  {
    id: "yarn",
    title: "Yarn",
    description: "Berry. Immutable installs in CI by default.",
  },
  {
    id: "bun",
    title: "Bun",
    description: "Very fast installs. The runtime stays Node here.",
  },
];

export const RUNTIMES = [
  {
    id: "node",
    title: "Node.js",
    description: "What the service is written and tested against.",
  },
  // A Bun runtime belongs here, and the shape above is built for it. It is not
  // offered yet because better-sqlite3's native binding and the pg driver both
  // need verifying under Bun first, and this service holds a signing key --
  // "probably fine" is not the standard for that.
];

/**
 * Commands per manager.
 *
 * `runWithFlags` exists because of a real papercut, and it is the one thing in
 * this file worth reading twice.
 *
 * **npm swallows flags after a script name.** `npm run license issue --plan pro`
 * *succeeds* and issues a license on the default plan, to nobody, with no
 * entitlements -- and prints a sellable product key. Nothing looks wrong. The
 * fix is `npm run license -- issue --plan pro`.
 *
 * pnpm, Yarn and Bun pass flags straight through. Emitting `--` for them would
 * teach a workaround for a bug they do not have, so the rule lives here once
 * rather than being copied into every call site from an npm example.
 *
 * @param {PackageManagerId} id
 */
export function commands(id) {
  const table = {
    npm: {
      install: "npm install",
      frozenInstall: "npm ci",
      run: (script) => `npm run ${script}`,
      // The `--` separator, and the only manager that needs it.
      runWithFlags: (script, flags) => `npm run ${script} -- ${flags}`,
      exec: (binary) => `npx ${binary}`,
      installIn: (dir) => `npm --prefix ${dir} install`,
      frozenInstallIn: (dir) => `npm --prefix ${dir} ci`,
      runIn: (dir, script) => `npm --prefix ${dir} run ${script}`,
      lockfile: "package-lock.json",
      corepack: false,
    },
    pnpm: {
      install: "pnpm install",
      frozenInstall: "pnpm install --frozen-lockfile",
      run: (script) => `pnpm ${script}`,
      runWithFlags: (script, flags) => `pnpm ${script} ${flags}`,
      exec: (binary) => `pnpm dlx ${binary}`,
      installIn: (dir) => `pnpm --dir ${dir} install`,
      frozenInstallIn: (dir) => `pnpm --dir ${dir} install --frozen-lockfile`,
      runIn: (dir, script) => `pnpm --dir ${dir} ${script}`,
      lockfile: "pnpm-lock.yaml",
      corepack: true,
    },
    yarn: {
      install: "yarn install",
      frozenInstall: "yarn install --immutable",
      run: (script) => `yarn ${script}`,
      runWithFlags: (script, flags) => `yarn ${script} ${flags}`,
      exec: (binary) => `yarn dlx ${binary}`,
      installIn: (dir) => `yarn --cwd ${dir} install`,
      frozenInstallIn: (dir) => `yarn --cwd ${dir} install --immutable`,
      runIn: (dir, script) => `yarn --cwd ${dir} ${script}`,
      lockfile: "yarn.lock",
      corepack: true,
    },
    bun: {
      install: "bun install",
      frozenInstall: "bun install --frozen-lockfile",
      run: (script) => `bun run ${script}`,
      runWithFlags: (script, flags) => `bun run ${script} ${flags}`,
      exec: (binary) => `bunx ${binary}`,
      installIn: (dir) => `bun install --cwd ${dir}`,
      frozenInstallIn: (dir) => `bun install --cwd ${dir} --frozen-lockfile`,
      runIn: (dir, script) => `bun run --cwd ${dir} ${script}`,
      lockfile: "bun.lock",
      corepack: false,
    },
  };
  const entry = table[id];
  if (!entry) throw new Error(`Unknown package manager: ${id}`);
  return entry;
}

/**
 * Pinned versions for the generated `packageManager` field.
 *
 * Pinned rather than floating because that field's whole job is to make every
 * machine agree; `npm@latest` would defeat it.
 */
const PINNED_VERSIONS = {
  npm: "10.9.7",
  pnpm: "9.15.4",
  yarn: "4.6.0",
  bun: "1.1.45",
};

/** @param {PackageManagerId} id */
export function packageManagerField(id) {
  const version = PINNED_VERSIONS[id];
  if (!version) throw new Error(`Unknown package manager: ${id}`);
  return `${id}@${version}`;
}

/** @param {RuntimeId} id */
export function runtimeConfig(id) {
  const table = {
    node: {
      // Matches what CI and the Dockerfile are tested against upstream.
      version: "22",
      dockerImage: "node:22",
      dockerSlimImage: "node:22-slim",
      startCommand: "node dist/src/index.js",
    },
  };
  const entry = table[id];
  if (!entry) throw new Error(`Unknown runtime: ${id}`);
  return entry;
}

/**
 * The devEngines block for a generated project.
 *
 * `onFail` is **"warn"**, never "download". The download mode needs npm 11+;
 * npm 10 rejects the field outright and `npm install` exits 1 before any code
 * runs, which takes CI and image builds down with it. That failure has already
 * cost this project two red pipelines, and a scaffolder that hands it to every
 * new project would spread it. Warning still tells a developer which versions
 * the project expects, without walling anyone out.
 *
 * @param {PackageManagerId} packageManager
 * @param {RuntimeId} runtime
 */
export function devEngines(packageManager, runtime) {
  return {
    runtime: { name: runtime, version: `>=${runtimeConfig(runtime).version}`, onFail: "warn" },
    packageManager: {
      name: packageManager,
      version: PINNED_VERSIONS[packageManager],
      onFail: "warn",
    },
  };
}

/** @param {unknown} value */
export function isPackageManager(value) {
  return PACKAGE_MANAGERS.some((entry) => entry.id === value);
}

/** @param {unknown} value */
export function isRuntime(value) {
  return RUNTIMES.some((entry) => entry.id === value);
}

export const DEFAULT_PACKAGE_MANAGER = "npm";
export const DEFAULT_RUNTIME = "node";
