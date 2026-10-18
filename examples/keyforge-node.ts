import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeviceSignalsProvider } from "../packages/keyforge-client/src/device-signals.js";
import {
  KeyForgeClient,
  MemoryStorage,
  type ClientOptions,
} from "../packages/keyforge-client/src/index.js";
import { createWindowsDeviceSignalsProvider } from "../packages/keyforge-client/src/windows.js";

/** Reference onboarding, also exercised against a temporary server by the SDK tests.
 * Supply the desktop framework's secure storage adapter in a production integration. */
export async function runReference(
  options: ClientOptions,
  action: { key?: string; trial?: boolean; importEventId?: string } = {},
) {
  const client = new KeyForgeClient(options);
  let authorization = action.key
    ? await client.activate(action.key)
    : action.trial
      ? await client.startTrial()
      : await client.getAuthorization();
  // Feature checks belong at the protected operation, not only in onboarding UI.
  // For import accounts, enlist secure-storage CAS and the asset insert in one host transaction.
  const importReceipt = action.importEventId
    ? await client.consumeImport(action.importEventId)
    : undefined;
  if (importReceipt) authorization = importReceipt.authorization;
  const canUsePaidFeatures = authorization.state === "licensed";
  return { client, authorization, canUsePaidFeatures, importReceipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {
      KEYFORGE_SERVER_URL: serverUrl,
      KEYFORGE_PRODUCT_ID: productId,
      KEYFORGE_PUBLIC_KEYS_FILE: keyFile,
    } = process.env;
    if (!serverUrl || !productId || !keyFile)
      throw new Error(
        "Set KEYFORGE_SERVER_URL, KEYFORGE_PRODUCT_ID and KEYFORGE_PUBLIC_KEYS_FILE.",
      );
    const publicKeys: Record<string, string> = JSON.parse(await readFile(keyFile, "utf8"));
    const { authorization } = await runReference(
      {
        serverUrl,
        productId,
        publicKeys,
        storage: new MemoryStorage(),
        registration: { platform: process.platform, appVersion: "reference-1" },
        ...(process.env.KEYFORGE_DEVICE_SIGNALS === "1"
          ? { deviceSignalsProvider: createDeviceSignalsProvider() }
          : process.env.KEYFORGE_WINDOWS_SIGNALS === "1"
            ? { deviceSignalsProvider: createWindowsDeviceSignalsProvider() }
            : {}),
      },
      { key: process.env.KEYFORGE_LICENSE_KEY, trial: process.env.KEYFORGE_TRIAL === "1" },
    );
    console.log(
      `Authorization: ${authorization.state}. This reference uses ephemeral storage; restarting creates a new identity.`,
    );
  } catch {
    console.error(
      "Reference client failed. Check configuration, connectivity and the license; no authorization was granted.",
    );
    process.exitCode = 1;
  }
}
