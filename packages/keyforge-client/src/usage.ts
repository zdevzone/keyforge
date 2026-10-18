import { z } from "zod";

import { encodeBase64url } from "./tokens.js";

const count = z.number().int().nonnegative().safe();
export const importUsageSchema = z
  .object({
    accountId: z.string().min(1).max(200).nullable(),
    paidConsumed: count,
    trialConsumed: count,
    lifetimeImports: count,
    lifetimeKnown: z.boolean(),
    integrity: z.boolean(),
    trialConverted: z.boolean(),
    authorizationRevision: count,
    recoveryGeneration: count,
    granted: count,
    termsHash: z.string().nullable(),
    events: z.record(
      z.string().uuid(),
      z.object({ units: count, source: z.enum(["trial", "paid"]) }).strict(),
    ),
  })
  .strict()
  .refine(
    (v) =>
      (!v.lifetimeKnown || v.lifetimeImports >= v.trialConsumed + v.paidConsumed) &&
      Object.values(v.events)
        .filter((e) => e.source === "paid")
        .reduce((n, e) => n + e.units, 0) <= v.paidConsumed &&
      Object.values(v.events)
        .filter((e) => e.source === "trial")
        .reduce((n, e) => n + e.units, 0) <= v.trialConsumed,
  );
export type ImportUsage = z.infer<typeof importUsageSchema>;
export const emptyImportUsage = (): ImportUsage => ({
  accountId: null,
  paidConsumed: 0,
  trialConsumed: 0,
  lifetimeImports: 0,
  lifetimeKnown: true,
  integrity: true,
  trialConverted: false,
  authorizationRevision: 0,
  recoveryGeneration: 0,
  granted: 0,
  termsHash: null,
  events: {},
});
export async function usageDigest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function recoveryUsageDigest(challenge: string, v: ImportUsage) {
  return usageDigest([
    "keyforge-usage-recovery",
    1,
    challenge,
    v.accountId,
    v.paidConsumed,
    v.trialConsumed,
    v.lifetimeImports,
    v.lifetimeKnown,
    v.integrity,
    v.trialConverted,
    v.authorizationRevision,
    v.recoveryGeneration,
    v.granted,
    v.termsHash,
    Object.entries(v.events)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, e]) => [id, e.units, e.source]),
  ]);
}
function decode(s: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw Error("invalid_backup");
  const bytes = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  if (encodeBase64url(bytes) !== s) throw Error("invalid_backup");
  return bytes;
}
async function backupKey(password: string, salt: Uint8Array<ArrayBuffer>) {
  if (password.length < 12 || password.length > 1024) throw Error("invalid_backup_password");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
/** A separate customer-owned encrypted usage backup, never an ordinary configuration export. */
export async function encryptUsageBackup(usage: ImportUsage, password: string, context: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const value = new TextEncoder().encode(JSON.stringify(importUsageSchema.parse(usage)));
  if (value.length > 24000000) throw Error("backup_too_large");
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await backupKey(password, salt),
    value,
  );
  return JSON.stringify({
    v: 1,
    salt: encodeBase64url(salt),
    iv: encodeBase64url(iv),
    data: encodeBase64url(new Uint8Array(encrypted)),
  });
}
export async function decryptUsageBackup(
  backup: string,
  password: string,
  context: string,
): Promise<ImportUsage> {
  if (backup.length > 32000000) throw Error("invalid_backup");
  const box = z
    .object({ v: z.literal(1), salt: z.string(), iv: z.string(), data: z.string() })
    .strict()
    .parse(JSON.parse(backup));
  const salt = decode(box.salt),
    iv = decode(box.iv);
  if (salt.length !== 16 || iv.length !== 12) throw Error("invalid_backup");
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await backupKey(password, salt),
    decode(box.data),
  );
  return importUsageSchema.parse(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
}
