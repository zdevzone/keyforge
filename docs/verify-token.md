# Verify KeyForge v1 authorization

License, trial and usage-recovery artifacts all use `v: 1`, distinguished by `kind`. This is the sole supported protocol. There is no version negotiation, alternate parser or data-adoption path. Use a fresh development database and SDK secure-state store when testing this baseline. Preserve the deployment's existing signing keys; changing the format does not require key generation.

## Encoding and signature

Tokens contain exactly two canonical unpadded base64url segments: `base64url(UTF-8 JSON bytes).base64url(Ed25519 signature)`. Verify the signature against the **original decoded bytes**, without reserializing JSON. Tokens are not JWTs. Use an authenticated update channel to pin the intended product/environment public keys. Discovery does not establish trust. Reject unknown key IDs, malformed encodings, unknown fields and versions, wrong issuer/product/installation/subject, future issuance and invalid timestamps.

## License v1

Required fields: `v`, `kind:'license'`, `iss:'default'`, `productId`, `kid`, `installationId`, `licenseId`, `plan`, `entitlements`, `issuedTo`, `subject:{kind,id}`, `issuedAt`, nullable `expiresAt`, `offlineGraceUntil`, `status`, nullable `accountId`, positive `authorizationRevision`, nullable `paidImportsGranted`, nonnegative `recoveryGeneration`, and `trialConverted:true`.

Products without local import quotas use `accountId:null`, `paidImportsGranted:null`, `recoveryGeneration:0`. These are explicit feature settings in the same v1 format. Import-account licenses require a non-null account, nonnegative cumulative paid allowance and an installation subject. Subject ID must equal installationId. An entitlement map remains a plan snapshot; cumulative purchased import allowance is `paidImportsGranted`.

Authenticate and persist signed revoked/expired responses before returning a result; they supersede earlier active authorization. An active signature alone is insufficient. Enforce status, expiry, offline deadline, signed revision/generation and local usage integrity at the protected operation. Reject older revisions and conflicting terms at the same revision. A lease refresh may update mint time/deadline without adding allowance. Keep existing media readable when new imports are blocked.

## Trial v1

Required fields: `v`, `kind:'trial'`, `iss`, `productId`, `kid`, `installationId`, `issuedAt`, nullable `expiresAt`, `verdict:'fresh'|'spent'`, nullable nonnegative `allowance`, nullable `supportReference`, and boolean `converted`. Enforce the signed limits and durable local trial consumption. Paid conversion permanently forfeits trial; refresh/restart never resets usage. Trial time/allowance rules are distinct from paid offline grace.

## Recovery v1

Recovery is separately verified with `kind:'usage-recovery'`. Required context fields are issuer/product/key/installation, issuance and a required expiry; additional fields are recoveryId, accountId, challenge, mode, nullable usageDigest, paidImportsFloor, trialImportsFloor, recoveryGeneration and authorizationRevision. It is never an application license. Approval is staff-controlled, target/challenge/account-bound and time-limited. Verify the matching ordinary license and pending backup commitment, then adopt atomically once. See [recovery](import-licensing.md#recovery-flow-and-limits).

## Reference implementations and vectors

Use SDK `@zdevzone/keyforge-client@0.2.0` and the [OpenAPI](client-openapi.json) schemas. Other languages can implement the same HTTPS/signature/storage contract without adding Node. [Portable v1 vectors](examples/client-contract/README.md) include checksums and test-only public keys. Run `vp exec tsx scripts/generate-client-fixtures.ts --check` to detect drift. Never use fixture keys for a deployment.
