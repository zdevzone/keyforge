import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org/";
const exec = promisify(execFile);
const run = (command, args, cwd = root) =>
  exec(command, args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });

export const releasePackages = [
  ["keyforge-client", "@zdevzone/keyforge-client"],
  ["create-keyforge", "create-keyforge"],
  ["create-keyforge-client", "create-keyforge-client"],
];

export function assertReleaseContext(env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Automated publishing requires GitHub Actions");
  assert.equal(env.GITHUB_REPOSITORY, "zdevzone/keyforge", "Publish from the public repository");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Publish only from main");
}

export async function inspectArchives(directory, execute = run) {
  const archives = [];
  // Verify every archive before allowing the first package to be published.
  for (const [folder, name] of releasePackages) {
    const pkg = JSON.parse(await readFile(join(root, "packages", folder, "package.json"), "utf8"));
    assert.equal(pkg.name, name);
    assert.ok(!pkg.private, `${name} must be publishable`);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "Only stable versions use latest");
    const filename = name.replace(/^@/, "").replaceAll("/", "-") + "-" + pkg.version + ".tgz";
    const path = join(directory, filename);
    const bytes = await readFile(path);
    const entries = (await execute("tar", ["-tzf", path])).stdout.trim().split(/\r?\n/);
    assert.ok(entries.includes("package/package.json"), `Missing manifest in ${filename}`);
    assert.ok(
      entries.every(
        (entry) =>
          entry.startsWith("package/") &&
          !entry
            .split("/")
            .some((part) => /^(?:\.\.|\.env(?:\..*)?|node_modules|secrets|backups)$/.test(part)) &&
          !/\.(?:pem|sqlite(?:-.*)?|key|keyring\.json)$/.test(entry),
      ),
      `Unexpected or sensitive file in ${filename}`,
    );
    const packed = JSON.parse(
      (await execute("tar", ["-xOf", path, "package/package.json"])).stdout,
    );
    assert.equal(packed.name, name);
    assert.equal(packed.version, pkg.version);
    assert.ok(!packed.private, `Packed ${name} must be publishable`);
    assert.equal(packed.repository?.url, "git+https://github.com/zdevzone/keyforge.git");
    const targets = [
      ...Object.values(pkg.exports ?? {}).flatMap((entry) => Object.values(entry)),
      ...Object.values(pkg.bin ?? {}),
    ];
    for (const target of targets)
      assert.ok(
        entries.includes("package/" + target.replace(/^\.\//, "")),
        `Missing export ${target}`,
      );
    archives.push({
      name,
      version: pkg.version,
      path,
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    });
  }
  return archives;
}

async function registryVersion(item, request) {
  const response = await request(registry + encodeURIComponent(item.name) + "/" + item.version, {
    signal: AbortSignal.timeout(20_000),
    headers: { "cache-control": "no-cache" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm lookup failed for ${item.name}: HTTP ${response.status}`);
  const metadata = await response.json();
  assert.equal(metadata.name, item.name);
  assert.equal(metadata.version, item.version);
  assert.equal(
    metadata.dist?.integrity,
    item.integrity,
    `${item.name}@${item.version} already exists with different contents; bump its version`,
  );
  return metadata;
}

export async function publishArchives(
  directory,
  {
    execute = run,
    request = fetch,
    wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {},
) {
  const archives = await inspectArchives(directory, execute);
  const published = new Set();
  // Fail before any publish if a version conflicts or the registry is unavailable.
  for (const item of archives) if (await registryVersion(item, request)) published.add(item.name);
  for (const item of archives) {
    if (published.has(item.name)) {
      console.log(`Already published with matching integrity: ${item.name}@${item.version}`);
      continue;
    }
    console.log(`Publishing ${item.name}@${item.version}`);
    await execute("npm", [
      "publish",
      item.path,
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
      "--registry=" + registry,
    ]);
    let visible = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await registryVersion(item, request)) {
        visible = true;
        break;
      }
      if (attempt < 5) await wait(5000);
    }
    assert.ok(visible, `${item.name} is not visible on npm yet; stop and inspect before rerunning`);
  }
}

async function main() {
  const directory = join(root, ".artifacts/release");
  if (process.argv[2] === "pack") {
    await mkdir(directory, { recursive: true });
    for (const [folder] of releasePackages)
      await run(
        "vp",
        ["pm", "pack", "--pack-destination", directory],
        join(root, "packages", folder),
      );
    const archives = await inspectArchives(directory);
    for (const item of archives)
      console.log(`Verified ${item.name}@${item.version}: ${item.integrity}`);
  } else if (process.argv[2] === "publish") {
    assertReleaseContext(process.env);
    const version = (await run("npm", ["--version"])).stdout.trim().split(".").map(Number);
    assert.ok(
      version[0] > 11 ||
        (version[0] === 11 && (version[1] > 5 || (version[1] === 5 && version[2] >= 1))),
      "npm >=11.5.1 is required for trusted publishing",
    );
    await publishArchives(directory);
  } else throw new Error("Usage: node scripts/release-packages.mjs pack|publish");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
