import { readFile } from "node:fs/promises";

import { KeyForgeClient } from "@zdevzone/keyforge-client";
import { createDeviceSignalsProvider } from "@zdevzone/keyforge-client/device-signals";

import { createStorage } from "./storage.js";

const demo = process.argv.includes("--demo");
const action = process.argv.slice(2).find((arg) => arg !== "--demo") ?? "status";
try {
  if (demo && action !== "status") throw new Error("Demo mode only supports local status.");
  const {
    KEYFORGE_SERVER_URL: serverUrl,
    KEYFORGE_PRODUCT_ID: productId,
    KEYFORGE_PUBLIC_KEYS_FILE: keysFile,
  } = process.env;
  if (!serverUrl || !productId || !keysFile) throw new Error("Configure .env.local first.");
  const publicKeys: Record<string, string> = JSON.parse(await readFile(keysFile, "utf8"));
  if (!demo && Object.keys(publicKeys).length === 0)
    throw new Error("Pin your product's public verification keys first.");
  const client = new KeyForgeClient({
    serverUrl,
    productId,
    publicKeys,
    storage: createStorage(demo),
    registration: { platform: process.platform, appVersion: "starter-1" },
    ...(process.env.KEYFORGE_DEVICE_SIGNALS === "1"
      ? { deviceSignalsProvider: createDeviceSignalsProvider() }
      : {}),
  });
  let authorization;
  switch (action) {
    case "status":
      authorization = await client.getAuthorization();
      break;
    case "activate": {
      const key = process.env.KEYFORGE_LICENSE_KEY;
      if (!key) throw new Error("Set KEYFORGE_LICENSE_KEY for activation.");
      authorization = await client.activate(key);
      break;
    }
    case "trial":
      authorization = await client.startTrial();
      break;
    case "refresh":
      authorization = await client.refresh();
      break;
    case "deactivate":
      await client.deactivate();
      authorization = await client.getAuthorization();
      break;
    default:
      throw new Error("Choose status, activate, trial, refresh or deactivate.");
  }
  if (demo) console.log("Demo storage is ephemeral. No activation or trial is requested.");
  console.log(`Authorization: ${authorization.state}`);
  // Gate each protected operation using this signed authorization and its
  // entitlements. Skipping onboarding must never grant paid access.
} catch {
  console.error(
    "Client setup/action failed. Check .env.local, pinned public keys, src/storage.ts and connectivity. See README.md; no protected access was granted.",
  );
  process.exitCode = 1;
}
