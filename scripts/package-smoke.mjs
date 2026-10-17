import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runFile = promisify(execFile);
await mkdir(join(root, ".artifacts"), { recursive: true });
const artifact = await mkdtemp(join(root, ".artifacts", "package-smoke-"));
// A sibling keeps vp create outside this monorepo and on the project's disk.
const workspace = await mkdtemp(join(dirname(root), "keyforge-packages-"));
async function run(command, args, cwd, env = process.env) {
  try {
    return await runFile(command, args, {
      cwd,
      env,
      timeout: 600_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    console.error(error.stdout ?? "");
    console.error(error.stderr ?? "");
    throw error;
  }
}
const sdkSource = join(artifact, "source/packages/keyforge-client");
await mkdir(sdkSource, { recursive: true });
await cp(join(root, "tsconfig.json"), join(artifact, "source/tsconfig.json"));
await cp(join(root, "LICENSE"), join(artifact, "source/LICENSE"));
for (const entry of ["package.json", "README.md", "tsconfig.json", "scripts", "src", "skill"])
  await cp(join(root, "packages/keyforge-client", entry), join(sdkSource, entry), {
    recursive: true,
  });
assert.ok(!(await readdir(sdkSource)).includes("dist"));

const packages = new Map();
for (const original of [
  sdkSource,
  join(root, "packages/create-keyforge"),
  join(root, "packages/create-keyforge-client"),
]) {
  let directory = original;
  let pkg = JSON.parse(await readFile(join(original, "package.json"), "utf8"));
  if (process.env.RELEASE_ARCHIVES) {
    const files = await readdir(process.env.RELEASE_ARCHIVES);
    const prefix = pkg.name.replace(/^@/, "").replaceAll("/", "-") + "-";
    const matches = files.filter(
      (file) =>
        file.startsWith(prefix) && /^\d/.test(file.slice(prefix.length)) && file.endsWith(".tgz"),
    );
    assert.equal(matches.length, 1, `Expected one release archive for ${pkg.name}`);
    const path = join(process.env.RELEASE_ARCHIVES, matches[0]);
    pkg = JSON.parse((await run("tar", ["-xOf", path, "package/package.json"], root)).stdout);
    await cp(path, join(artifact, matches[0]));
  } else if (pkg.bin) {
    directory = join(artifact, "source/packages", pkg.name);
    await mkdir(directory, { recursive: true });
    for (const entry of pkg.files)
      await cp(join(original, entry), join(directory, entry), { recursive: true });
    // Unique fixture versions bypass dlx caches without altering release versions.
    pkg.version += "-smoke." + Date.now();
    await writeFile(join(directory, "package.json"), JSON.stringify(pkg));
  }
  if (!process.env.RELEASE_ARCHIVES)
    await run("vp", ["pm", "pack", "--pack-destination", artifact], directory);
  const filename = pkg.name.replace(/^@/, "").replaceAll("/", "-") + "-" + pkg.version + ".tgz";
  const bytes = await readFile(join(artifact, filename));
  const entries = (await run("tar", ["-tzf", join(artifact, filename)], root)).stdout;
  assert.ok(!/package\/(?:\.env|node_modules|secrets|.*\.sqlite)/.test(entries));
  if (pkg.exports)
    for (const entry of Object.values(pkg.exports))
      for (const path of Object.values(entry))
        assert.ok(entries.includes("package/" + path.slice(2)), `Missing packed export ${path}`);
  packages.set(pkg.name, { pkg, bytes, filename });
}
console.log(
  "Clean-source SDK pack contains every JavaScript/type export; all three package archives passed inspection.",
);

// A committed template is sufficient: the code under test is the packed new
// generator, and upstream workspaces must never reach its generated app.
await run(
  "git",
  [
    "archive",
    "--format=tar.gz",
    "--prefix=keyforge-main/",
    "--output=" + join(artifact, "template.tgz"),
    "HEAD",
  ],
  root,
);
const templateBytes = await readFile(join(artifact, "template.tgz"));
let origin;
const registry = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://local").pathname).slice(1);
  if (process.env.PACKAGE_SMOKE_DEBUG) console.log("Registry request: " + path);
  const templateRef = packages.get("create-keyforge").pkg.keyforgeRelease?.sourceSha ?? "main";
  if (path === "zdevzone/keyforge/tar.gz/" + templateRef) {
    res.end(templateBytes);
    return;
  }
  const archive = [...packages.values()].find((entry) => path === "archives/" + entry.filename);
  if (archive) {
    res.end(archive.bytes);
    return;
  }
  const item = packages.get(path);
  if (item) {
    const { pkg, bytes, filename } = item;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        name: pkg.name,
        "dist-tags": { latest: pkg.version },
        versions: {
          [pkg.version]: {
            ...pkg,
            dist: {
              tarball: origin + "/archives/" + filename,
              shasum: createHash("sha1").update(bytes).digest("hex"),
              integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
            },
          },
        },
      }),
    );
    return;
  }
  res.writeHead(302, { location: "https://registry.npmjs.org/" + req.url.slice(1) });
  res.end();
});
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
origin = "http://127.0.0.1:" + registry.address().port;
const env = {
  ...process.env,
  npm_config_registry: origin,
  NPM_CONFIG_REGISTRY: origin,
  KEYFORGE_TEMPLATE_ORIGIN: origin,
  CI: "1",
  TEMP: artifact,
  TMP: artifact,
  npm_config_cache: join(root, ".artifacts/package-smoke-cache"),
  npm_config_userconfig: join(workspace, ".npmrc"),
};
await writeFile(
  join(workspace, ".npmrc"),
  `registry=${origin}\n@zdevzone:registry=${origin}\ncache-dir=${join(root, ".artifacts/package-smoke-cache").replaceAll("\\", "/")}\n`,
);
try {
  for (const [name, directory, args] of [
    ["keyforge", "server", ["--yes", "--no-git"]],
    [
      "keyforge-client",
      "client",
      ["--yes", "--server-url", "http://localhost:4100", "--product", "default"],
    ],
  ]) {
    const result = await run(
      "vp",
      [
        "create",
        name + "@" + packages.get("create-" + name).pkg.version,
        "--no-interactive",
        "--no-agent",
        "--no-editor",
        "--no-hooks",
        "--no-git",
        "--package-manager",
        "pnpm",
        "--",
        directory,
        ...args,
      ],
      workspace,
      env,
    );
    assert.ok(!result.stdout.includes("ENOENT"), result.stdout);
    assert.match(result.stdout, new RegExp("Scaffolded " + directory + "(?:\\s|$)"), result.stdout);
    const project = join(workspace, directory);
    const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    assert.equal(pkg.name, directory);
    if (name === "keyforge") {
      assert.ok(!(await readdir(project)).includes("packages"));
      const policy = JSON.parse(await readFile(join(project, "keyforge.config.json"), "utf8"));
      assert.ok(policy.licenses);
      // Upstream-only guides/workflows are pruned; the generated docs must still work.
      await run("vp", ["exec", "tsx", "--test", "test/docs-reader.test.ts"], project, env);
    } else {
      assert.ok(pkg.dependencies["@zdevzone/keyforge-client"]);
      await run("vp", ["run", "typecheck"], project, env);
      await cp(join(project, ".env.example"), join(project, ".env.local"));
      const demo = await run("vp", ["run", "demo"], project, env);
      assert.match(demo.stdout, /Authorization: unlicensed/);
      await writeFile(
        join(project, "smoke.mjs"),
        `import {KeyForgeClient, MemoryStorage} from '@zdevzone/keyforge-client';
import {createDeviceSignalsProvider} from '@zdevzone/keyforge-client/device-signals';
import {createWindowsDeviceSignalsProvider} from '@zdevzone/keyforge-client/windows';
import {createLinuxDeviceSignalsProvider} from '@zdevzone/keyforge-client/linux';
import {createMacOSDeviceSignalsProvider} from '@zdevzone/keyforge-client/macos';
if (![KeyForgeClient, MemoryStorage, createDeviceSignalsProvider, createWindowsDeviceSignalsProvider, createLinuxDeviceSignalsProvider, createMacOSDeviceSignalsProvider].every(x=>typeof x==='function')) throw Error('Broken exports');`,
      );
      await run(process.execPath, ["smoke.mjs"], project, env);
    }
    console.log(`Actual vp create ${name} completed at the correct root; ${directory} verified.`);
  }
  console.log("Package smoke checks passed; temporary projects: " + workspace);
} finally {
  registry.closeAllConnections();
  await new Promise((resolve) => registry.close(resolve));
}
