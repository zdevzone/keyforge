import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";

// @ts-expect-error Setup helpers are plain ESM and run without a build.
import { saveLocalEnv } from "../scripts/local-env.mjs";

const init = resolve("scripts/init-secrets.mjs"),
  keygen = resolve("scripts/license-tool.mjs");
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("LICENSE_") && key !== "CRON_SECRET",
  ),
);
test("environment updates preserve Windows paths, comments and unrelated settings without duplicate keys", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "keyforge-env-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = join(cwd, ".env.local");
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
    execFileSync(process.execPath, [init, ...args], {
      cwd,
      env: cleanEnv,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  const output = run();
  const path = join(cwd, ".env.local");
  const source = await readFile(path, "utf8"),
    values = parseEnv(source);
  for (const key of ["LICENSE_AUTH_SECRET", "LICENSE_ADMIN_TOKEN", "CRON_SECRET"]) {
    assert.equal(values[key]!.length, 64);
    assert.equal(output.includes(values[key]!), false);
  }
  const privateKey = await readFile(join(cwd, values.LICENSE_SIGNING_KEY_FILE!));
  assert.equal(createPublicKey(privateKey).asymmetricKeyType, "ed25519");
  assert.equal(values.LICENSE_SIGNING_KEY_FILE!, "./secrets/license-signing.key");
  const data = await readFile(join(cwd, values.LICENSE_DATA_KEYRING_FILE!), "utf8");
  assert.notEqual(data, await readFile(join(cwd, values.LICENSE_BACKUP_KEYRING_FILE!), "utf8"));
  const refused = spawnSync(process.execPath, [init], {
    cwd,
    env: cleanEnv,
    encoding: "utf8",
    input: "",
  });
  assert.notEqual(refused.status, 0);
  assert.equal(await readFile(path, "utf8"), source);
  run("--yes");
  assert.equal(await readFile(path, "utf8"), source);
  assert.deepEqual(await readFile(join(cwd, values.LICENSE_SIGNING_KEY_FILE!)), privateKey);
  assert.equal(await readFile(join(cwd, values.LICENSE_DATA_KEYRING_FILE!), "utf8"), data);
});
test("keygen appends its path, requires confirmation for existing setup and refuses accidental overwrite", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "keyforge-keygen-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, ".env.local"),
    "# Keep this\nLICENSE_SERVER_URL=https://example.test\n",
  );
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [keygen, "keygen", ...args], {
      cwd,
      env: cleanEnv,
      encoding: "utf8",
      input: "",
    });
  assert.notEqual(run().status, 0);
  assert.equal(run("--yes").status, 0);
  const source = await readFile(join(cwd, ".env.local"), "utf8");
  assert.ok(source.includes("# Keep this"));
  assert.equal(parseEnv(source).LICENSE_SIGNING_KEY_FILE, "./secrets/license-signing.key");
  const key = await readFile(join(cwd, "secrets/license-signing.key"));
  assert.notEqual(run("--yes").status, 0);
  assert.deepEqual(await readFile(join(cwd, "secrets/license-signing.key")), key);
});
