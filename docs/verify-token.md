# Verifying license tokens in your application

The server signs every token with its Ed25519 private key. Your application
embeds the **public** half (printed by `npm run license keygen`) and verifies
tokens locally — no network call, no shared secret worth stealing.

A token is `base64url(payload).base64url(signature)`.

## Node.js / Electron

```js
import { verify } from "node:crypto";

// The public key printed by keygen. Ships inside your app; it is not secret.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
...yours here...
-----END PUBLIC KEY-----`;

export function readLicenseToken(token) {
  const [body, signature] = token.split(".");
  const bytes = Buffer.from(body, "base64url");
  const ok = verify(null, bytes, PUBLIC_KEY, Buffer.from(signature, "base64url"));
  if (!ok) throw new Error("license token signature is invalid");
  return JSON.parse(bytes.toString("utf8"));
}
```

## What the payload contains (v2)

```jsonc
{
  "v": 2,
  "licenseId": "…",
  "plan": "standard",
  "entitlements": { "allowance": 200000, "pro": true },  // vendor-defined
  "allowance": 200000,          // mirror of entitlements.allowance (v1 compat)
  "issuedTo": "Customer Name",
  "installationId": "…",        // the machine this token is bound to
  "issuedAt": "…",
  "expiresAt": null,            // or an ISO date
  "offlineGraceUntil": "…",     // revalidate against the server after this
  "status": "active"            // or "revoked" / "expired" — also signed!
}
```

## Enforcement rules your app should apply

1. Signature must verify (above). Otherwise treat as unlicensed.
2. `installationId` must match this installation.
3. `status` must be `active` — persist revoked/expired tokens too, so the
   verdict survives restarts.
4. If `expiresAt` is set and past, treat as expired.
5. If `offlineGraceUntil` is past, call `POST /v1/refresh` for a fresh token;
   keep working during the grace window even when offline.
6. Enforce whichever `entitlements` your product defines (a count, a feature
   flag, a tier). Unknown entitlements are ignored, which is what makes the
   scheme forward-compatible.
