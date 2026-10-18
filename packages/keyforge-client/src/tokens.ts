import { z } from "zod";

const id = z.string().min(1).max(200);
const date = z.string().datetime({ offset: true });
const common = {
  iss: z.literal("default"),
  productId: id,
  kid: id,
  installationId: id,
  issuedAt: date,
  expiresAt: date.nullable(),
};
export const licenseSchema = z
  .object({
    ...common,
    v: z.literal(1),
    kind: z.literal("license"),
    licenseId: id,
    plan: id,
    entitlements: z.record(
      z.string().min(1).max(64),
      z.union([z.number().finite(), z.string(), z.boolean()]),
    ),
    issuedTo: z.string(),
    subject: z.object({ kind: z.enum(["installation", "service"]), id }).strict(),
    offlineGraceUntil: date,
    status: z.enum(["active", "revoked", "expired"]),
    accountId: id.nullable(),
    authorizationRevision: z.number().int().positive().safe(),
    paidImportsGranted: z.number().int().nonnegative().safe().nullable(),
    recoveryGeneration: z.number().int().nonnegative().safe(),
    trialConverted: z.literal(true),
  })
  .strict()
  .refine((p) => p.subject.id === p.installationId)
  .refine((p) =>
    p.accountId === null
      ? p.paidImportsGranted === null && p.recoveryGeneration === 0
      : p.paidImportsGranted !== null && p.subject.kind === "installation",
  );
export const trialSchema = z
  .object({
    ...common,
    v: z.literal(1),
    kind: z.literal("trial"),
    verdict: z.enum(["fresh", "spent"]),
    allowance: z.number().int().nonnegative().nullable(),
    supportReference: z.string().nullable(),
    converted: z.boolean(),
  })
  .strict();
export const recoverySchema = z
  .object({
    ...common,
    v: z.literal(1),
    kind: z.literal("usage-recovery"),
    recoveryId: z.string().uuid(),
    accountId: id,
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    mode: z.enum(["restore", "lost_history"]),
    usageDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    paidImportsFloor: z.number().int().nonnegative().safe(),
    trialImportsFloor: z.number().int().nonnegative().safe(),
    recoveryGeneration: z.number().int().positive().safe(),
    authorizationRevision: z.number().int().positive().safe(),
    expiresAt: date,
  })
  .strict();
export type RecoveryToken = z.infer<typeof recoverySchema>;
export type LicenseToken = z.infer<typeof licenseSchema>;
export type TrialToken = z.infer<typeof trialSchema>;
export type SignedToken = LicenseToken | TrialToken;

export class TokenError extends Error {
  constructor(public readonly code: string) {
    super(`KeyForge token rejected (${code}).`);
    this.name = "TokenError";
  }
}
export interface VerificationContext {
  productId: string;
  installationId: string;
  publicKeys: Readonly<Record<string, string>>;
  subjectKind?: "installation" | "service";
  now?: number;
  clockToleranceMs?: number;
}
export function encodeBase64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (n) => String.fromCharCode(n)).join(""))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function decodeBase64url(encoded: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new TokenError("malformed_token");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw new TokenError("malformed_token");
  }
  if (encodeBase64url(bytes) !== encoded) throw new TokenError("malformed_token");
  return bytes;
}

/** Authenticates a token, including its context. Expiry/status are evaluated separately
 * so signed negative grants can replace a previously active cached grant. */
async function verifyAnyToken(
  token: string,
  context: VerificationContext,
): Promise<SignedToken | RecoveryToken> {
  if (typeof token !== "string" || token.length > 65536) throw new TokenError("malformed_token");
  const parts = token.split(".");
  if (parts.length !== 2) throw new TokenError("malformed_token");
  const bytes = decodeBase64url(parts[0]),
    signature = decodeBase64url(parts[1]);
  if (signature.length !== 64) throw new TokenError("malformed_token");
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TokenError("malformed_token");
  }
  const parsed = z.union([licenseSchema, trialSchema, recoverySchema]).safeParse(input);
  if (!parsed.success) throw new TokenError("invalid_payload");
  const p = parsed.data;
  if (
    p.productId !== context.productId ||
    p.installationId !== context.installationId ||
    (p.kind === "license" && p.subject.kind !== (context.subjectKind ?? "installation"))
  )
    throw new TokenError("context_mismatch");
  const pem = Object.hasOwn(context.publicKeys, p.kid) ? context.publicKeys[p.kid] : undefined;
  if (!pem) throw new TokenError("unknown_key");
  try {
    // Ed25519 SPKI keys are small. Bound input before parsing and check fixed
    // markers separately to avoid overlapping whitespace quantifiers.
    if (typeof pem !== "string" || pem.length > 4096) throw new Error("Invalid public key");
    const begin = "-----BEGIN PUBLIC KEY-----",
      end = "-----END PUBLIC KEY-----",
      normalized = pem.trimEnd();
    if (!normalized.startsWith(begin) || !normalized.endsWith(end))
      throw new Error("Invalid public key");
    const body = normalized.slice(begin.length, -end.length);
    if (!/^\s/.test(body)) throw new Error("Invalid public key");
    const encoded = body.replace(/\s/g, ""),
      decoded = atob(encoded);
    if (!encoded || btoa(decoded) !== encoded) throw new Error("Invalid public key");
    const der = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
    // All supported server contracts sign decoded JSON bytes, not the base64url segment.
    if (!(await crypto.subtle.verify("Ed25519", key, signature, bytes)))
      throw new Error("Invalid signature");
  } catch {
    throw new TokenError("invalid_signature");
  }
  const now = context.now ?? Date.now(),
    tolerance = context.clockToleranceMs ?? 300000;
  if (!Number.isFinite(now) || !Number.isFinite(tolerance) || tolerance < 0)
    throw new TokenError("invalid_clock");
  if (Date.parse(p.issuedAt) > now + tolerance) throw new TokenError("future_issuance");
  return p;
}

export async function verifySignedToken(
  token: string,
  context: VerificationContext,
): Promise<SignedToken> {
  const grant = await verifyAnyToken(token, context);
  if (grant.kind === "usage-recovery") throw new TokenError("unexpected_token_kind");
  return grant;
}
export async function verifyRecoveryToken(
  token: string,
  context: VerificationContext,
): Promise<RecoveryToken> {
  const grant = await verifyAnyToken(token, context);
  if (grant.kind !== "usage-recovery") throw new TokenError("unexpected_token_kind");
  if (Date.parse(grant.expiresAt) <= (context.now ?? Date.now()))
    throw new TokenError("recovery_expired");
  return grant;
}
