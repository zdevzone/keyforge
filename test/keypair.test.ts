import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { z } from "zod";

import {
  describeSigningKey,
  fingerprintPublicKey,
  resolveSigningKey,
  verifyLicenseToken,
} from "../src/keypair.js";
import { generateSigningKeyPair } from "../src/sign.js";
import type { licenseTokenSchema } from "../src/token-contract.js";
type LicenseTokenPayload = z.infer<typeof licenseTokenSchema>;
function signLicenseToken(payload: LicenseTokenPayload, key: string) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return bytes.toString("base64url") + "." + sign(null, bytes, key).toString("base64url");
}

/**
 * The signing key, and the ways it goes wrong.
 *
 * Every case here starts the service successfully today and fails on the first
 * customer activation instead — which is the entire reason the check exists. So
 * these tests are written as the four mistakes a deployer actually makes, not
 * as coverage of the function's branches.
 */

const ed = generateSigningKeyPair();

/** Current v1 token with explicit product/subject and authorization context. */
function payload(overrides: Partial<LicenseTokenPayload> = {}): LicenseTokenPayload {
  return {
    v: 1,
    kind: "license",
    iss: "default",
    productId: "default",
    subject: { kind: "installation", id: "5f3a" },
    accountId: null,
    authorizationRevision: 1,
    paidImportsGranted: null,
    recoveryGeneration: 0,
    trialConverted: true,
    kid: "test-key",
    licenseId: "9c1e4d2a",
    plan: "pro",
    entitlements: { seats: 5 },
    issuedTo: "Acme Ltd",
    installationId: "5f3a",
    issuedAt: "2026-08-26T09:20:00.000Z",
    expiresAt: null,
    offlineGraceUntil: "2026-09-25T09:20:00.000Z",
    status: "active",
    ...overrides,
  };
}

test("a valid Ed25519 key is described by its public half", () => {
  const info = describeSigningKey(ed.privateKey);
  assert.equal(info.keyType, "ed25519");
  // The derived public key must be byte-identical to what keygen printed —
  // otherwise the fingerprint an operator compares against means nothing.
  assert.equal(info.publicKeyPem.trim(), ed.publicKey.trim());
  assert.match(info.fingerprint, /^([0-9a-f]{2}:){7}[0-9a-f]{2}$/);
});

/**
 * Hashed over DER rather than the PEM text on purpose: the same key re-exported
 * can differ in line wrapping and trailing newline. A fingerprint that moved
 * with whitespace would report a key as differing from itself, which is worse
 * than having no fingerprint at all.
 */
test("the fingerprint survives re-exporting and reformatting the same key", () => {
  const canonical = fingerprintPublicKey(ed.publicKey);
  assert.equal(fingerprintPublicKey(ed.publicKey.trim()), canonical);
  assert.equal(fingerprintPublicKey(`${ed.publicKey}\n\n`), canonical);
  assert.equal(fingerprintPublicKey(ed.publicKey.replaceAll("\n", "\r\n")), canonical);
  // And it must actually distinguish two different keys.
  assert.notEqual(fingerprintPublicKey(generateSigningKeyPair().publicKey), canonical);
});

test("an RSA key is refused, naming the algorithm rather than failing at sign time", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  assert.throws(() => describeSigningKey(rsa), /ed25519|Ed25519/i);
});

test("a public key pasted where the private one belongs says so", () => {
  // The most common paste error, and the least obvious from an OpenSSL error.
  assert.throws(() => describeSigningKey(ed.publicKey), /PUBLIC key/);
});

test("a PEM flattened to one line by an env editor is diagnosed, not just rejected", () => {
  const escaped = ed.privateKey.replaceAll("\n", "\\n");
  assert.throws(() => describeSigningKey(escaped), /escaped newlines/);
});

test("garbage and emptiness are refused with something to act on", () => {
  assert.throws(() => describeSigningKey(""), /empty/i);
  assert.throws(() => describeSigningKey("   "), /empty/i);
  assert.throws(
    () => describeSigningKey("-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n"),
    /readable PEM private key/,
  );
});

/**
 * The failure that is invisible from both ends: the server signs happily, the
 * app rejects every token, and nothing in either log says why. Verification had
 * to exist before this could even be asserted — the service only ever signs.
 */
test("a token verifies against its own key and against no other", () => {
  const token = signLicenseToken(payload(), ed.privateKey);
  const info = describeSigningKey(ed.privateKey);

  const mine = verifyLicenseToken(token, info.publicKeyPem);
  assert.equal(mine.valid, true);
  assert.deepEqual((mine.payload as LicenseTokenPayload).entitlements, { seats: 5 });

  const theirs = verifyLicenseToken(token, generateSigningKeyPair().publicKey);
  assert.equal(theirs.valid, false);
  assert.match(theirs.reason ?? "", /does not match/);
});

test("a tampered payload does not verify, even though it still decodes", () => {
  const token = signLicenseToken(payload({ entitlements: { seats: 5 } }), ed.privateKey);
  const [, signature] = token.split(".");
  // Someone editing their own entitlements is the attack the signature exists
  // for. `license inspect` would happily print the forged payload.
  const forged = Buffer.from(
    JSON.stringify(payload({ entitlements: { seats: 5000 } })),
    "utf8",
  ).toString("base64url");
  const result = verifyLicenseToken(`${forged}.${signature}`, ed.publicKey);
  assert.equal(result.valid, false);
  assert.deepEqual((result.payload as LicenseTokenPayload).entitlements, { seats: 5000 });
});

test("malformed tokens are reported as answers, not thrown as errors", () => {
  for (const bad of ["", "nonsense", "only-one-part", "a.b.c"]) {
    const result = verifyLicenseToken(bad, ed.publicKey);
    assert.equal(result.valid, false, bad);
    assert.ok(result.reason, `${bad} should explain itself`);
  }
  const notJson = `${Buffer.from("not json", "utf8").toString("base64url")}.AAAA`;
  assert.match(verifyLicenseToken(notJson, ed.publicKey).reason ?? "", /not valid JSON/);
});

/**
 * The CLI and the server must resolve the same key from the same environment.
 * A keycheck that consulted a different key than the service uses would be
 * worse than no check — it would report health while production was broken.
 */
test("the key is resolved from the environment the way the service does", () => {
  assert.equal(resolveSigningKey({ LICENSE_SIGNING_KEY: ed.privateKey }), ed.privateKey);
  // Escaped newlines are un-escaped here, so a dashboard-pasted key still works.
  assert.equal(
    resolveSigningKey({ LICENSE_SIGNING_KEY: ed.privateKey.replaceAll("\n", "\\n") }),
    ed.privateKey,
  );
  assert.throws(
    () =>
      resolveSigningKey({ LICENSE_SIGNING_KEY: ed.privateKey, LICENSE_SIGNING_KEY_FILE: "/nope" }),
    /only one/,
  );
  assert.throws(() => resolveSigningKey({}), /LICENSE_SIGNING_KEY/);
});
