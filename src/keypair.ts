import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The signing key, checked rather than assumed.
 *
 * Reading a PEM out of the environment and handing it straight to the signer
 * defers every possible mistake to the first customer activation: a key that is
 * RSA rather than Ed25519, a *public* key pasted where the private one belongs,
 * or newlines mangled by a dashboard's env editor all load without complaint and
 * then throw inside `signLicenseToken`. The service answers health checks the
 * whole time. This module turns all of that into a startup failure with a
 * sentence attached.
 *
 * It also derives and fingerprints the public half, which nothing else could do.
 * `keygen` prints the public key once and never again, so a vendor who loses
 * that output has no way to confirm the key their server signs with is the one
 * their shipped app verifies against — and a mismatch is invisible from both
 * ends: the server reports success, and every token fails in the field.
 *
 * The private key never leaves here. Only the public half is returned, and it is
 * public by definition: it ships embedded in the vendor's application.
 */

export interface SigningKeyInfo {
  /** Always "ed25519" — anything else is rejected before this is built. */
  keyType: string;
  /** SPKI PEM, the form pasted into the consuming app. */
  publicKeyPem: string;
  /** Short, colon-separated hex over the DER bytes. Comparable by eye. */
  fingerprint: string;
}

/** Probe text signed and verified to prove the key works, not merely parses. */
const ROUND_TRIP_PROBE = Buffer.from("keyforge signing key round trip", "utf8");

/**
 * Where the signing key comes from, in the deployment's own terms.
 *
 * Lives here rather than in the entry point so the CLI resolves it exactly the
 * way the service does — a check that consults a different key than the server
 * uses would be worse than no check at all.
 */
export function resolveSigningKey(env: NodeJS.ProcessEnv = process.env): string {
  const inline = env.LICENSE_SIGNING_KEY;
  if (inline && env.LICENSE_SIGNING_KEY_FILE)
    throw new Error("Set only one of LICENSE_SIGNING_KEY and LICENSE_SIGNING_KEY_FILE.");
  // A PEM pasted into a dashboard env field usually arrives with its newlines
  // escaped; both spellings are accepted, and neither is silently wrong.
  if (inline) return inline.replaceAll("\\n", "\n");
  const path = env.LICENSE_SIGNING_KEY_FILE;
  if (path) return readFileSync(path, "utf8");
  throw new Error(
    "Set LICENSE_SIGNING_KEY (PEM) or LICENSE_SIGNING_KEY_FILE (path to PEM). " +
      "Generate a keypair with: npm run license keygen",
  );
}

/**
 * Validate a private key and describe its public half.
 *
 * Throws with a diagnosis rather than a stack trace: the operator reading this
 * is usually looking at a deploy that just failed, and "invalid PEM" alone does
 * not tell them which of the four likely mistakes they made.
 */
export function describeSigningKey(pem: string): SigningKeyInfo {
  const text = typeof pem === "string" ? pem.trim() : "";
  if (!text) {
    throw new Error(
      "The signing key is empty. Set LICENSE_SIGNING_KEY or LICENSE_SIGNING_KEY_FILE.",
    );
  }

  // Caught before parsing, because these two produce OpenSSL errors that name
  // neither the cause nor the fix.
  if (/-----BEGIN (?:PUBLIC KEY|[A-Z ]*PUBLIC KEY)-----/.test(text)) {
    throw new Error(
      "That is a PUBLIC key. The service signs with the PRIVATE half — the public key is " +
        "the one you embed in your app. Look for the file written by: npm run license keygen",
    );
  }
  if (text.includes("\\n") && !text.includes("\n")) {
    throw new Error(
      "The signing key has escaped newlines (\\n) but no real ones, so it is a single line " +
        "and cannot be parsed. Store the PEM with real newlines, or as a file via " +
        "LICENSE_SIGNING_KEY_FILE.",
    );
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `The signing key is not a readable PEM private key (${detail}). It should begin with ` +
        "-----BEGIN PRIVATE KEY----- and be the file written by: npm run license keygen",
    );
  }

  // Ed25519 is not a preference: signLicenseToken calls sign(null, …), which
  // requires a key type that carries its own hash. An RSA key reaches this far
  // and then fails at request time.
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `The signing key is ${privateKey.asymmetricKeyType ?? "of an unknown type"}, but license ` +
        "tokens are signed with Ed25519. Generate one with: npm run license keygen",
    );
  }

  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  // Parsing proves the bytes are well formed; this proves the key actually
  // signs through the same call the service makes on every activation.
  const signature = sign(null, ROUND_TRIP_PROBE, privateKey);
  if (!verify(null, ROUND_TRIP_PROBE, publicKey, signature)) {
    throw new Error(
      "The signing key parsed but failed a sign/verify round trip. The key material is damaged.",
    );
  }

  return {
    keyType: privateKey.asymmetricKeyType,
    publicKeyPem,
    fingerprint: fingerprintPublicKey(publicKeyPem),
  };
}

/**
 * The name this deployment's tokens carry in their `kid`.
 *
 * Explicit when the operator set one — a date-shaped id like "2026-08" reads
 * better in a rotation runbook than a hash does. Otherwise derived from the
 * key's own fingerprint, so the field is never absent and never has to be
 * invented later: a deployment that rotates for the first time can publish the
 * old key under the id it was already signing with, rather than discovering it
 * has no name for the key half its customers are still verifying against.
 */
export function resolveKid(
  signingKey: SigningKeyInfo,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.LICENSE_SIGNING_KID?.trim();
  if (configured) return configured;
  return `key-${signingKey.fingerprint.replaceAll(":", "")}`;
}

/**
 * A short, stable name for a public key.
 *
 * Hashed over the DER bytes rather than the PEM text: the same key re-exported
 * can differ in line wrapping and trailing newline, and a fingerprint that
 * changes with whitespace is worse than none — it would report a mismatch
 * between a key and itself.
 */
export function fingerprintPublicKey(pem: string): string {
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(der).digest("hex");
  // Eight bytes is plenty to catch "these are different keys", which is the
  // only question being asked, and it is short enough to read out loud.
  return (digest.slice(0, 16).match(/.{2}/g) ?? []).join(":");
}

/**
 * Verify a token produced by signLicenseToken against a public key.
 *
 * The first signature *verification* in this codebase — the service only ever
 * signs, and `license inspect` says outright that it decodes without checking.
 * That left no way to answer "would my app accept this token?", which is the
 * question that matters after a key is rotated or a deploy is repointed.
 *
 * Returns a result rather than throwing: a bad signature is an answer, not an
 * error, and the caller reports it differently from a malformed input.
 */
export function verifyLicenseToken(
  token: string,
  publicKeyPem: string,
): { valid: boolean; payload: unknown; reason?: string } {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return {
      valid: false,
      payload: null,
      reason: "Not a license token: expected two base64url parts separated by a dot.",
    };
  }

  const [body, signature] = parts;
  let payload: unknown = null;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { valid: false, payload: null, reason: "The token's payload half is not valid JSON." };
  }

  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(body, "base64url"),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, "base64url"),
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      valid: false,
      payload,
      reason: `Could not verify against that public key (${detail}).`,
    };
  }

  return {
    valid,
    payload,
    reason: valid ? undefined : "The signature does not match this public key.",
  };
}
