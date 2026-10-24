import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";

// @ts-expect-error Setup helpers are plain ESM and run without a build.
import { saveLocalEnv } from "../scripts/local-env.mjs";

const init = resolve("scripts/init-secrets.mjs"),
  keygen = resolve("scripts/license-tool.mjs"),
  exportSecrets = resolve("scripts/export-secrets.mjs");
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("LICENSE_") && key !== "CRON_SECRET",
  ),
);
test("environment updates preserve Windows paths, comments and unrelated settings without duplicate keys", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "keyforge-env-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, ".env");
  await writeFile(
    file,
    "# Existing settings\nLICENSE_SIGNING_KEY_FILE=old\nLICENSE_SIGNING_KEY_FILE=duplicate\nUNRELATED=keep\nconstructor=keep-too\n",
  );
  const path = "C:\\KeyForge data\\secrets\\license-signing.key";
  await saveLocalEnv({ LICENSE_SIGNING_KEY_FILE: path }, file);
  const source = await readFile(file, "utf8");
  assert.equal(parseEnv(source).LICENSE_SIGNING_KEY_FILE, path);
  assert.equal(parseEnv(source).UNRELATED, "keep");
  assert.equal(parseEnv(source).constructor, "keep-too");
  assert.equal(source.match(/^LICENSE_SIGNING_KEY_FILE=/gm)?.length, 1);
  assert.ok(source.includes("# Existing settings"));
});
test("fresh secret setup writes a complete local environment and never rotates existing keys", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "keyforge-secrets-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ["--", init, ...args], {
      cwd,
      env: cleanEnv,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  const output = run();
  const path = join(cwd, ".env");
  const source = await readFile(path, "utf8"),
    values = parseEnv(source);
  for (const key of ["LICENSE_AUTH_SECRET", "LICENSE_ADMIN_TOKEN", "CRON_SECRET"]) {
    assert.equal(values[key]!.length, 64);
    assert.equal(output.includes(values[key]!), false);
  }
  const privateKey = values.LICENSE_SIGNING_KEY!.replaceAll("\\n", "\n");
  assert.equal(createPublicKey(privateKey).asymmetricKeyType, "ed25519");
  assert.equal(values.LICENSE_SIGNING_KEY_FILE, undefined);
  const data = await readFile(join(cwd, values.LICENSE_DATA_KEYRING_FILE!), "utf8");
  assert.notEqual(data, await readFile(join(cwd, values.LICENSE_BACKUP_KEYRING_FILE!), "utf8"));
  const refused = spawnSync(process.execPath, ["--", init], {
    cwd,
    env: cleanEnv,
    encoding: "utf8",
    input: "",
  });
  assert.notEqual(refused.status, 0);
  assert.equal(await readFile(path, "utf8"), source);
  run("--yes");
  assert.equal(await readFile(path, "utf8"), source);
  assert.equal(
    parseEnv(await readFile(path, "utf8")).LICENSE_SIGNING_KEY,
    values.LICENSE_SIGNING_KEY,
  );
  assert.equal(await readFile(join(cwd, values.LICENSE_DATA_KEYRING_FILE!), "utf8"), data);
});
test("keygen appends its path, requires confirmation for existing setup and refuses accidental overwrite", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "keyforge-keygen-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".env"), "# Keep this\nLICENSE_SERVER_URL=https://example.test\n");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--", keygen, "keygen", ...args], {
      cwd,
      env: cleanEnv,
      encoding: "utf8",
      input: "",
    });
  assert.notEqual(run().status, 0);
  assert.equal(run("--yes").status, 0);
  const source = await readFile(join(cwd, ".env"), "utf8");
  assert.ok(source.includes("# Keep this"));
  assert.equal(parseEnv(source).LICENSE_SIGNING_KEY_FILE, "./secrets/license-signing.key");
  const key = await readFile(join(cwd, "secrets/license-signing.key"));
  assert.notEqual(run("--yes").status, 0);
  assert.deepEqual(await readFile(join(cwd, "secrets/license-signing.key")), key);
});

