import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";

import { confirmLocalUpdate, readLocalEnv, saveLocalEnv } from "./local-env.mjs";

const local = await readLocalEnv();
if (
  local.exists &&
  !(await confirmLocalUpdate(
    "Complete .env.local with missing secrets? Existing values and keys will be retained.",
    process.argv.includes("--yes"),
  ))
)
  process.exit(0);
const settings = {};
const configured = (name) => {
  const value = process.env[name] || local.values[name];
  return value && /^<.*>$/.test(value) ? undefined : value;
};
await mkdir("secrets", { recursive: true, mode: 0o700 });
for (const name of ["data", "backup"]) {
  const variable = "LICENSE_" + name.toUpperCase() + "_KEYRING";
  if (configured(variable)) continue;
  const path = configured(variable + "_FILE") || "./secrets/" + name + ".keyring.json";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(
      path,
      JSON.stringify({ active: "initial", keys: { initial: randomBytes(32).toString("hex") } }) +
        "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log("Created " + name + " encryption keyring. Store a secure recovery copy.");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    console.log("Existing " + name + " keyring retained.");
  }
  settings[variable + "_FILE"] = path;
}
if (!configured("LICENSE_SIGNING_KEY")) {
  const path = configured("LICENSE_SIGNING_KEY_FILE") || "./secrets/license-signing.key";
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await access(path);
    console.log("Existing signing key retained.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const pair = generateKeyPairSync("ed25519");
    await writeFile(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
      flag: "wx",
      mode: 0o600,
    });
    console.log("Created private signing key in " + path + ".");
    console.log(
      "Client PUBLIC verification key:\n" + pair.publicKey.export({ type: "spki", format: "pem" }),
    );
  }
  settings.LICENSE_SIGNING_KEY_FILE = path;
}
for (const name of ["LICENSE_ADMIN_TOKEN", "LICENSE_AUTH_SECRET", "CRON_SECRET"])
  if (!configured(name)) settings[name] = randomBytes(32).toString("hex");
await saveLocalEnv(settings);
console.log(
  "Saved configuration to .env.local. No existing secret was rotated. Set your server URL and create an administrator with vp run admin:create.",
);
