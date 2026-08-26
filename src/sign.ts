import { generateKeyPairSync, sign } from "node:crypto";

/**
 * The signed license token — the one artifact that crosses from the vendor's
 * service into an installed copy of the app.
 *
 * Everything the app needs to enforce entitlement offline is in the payload,
 * and the Ed25519 signature is what makes storage trustworthy: the app verifies
 * with an embedded public key, and only this service holds the private key. A
 * fake license server can answer requests all day; it cannot mint a token the
 * app will accept, which is why the app's server URL does not need protecting.
 *
 * Consuming apps should copy this shape rather than import it — the server
 * deploys on its own, and a shared package would couple release cycles for one
 * small interface. See docs/verify-token.md for the verification snippet.
 */
export interface LicenseTokenPayload {
  /** 2 since entitlements replaced the fixed allowance field. */
  v: 2;
  licenseId: string;
  plan: string;
  /**
   * Vendor-defined entitlements (counts, flags, tiers). The server signs them
   * verbatim; the consuming app decides which ones it enforces.
   */
  entitlements: Record<string, number | string | boolean>;
  /**
   * v1 compatibility mirror of entitlements.allowance, so apps built against
   * v1 tokens keep working. Absent when no numeric allowance entitlement.
   */
  allowance?: number;
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

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

export function signLicenseToken(payload: LicenseTokenPayload, privateKeyPem: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, body, privateKeyPem);
  return `${base64url(body)}.${base64url(signature)}`;
}

/** One vendor keypair, generated once. The private half never ships with the app. */
export function generateSigningKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