test("named environments isolate keys and ignore ambient production credentials", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "keyforge-named-secrets-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".env"), "# Local configuration must remain unchanged\n");
  const env = {
    ...cleanEnv,
    LICENSE_SIGNING_KEY: "ambient-production-key",
    LICENSE_AUTH_SECRET: "ambient-session-secret",
  };
  const sources: string[] = [];
  for (const target of ["staging", "production"]) {
    const file = join("secrets", target, "server.env");
    const run = () =>
      execFileSync(process.execPath, ["--", init, "--env-file", file, "--yes"], {
        cwd,
        env,
        stdio: "pipe",
      });
    run();
    const source = await readFile(join(cwd, file), "utf8");
    const values = parseEnv(source);
    assert.ok(!source.includes("ambient-"));
    assert.equal(
      createPublicKey(values.LICENSE_SIGNING_KEY!.replaceAll("\\n", "\n")).asymmetricKeyType,
      "ed25519",
    );
    assert.equal(values.LICENSE_SIGNING_KEY_FILE, undefined);
    run();
    assert.ok(
      source === (await readFile(join(cwd, file), "utf8")),
      "Repeated setup must preserve credentials",
    );
    sources.push(source);
  }
  assert.ok(sources[0] !== sources[1], "Environments must not share generated secrets");
  assert.equal(
    await readFile(join(cwd, ".env"), "utf8"),
    "# Local configuration must remain unchanged\n",
  );
  const selected = join("secrets", "recovery", "server.env");
  execFileSync(process.execPath, ["--", keygen, "keygen", "--env-file", selected], {
    cwd,
    env,
    stdio: "pipe",
  });
  const recovery = parseEnv(await readFile(join(cwd, selected), "utf8"));
  assert.ok(
    recovery.LICENSE_SIGNING_KEY_FILE!.replaceAll("\\", "/").startsWith("secrets/recovery/keys/"),
  );
});

test("portable exports preserve signing/encryption material and omit platform credentials", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "keyforge-export-secrets-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync(process.execPath, ["--", init], { cwd, env: cleanEnv, stdio: "pipe" });
  const sourceFile = join(cwd, ".env");
  await writeFile(
    sourceFile,
    (await readFile(sourceFile, "utf8")) +
      "VERCEL_OIDC_TOKEN=provider-only\nNEON_PROJECT_ID=provider-project\nLICENSE_SERVER_URL=https://license.example.test\n",
  );
  const before = await readFile(sourceFile, "utf8");
  const values = parseEnv(before);
  const output = join("secrets", "production", "server.env");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--", exportSecrets, "--output", output, ...args], {
      cwd,
      env: cleanEnv,
      encoding: "utf8",
      input: "",
    });
  const first = run();
  assert.equal(first.status, 0);
  const exported = parseEnv(await readFile(join(cwd, output), "utf8"));
  assert.ok(
    !Object.keys(exported).some(
      (k) => k.startsWith("VERCEL_") || k.startsWith("NEON_") || k.endsWith("_FILE"),
    ),
  );
  for (const name of ["LICENSE_SIGNING_KEY", "LICENSE_DATA_KEYRING", "LICENSE_BACKUP_KEYRING"]) {
    const expected =
      name === "LICENSE_SIGNING_KEY"
        ? values[name]
        : await readFile(join(cwd, values[name + "_FILE"]!), "utf8");
    assert.ok(exported[name] === expected);
    assert.ok(
      !first.stdout.includes(exported[name]!),
      "Secret values must never reach command output",
    );
  }
  assert.equal(exported.LICENSE_SERVER_URL, "https://license.example.test");
  assert.equal(await readFile(sourceFile, "utf8"), before);
  assert.notEqual(run().status, 0, "Existing export requires confirmation");
  assert.equal(run("--yes").status, 0);
  assert.ok(
    parseEnv(await readFile(join(cwd, output), "utf8")).LICENSE_SIGNING_KEY ===
      exported.LICENSE_SIGNING_KEY,
  );
});

test("masked host exports cannot silently generate replacement production keys", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "keyforge-masked-secrets-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, ".env"), "LICENSE_SIGNING_KEY='[SENSITIVE]'\n");
  for (const [script, args] of [
    [init, ["--yes"]],
    [exportSecrets, ["--output", "portable.env"]],
  ] as const) {
    const result = spawnSync(process.execPath, ["--", script, ...args], {
      cwd,
      env: cleanEnv,
      encoding: "utf8",
      input: "",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Restore/);
  }
  await assert.rejects(access(join(cwd, "secrets/license-signing.key")));
  await assert.rejects(access(join(cwd, "portable.env")));
});
