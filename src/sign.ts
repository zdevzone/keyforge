import { generateKeyPairSync, sign } from "node:crypto";

/**
 * The signed tokens — the artifacts that cross from the vendor's service into
 * an installed copy of the app.
 *
 * Everything the app needs to enforce entitlement offline is in the payload,
 * and the Ed25519 signature is what makes storage trustworthy: the app verifies
 * with an embedded public key, and only this service holds the private key. A
 * fake license server can answer requests all day; it cannot mint a token the
 * app will accept, which is why the app's server URL does not need protecting.
 *
 * Consuming apps should copy these shapes rather than import them — the server
 * deploys on its own, and a shared package would couple release cycles for one
 * small interface. See docs/verify-token.md for the verification snippet.
 *
 * ## Three payload versions, negotiated per request
 *
 * A client declares the highest version it can parse (`maxTokenVersion`) and the
 * server mints at `min(declared, TOKEN_VERSION_MAX)` — never above, so a token
 * can only ever be too old for a verifier, never too new. Omitting the field
 * means v1, which is what every client built before negotiation existed sends.
 *
 *  - **v1** is the original shape: a scalar `allowance`, no `kid`, no
 *    entitlements map. Deliberately left bare — a v1-only verifier rejects
 *    fields it does not know, so adding to it would break the clients it exists
 *    for.
 *  - **v2** adds the open `entitlements` map and `kid`, and keeps `allowance` as
 *    a mirror of `entitlements.imports` so a v1-shaped reader still works.
 *  - **v3** drops the scalar. `entitlements` is the only source of truth.
 */

/** Vendor-defined entitlements (counts, flags, tiers), signed verbatim. */
export type TokenEntitlements = Record<string, number | string | boolean>;

interface LicenseTokenCommon {
  licenseId: string;
  plan: string;
  issuedTo: string;
  /** The one installation this token is valid for. */
  installationId: string;
  issuedAt: string;
  expiresAt: string | null;
  /** How long the app may keep working without reaching this service again. */
  offlineGraceUntil: string;
  /**
   * Signed even when the news is bad: a revoked or expired status arrives as a
   * token too, so the app persists an *authenticated* refusal rather than a
   * bare flag anyone could delete or a response anyone could fake.
   */
  status: "active" | "revoked" | "expired";
}

/** The original shape. No `kid`, no entitlements map — see the note above. */
export interface LicenseTokenV1 extends LicenseTokenCommon {
  v: 1;
  /** Absent when the license carries no numeric `imports` entitlement. */
  allowance?: number;
}

/** Entitlements map plus `kid`, with the v1 scalar kept as a mirror. */
export interface LicenseTokenV2 extends LicenseTokenCommon {
  v: 2;
  kid: string;
  entitlements: TokenEntitlements;
  /** v1 compatibility mirror of entitlements.imports. */
  allowance?: number;
}

/** Entitlements only. The scalar is gone for good. */
export interface LicenseTokenV3 extends LicenseTokenCommon {
  v: 3;
  kid: string;
  entitlements: TokenEntitlements;
}

export type LicenseTokenPayload = LicenseTokenV1 | LicenseTokenV2 | LicenseTokenV3;

/**
 * The trial verdict, signed.
 *
 * A first-run installation asks whether this machine has already spent its
 * trial. The answer has to be tamper-evident for the same reason a revoked
 * license does: an unsigned `{"verdict":"fresh"}` is one proxy away from being
 * free software. Versioned separately from license tokens — it is a different
 * artifact with a different lifetime — and starts at 1 with `kid` present,
 * because no verifier predates it.
 */
export interface TrialTokenPayload {
  v: 1;
  kind: "trial";
  kid: string;
  installationId: string;
  verdict: "fresh" | "spent";
  /** The trial's size, and 0 when the verdict is "spent". */
  allowance: number;
  issuedAt: string;
  /** What the customer reads out to support. Only meaningful when spent. */
  supportReference: string | null;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/** Payload JSON, signed, both halves base64url — the one token format here. */
function signPayload(payload: unknown, privateKeyPem: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, body, privateKeyPem);
  return `${base64url(body)}.${base64url(signature)}`;
}

export function signLicenseToken(payload: LicenseTokenPayload, privateKeyPem: string): string {
  return signPayload(payload, privateKeyPem);
}

export function signTrialToken(payload: TrialTokenPayload, privateKeyPem: string): string {
  return signPayload(payload, privateKeyPem);
}

/** One vendor keypair, generated once. The private half never ships with the app. */
export function generateSigningKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
