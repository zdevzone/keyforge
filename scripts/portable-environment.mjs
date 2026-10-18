import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Application settings only: platform identity/build credentials stay with their provider. */
export async function portableEnvironment(values) {
  const settings = Object.fromEntries(
    Object.entries(values).filter(
      ([key]) =>
        key.startsWith("LICENSE_") ||
        ["DATABASE_URL", "CRON_SECRET", "NODE_ENV", "PORT"].includes(key),
    ),
  );
  for (const [key, value] of Object.entries(settings))
    if (value === "[SENSITIVE]" || /^<.*>$/.test(value))
      throw Error(
        "Restore the real value of " + key + " before exporting; placeholders are not credentials.",
      );
  for (const key of ["LICENSE_SIGNING_KEY", "LICENSE_DATA_KEYRING", "LICENSE_BACKUP_KEYRING"]) {
    if (settings[key] && settings[key + "_FILE"])
      throw Error("Set only one of " + key + " and " + key + "_FILE.");
    if (settings[key + "_FILE"]) {
      // File references, like runtime settings, are relative to the project working directory.
      settings[key] = await readFile(settings[key + "_FILE"], "utf8");
      delete settings[key + "_FILE"];
    }
    if (settings[key] === "[SENSITIVE]" || /^<.*>$/.test(settings[key] || ""))
      throw Error(
        "Restore the real value of " + key + " before exporting; placeholders are not credentials.",
      );
  }
  if (settings.LICENSE_SIGNING_KEY) {
    try {
      const key = createPrivateKey(settings.LICENSE_SIGNING_KEY.replaceAll("\\n", "\n"));
      if (key.asymmetricKeyType !== "ed25519") throw Error();
    } catch {
      throw Error(
        "LICENSE_SIGNING_KEY must contain an Ed25519 private key; no values were exported.",
      );
    }
  }
  return settings;
}
