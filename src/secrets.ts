import { readFileSync } from "node:fs";

import { z } from "zod";

import type { KeyRing } from "./platform-store.js";
const schema = z
  .object({
    active: z.string().min(1),
    keys: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/i)),
  })
  .strict();
export function loadKeyRing(
  name: "LICENSE_DATA_KEYRING" | "LICENSE_BACKUP_KEYRING",
  env = process.env,
): KeyRing | undefined {
  const inline = env[name],
    file = env[name + "_FILE"];
  if (inline && file) throw new Error("Set only one of " + name + " and " + name + "_FILE.");
  if (!inline && !file) return undefined;
  const parsed = schema.parse(JSON.parse(inline ?? readFileSync(file!, "utf8")));
  if (!parsed.keys[parsed.active]) throw new Error(name + " active key is missing.");
  return parsed;
}
