# Signed token verification

A token is two unpadded base64url strings separated by one dot:

```text
base64url(UTF-8 JSON payload).base64url(64-byte Ed25519 signature)
```

The signature covers the **decoded UTF-8 JSON bytes**, exactly as returned by base64url-decoding the first segment. Do not reserialize the JSON or verify the encoded segment. There is no JWT header. Decoding is untrusted inspection, not verification.

## License v4

Required fields: `v:4`, `kind:"license"`, `iss:"default"`, `productId`, `kid`, `licenseId`, `plan`, `entitlements`, `issuedTo`, `subject:{kind:"installation"|"service",id}`, `installationId`, `issuedAt`, nullable `expiresAt`, `offlineGraceUntil`, and `status:"active"|"revoked"|"expired"`. Entitlements are a map of finite numbers, strings or booleans. Subject ID must equal installation ID.

Reject extra or missing fields, unknown versions, malformed timestamps or invalid types. Match issuer, product ID, subject kind and installation ID to your own expected context. Reject future issuance beyond your clock tolerance, negative status, passed expiry and passed offline deadline. Persist the maximum local clock and authenticated signed issuance time observed; the unsigned HTTP `serverTime` field is not a trusted time oracle. This makes basic clock rollback harder, but does not protect against a compromised device.

## Trial v2

Required fields: `v:2`, `kind:"trial"`, issuer, productId, kid, installationId, issuedAt, nullable expiresAt, `verdict:"fresh"|"spent"`, nullable nonnegative integer allowance and nullable supportReference. Accept only the expected product/installation, a valid signature and a fresh unexpired grant. A null allowance means the product has no numeric trial ceiling; interpret it according to your product policy. Persist consumption outside the grant.

## Node signature example

```js
import { verify } from "node:crypto";

function verifySignature(token, pinnedKeys) {
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return null;
  const [encoded, signature] = parts;
  let untrusted;
  try { untrusted = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { return null; }
  const publicKey = pinnedKeys[untrusted.kid];
  if (!publicKey || !verify(null, Buffer.from(encoded, "base64url"), publicKey,
      Buffer.from(signature, "base64url"))) return null;
  // Apply the complete shape and contextual/time checks described above.
  return untrusted;
}
```

The example verifies only the cryptographic signature; do not use its return value as authorization before implementing the remaining checks. `src/token-contract.ts` defines server payload schemas. Prefer the complete verifier and authorization evaluator in [the TypeScript SDK](../packages/keyforge-client/README.md). `verifySignedToken` authenticates shape and context, including signed negative statuses; only the SDK's `getAuthorization` result indicates whether use is currently allowed.

## Rotation

Public product key discovery at `/v1/products/:productId/keys` helps operators distribute keys; downloading a key beside an untrusted token does not establish trust. Authenticate your distribution/update channel and pin approved keys. An admin stages a new key, distributes it to clients, then explicitly activates it. Retired public keys remain available for existing offline grants. Never activate before deployed clients trust the new kid.
