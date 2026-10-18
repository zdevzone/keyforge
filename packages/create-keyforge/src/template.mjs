import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, relative as relativePath } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Where `npx create-keyforge` gets the server from when nothing is passed. */
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const DEFAULT_TEMPLATE =
  "zdevzone/keyforge#" + (manifest.keyforgeRelease?.sourceSha ?? "main");

/**
 * Files that belong to the Keyforge project rather than to a deployment: git
 * history, the upstream build output, local databases and secrets, this
 * scaffolder, and upstream's own contribution paperwork. A scaffolded project
 * builds its own `dist/` and answers to its own maintainers.
 */
const PRUNE = [
  ".artifacts",
  ".impeccable/review",
  "secrets",
  "backups",
  ".git",
  ".github/FUNDING.yml",
  "node_modules",
  "ui/node_modules",
  "dist",
  "db",
  ".env",
  ".env.local",
  "packages",
  // Upstream-only release machinery. It names the repositories this
  // project is published from, which is nobody else's business.
  "tools",
  // Upstream's test for the scaffolder itself, which imports packages/ — it
  // would fail on the first `npm test` in a project that has no packages/.
  "test/create-keyforge.test.ts",
  "test/client-sdk.test.ts",
  "test/integration-contract.test.ts",
  "test/import-licensing.test.ts",
  // A dated review of upstream's deployment is not a new deployer's configuration.
  "docs/studio-proof-contract.md",
  "test/scaffold-prompts.test.ts",
  "scripts/package-smoke.mjs",
  "scripts/release-packages.mjs",
  "test/release-packages.test.ts",
  ".github/workflows/release.yml",
  ".github/workflows/deploy-production.yml",
  ".github/workflows/codeql.yml",
  ".github/CODEOWNERS",
  "scripts/deploy-production.mjs",
  "test/deployment.test.ts",
  "render.staging.yaml",
  "docs/maintaining.md",
  "examples/keyforge-node.ts",
  // Upstream's own community files. They name Keyforge's maintainer, its
  // security mailbox and its advisory URL, none of which belong in someone
  // else's project.
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  ".github/ISSUE_TEMPLATE",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/dependabot.yml",
];

/** Never copied out of a local template directory in the first place. */
const SKIP_COPY = new Set([
  "packages",
  ".artifacts",
  ".impeccable/review",
  "secrets",
  "backups",
  ".git",
  "node_modules",
  "dist",
  "db",
  ".env",
  ".env.local",
  "ui/node_modules",
  "ui/dist",
  ".vercel",
]);

/**
 * Work out what `--template` points at. A path that exists on disk wins over
 * a repository shorthand, so `--template ../keyforge` does the obvious thing
 * while developing.
 */
export async function resolveTemplate(source) {
  const raw = source ?? process.env.KEYFORGE_TEMPLATE ?? DEFAULT_TEMPLATE;
  if (raw.startsWith(".") || isAbsolute(raw)) {
    const path = resolve(raw);
    await assertDirectory(path, raw);
    return { kind: "directory", path, label: path };
  }
  const repo = parseRepository(raw);
  if (repo) return { kind: "repository", ...repo, label: `${repo.owner}/${repo.repo}#${repo.ref}` };

  // Not a known shorthand and not a URL — if it happens to be a directory,
  // take it; otherwise say so plainly rather than guessing at a download.
  const path = resolve(raw);
  if (await isDirectory(path)) return { kind: "directory", path, label: path };
  throw new Error(
    `Could not read --template ${JSON.stringify(raw)}. ` +
      "Expected owner/repo[#ref], a GitHub URL, or a local directory.",
  );
}

function parseRepository(raw) {
  const withoutPrefix = raw.replace(/^github:/, "");
  const url = withoutPrefix.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/#]+?)(?:\.git)?(?:#(.+))?$/,
  );
  if (url) return { owner: url[1], repo: url[2], ref: url[3] ?? "main" };
  const shorthand = withoutPrefix.match(/^([\w.-]+)\/([\w.-]+?)(?:#(.+))?$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2], ref: shorthand[3] ?? "main" };
  return null;
}

/**
 * Put the template's files in `destination`, degit-style: the tree only, no
 * git history, so the deployer's first commit is their own.
 */
export async function materializeTemplate(template, destination, { alsoPrune = [] } = {}) {
  await mkdir(destination, { recursive: true });
  if (template.kind === "directory") {
    await copyDirectory(template.path, destination);
  } else {
    await downloadRepository(template, destination);
  }
  await prune(destination, alsoPrune);
}

async function copyDirectory(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (source) => {
      const relative = relativePath(from, source).replaceAll("\\", "/");
      if (!relative) return true;
      const [head] = relative.split("/");
      return (
        !SKIP_COPY.has(head) &&
        !SKIP_COPY.has(relative) &&
        !(head.startsWith(".env.") && head !== ".env.example") &&
        !/\.(?:key|pem|keyring\.json)$/i.test(relative)
      );
    },
  });
}

/**
 * GitHub's tarball host. Overridable so a GitHub Enterprise deployer can point
 * at their own codeload host — and so the test suite can serve a real tarball
 * over a real socket instead of mocking the download away.
 */
const TARBALL_ORIGIN = () => process.env.KEYFORGE_TEMPLATE_ORIGIN ?? "https://codeload.github.com";

async function downloadRepository({ owner, repo, ref }, destination) {
  const url = `${TARBALL_ORIGIN()}/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  const response = await fetch(url).catch((error) => {
    throw new Error(`Could not reach GitHub: ${error.message}`);
  });
  if (response.status === 404) {
    throw new Error(
      `${owner}/${repo}#${ref} was not found (or is private). ` +
        "Pass --template owner/repo[#ref] to scaffold from a different source.",
    );
  }
  if (!response.ok || !response.body) {
    throw new Error(`Downloading ${owner}/${repo}#${ref} failed: HTTP ${response.status}.`);
  }

  const staging = await mkdtemp(join(tmpdir(), "create-keyforge-"));
  const archive = join(staging, "template.tar.gz");
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    // The tarball's single top-level directory is `repo-ref/`, hence --strip-components.
    // Do not extract upstream-only workspaces and then delete them. Vite+
    // observes those temporary package.json writes and can mistake a removed
    // workspace for the created application (especially on Windows).
    await run("tar", [
      "--exclude=*/packages",
      "--exclude=*/tools",
      "--exclude=*/node_modules",
      "--exclude=*/dist",
      "--exclude=*/.git",
      "--exclude=*/.artifacts",
      "--exclude=*/secrets",
      "--exclude=*/backups",
      "--exclude=*/db",
      "-xzf",
      archive,
      "-C",
      destination,
      "--strip-components=1",
    ]);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function prune(destination, alsoPrune = []) {
  for (const entry of [...PRUNE, ...alsoPrune]) {
    await rm(join(destination, entry), { recursive: true, force: true });
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", (error) => {
      rejectPromise(
        error.code === "ENOENT"
          ? new Error(`\`${command}\` is not available on this machine.`)
          : error,
      );
    });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`\`${command} ${args.join(" ")}\` exited with code ${code}.`));
    });
  });
}

export { run };

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function assertDirectory(path, raw) {
  if (!(await isDirectory(path))) {
    throw new Error(`--template ${JSON.stringify(raw)} is not a directory.`);
  }
}

/** True when the directory is absent or holds nothing worth worrying about. */
export async function isEmptyDirectory(path) {
  try {
    const entries = await readdir(path);
    return entries.filter((entry) => entry !== ".git" && entry !== ".DS_Store").length === 0;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}
