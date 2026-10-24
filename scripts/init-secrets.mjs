import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  confirmLocalUpdate,
  localEnvironmentOptions,
  readLocalEnv,
  saveLocalEnv,
} from "./local-env.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(
    "Usage: vp run secrets:init [--env-file PATH] [--secrets-dir PATH] [--yes]\nFill missing server secrets without rotating existing keys. Defaults to .env; named environments own their keys/ directory.",
  );
  process.exit(0);
}
const options = localEnvironmentOptions(process.argv.slice(2));
const local = await readLocalEnv(options.file);
if (
  local.exists &&
  !(await confirmLocalUpdate(
    "Complete " +
      options.file +
      " with missing secrets? Existing values and keys will be retained.",
    process.argv.includes("--yes"),
  ))
)
  process.exit(0);
const settings = {};
const configured = (name) => {
  const value = options.explicit ? local.values[name] : process.env[name] || local.values[name];
  if (value === "[SENSITIVE]")
    throw Error(
      "Restore the existing value for " +
        name +
        " from secure recovery; a masked host export cannot initialize secrets.",
    );
  return value && /^<.*>$/.test(value) ? undefined : value;
};
// Detect masked exports before creating any keys or changing the environment.
for (const name of Object.keys(local.values).filter(
  (name) => name.startsWith("LICENSE_") || name === "CRON_SECRET",
))
  configured(name);
await mkdir(options.secretsDir, { recursive: true, mode: 0o700 });
const keyPath = (name) => options.secretsDir.replaceAll("\\", "/").replace(/\/$/, "") + "/" + name;
for (const name of ["data", "backup"]) {
  const variable = "LICENSE_" + name.toUpperCase() + "_KEYRING";
  if (configured(variable)) continue;
  const path = configured(variable + "_FILE") || keyPath(name + ".keyring.json");
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
  const path = configured("LICENSE_SIGNING_KEY_FILE");
  if (path) {
    await readFile(path, "utf8");
    console.log("Existing signing key file retained.");
  } else {
    const pair = generateKeyPairSync("ed25519");
    settings.LICENSE_SIGNING_KEY = pair.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .trim()
      .replaceAll("\n", "\\n");
    console.log("Created private signing key in " + options.file + ".");
    console.log(
      "Client PUBLIC verification key:\n" + pair.publicKey.export({ type: "spki", format: "pem" }),
    );
  }
}
for (const name of ["LICENSE_ADMIN_TOKEN", "LICENSE_AUTH_SECRET", "CRON_SECRET"])
  if (!configured(name)) settings[name] = randomBytes(32).toString("hex");
await saveLocalEnv(settings, options.file);
console.log(
  "Saved configuration to " +
    options.file +
    ". No existing secret was rotated. Set your server URL and create an administrator with vp run admin:create.",
);
