import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

export function releaseOptions(env = process.env) {
  const channel = env.RELEASE_CHANNEL ?? "stable";
  assert.ok(["stable", "beta"].includes(channel), "Choose stable or beta");
  const betaId = channel === "beta" ? `${env.GITHUB_RUN_ID}.${env.GITHUB_RUN_ATTEMPT}` : null;
  if (betaId) assert.match(betaId, /^\d+\.\d+$/, "Beta requires a run ID and attempt");
  return { channel, betaId };
}

export function releaseVersion(version, { channel = "stable", betaId } = {}) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "Manifest versions must be stable");
  if (channel === "stable") return version;
  assert.equal(channel, "beta");
  assert.match(betaId, /^\d+\.\d+$/);
  return `${version}-beta.${betaId}`;
}

export function assertPackedContext(packed, current) {
  assert.equal(packed.channel, current.channel, "Artifact channel mismatch");
  assert.equal(packed.sourceSha, current.sourceSha, "Artifact source mismatch");
  if (current.channel === "beta") {
    assert.match(packed.betaId ?? "", /^\d+\.\d+$/);
    const [run, attempt] = packed.betaId.split(".");
    const [currentRun, currentAttempt] = current.betaId.split(".");
    assert.equal(run, currentRun, "Artifact belongs to another release run");
    assert.ok(Number(attempt) <= Number(currentAttempt), "Artifact attempt is from the future");
  } else assert.equal(packed.betaId, null);
  return packed;
}

export function assertReleaseContext(env) {
  assert.equal(env.GITHUB_ACTIONS, "true", "Automated publishing requires GitHub Actions");
  assert.equal(env.GITHUB_REPOSITORY, "zdevzone/keyforge", "Publish from the public repository");
  const { channel } = releaseOptions(env);
  assert.equal(
    env.GITHUB_REF,
    channel === "stable" ? "refs/heads/main" : "refs/heads/dev",
    "Stable releases require main; beta releases require dev",
  );
}

export async function inspectArchives(directory, execute = run, options = {}) {
  const archives = [];
  // Verify every archive before allowing the first package to be published.
  for (const [folder, name] of releasePackages) {
    const pkg = JSON.parse(await readFile(join(root, "packages", folder, "package.json"), "utf8"));
    assert.equal(pkg.name, name);
    assert.ok(!pkg.private, `${name} must be publishable`);
    const version = releaseVersion(pkg.version, options);
    if (options.sourceSha) assert.match(options.sourceSha, /^[a-f0-9]{40}$/);
    const filename = name.replace(/^@/, "").replaceAll("/", "-") + "-" + version + ".tgz";
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
    assert.equal(packed.version, version);
    if (options.sourceSha) {
      if (name === "create-keyforge")
        assert.deepEqual(packed.keyforgeRelease, {
          channel: options.channel,
          sourceSha: options.sourceSha,
        });
      if (name === "create-keyforge-client") {
        const sdk = JSON.parse(
          await readFile(join(root, "packages/keyforge-client/package.json"), "utf8"),
        );
        const sdkVersion = releaseVersion(sdk.version, options);
        assert.equal(
          packed.keyforgeSdkVersion,
          options.channel === "beta" ? sdkVersion : "^" + sdkVersion,
        );
      }
    }
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
      version,
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
    ...options
  } = {},
) {
  const archives = await inspectArchives(directory, execute, options);
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
      options.channel === "beta" ? "beta" : "latest",
      "--provenance",
      "--registry=" + registry,
    ]);
    let visible = false;
    for (let attempt = 0; attempt < 61; attempt++) {
      if (await registryVersion(item, request)) {
        visible = true;
        break;
      }
      if (attempt < 60) await wait(5000);
    }
    assert.ok(visible, `${item.name} is not visible on npm yet; stop and inspect before rerunning`);
  }
}

async function main() {
  const directory = join(root, ".artifacts/release");
  let options = {
    ...releaseOptions(),
    sourceSha: process.env.GITHUB_SHA ?? (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
  };
  if (process.argv[2] === "pack") {
    await mkdir(directory, { recursive: true });
    // Build once, then package isolated copies. Never rewrite the working tree.
    await run("vp", ["-C", "packages/keyforge-client", "run", "build"]);
    const staging = await mkdtemp(join(root, ".artifacts/release-source-"));
    const sdk = JSON.parse(
      await readFile(join(root, "packages/keyforge-client/package.json"), "utf8"),
    );
    for (const [folder, name] of releasePackages) {
      const source = join(root, "packages", folder);
      const target = join(staging, folder);
      const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
      await mkdir(target, { recursive: true });
      for (const entry of pkg.files)
        await cp(join(source, entry), join(target, entry), { recursive: true });
      await cp(join(root, "LICENSE"), join(target, "LICENSE"));
      pkg.version = releaseVersion(pkg.version, options);
      // Only the server generator needs a moving source pin. Unchanged stable
      // SDK/client archives must remain byte-identical across server releases.
      if (name === "create-keyforge")
        pkg.keyforgeRelease = { channel: options.channel, sourceSha: options.sourceSha };
      if (pkg.scripts) delete pkg.scripts.prepack;
      if (name === "create-keyforge-client") {
        const version = releaseVersion(sdk.version, options);
        pkg.keyforgeSdkVersion = options.channel === "beta" ? version : "^" + version;
      }
      await writeFile(join(target, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
      await run("vp", ["pm", "pack", "--pack-destination", directory], target);
    }
    const archives = await inspectArchives(directory, run, options);
    await writeFile(join(directory, "release-context.json"), JSON.stringify(options) + "\n");
    for (const item of archives)
      console.log(`Verified ${item.name}@${item.version}: ${item.integrity}`);
  } else if (process.argv[2] === "publish") {
    assertReleaseContext(process.env);
    options = assertPackedContext(
      JSON.parse(await readFile(join(directory, "release-context.json"), "utf8")),
      options,
    );
    const version = (await run("npm", ["--version"])).stdout.trim().split(".").map(Number);
    assert.ok(
      version[0] > 11 ||
        (version[0] === 11 && (version[1] > 5 || (version[1] === 5 && version[2] >= 1))),
      "npm >=11.5.1 is required for trusted publishing",
    );
    await publishArchives(directory, options);
  } else throw new Error("Usage: node scripts/release-packages.mjs pack|publish");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
