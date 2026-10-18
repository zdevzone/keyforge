# Import licensing, additive renewals and recovery

This source implementation adds an **opt-in** contract. It has not been deployed or published merely because this document exists. Existing products/licenses continue using license v4 and trial v2. Import-account licenses use **v5**, import-policy trials use **v3**, and recovery uses a separate **usage-recovery v1** artifact. Ed25519 continues signing decoded JSON bytes; no JWT conversion or private-key rotation is involved.

## Business rules

One successful new photo/video asset costs one import. Thumbnails, proxies, sidecars, failed/cancelled work, duplicate existing assets and retries of the same operation cost nothing extra. Deletion never refunds units. A later new ingestion of a deleted asset costs a unit. The dependent app implements this classification and commits the receipt with its media database transaction. KeyForge neither receives media nor counts local imports.

Keep permanent lifetime history and separate trial/paid usage. First paid activation forfeits unused trial access; no trial resumes after paid expiry, release, revocation or refund. The default trial remains 20,000 units without time expiry. Product operators can configure trial policy; they must not advertise values different from the actual signed grant.

KeyForge stores cumulative **paid units granted**, not usage history. Studio Proof stores paid units consumed and trial units consumed locally. Remaining paid allowance is granted minus consumed, bounded below by zero. A trial user who consumed 12,000 units and buys 50,000 paid units gets all 50,000 paid units; lifetime history stays 12,000. After using 12,000 paid units, remaining paid allowance is 38,000. A renewal adding 50,000 raises it to 88,000. Refresh, key replacement, deactivation, payment recording and retry never refill it.

| Operation | Units and time |
| --- | --- |
| Initial issuance | Current plan's import units and duration; one ETB sale, unpaid by default. |
| `renewal` | Add selected plan's units once; extend from max(current expiry, now). A perpetual license stays perpetual. A perpetual renewal plan removes the time deadline. |
| `top_up` | Add selected plan's units once; preserve expiry. |
| `extension` | Add no units; extend using selected plan's duration. |
| Replacement key | Same license/account, units and expiry; no sale. |
| Smaller future purchase | Adds the smaller purchased allocation; never removes existing allowance. |

Units carry forward but imports require active authorization, unexpired paid term and unexpired offline lease. Base feature entitlements remain the original license snapshot; the renewal plan supplies the purchased units, duration and price. This endpoint does not schedule feature-tier changes. Generic entitlement edits are blocked on import-account licenses: use the explicit purchase operations for units/time. A purchase without a receipt remains unpaid and authorized, preserving existing operator-controlled issuance. Payment/refund/credit entries affect finances, not units. Revocation is a separate deliberate action and reaches offline apps only within their signed lease bounds.

## Enable without rewriting existing data

New records use the existing scoped `platform_records` ledger and its SQLite/PostgreSQL transaction lock. No auth-table migration, session reset, historic-sale rewrite or guessed backfill occurs. Accounts, operation receipts, approvals and immutable licensing-event records travel with normal application backups and database copies. They are not part of catalog export/import.

Use an isolated test server first. Configure an active numeric entitlement (usually `imports`) and priced plans with **one installation seat**, then opt in:

```sh
vp run license imports-enable --product studio-proof --entitlement imports --revision 3 --env-file secrets/environments/staging/server.env
vp run license issue --product studio-proof --plan standard --to "Test studio" --request-id 11111111-1111-4111-8111-111111111111 --env-file secrets/environments/staging/server.env
vp run license imports-account LICENSE_ID --product studio-proof --env-file secrets/environments/staging/server.env
```

Get the current product revision through its catalog. Replace example IDs/revisions with verified values. Enabling policy affects future issuance and registration, not existing licenses. Import plans must supply a finite nonnegative safe-integer numeric allowance; missing/negative/fractional/string values fail closed. Zero grants no imports. Paid unlimited plans are not inferred from null/omission. Per-purchase entitlement bounds do not cap the cumulative account total.

For an existing license, reconcile purchased allowance and surviving usage privately first:

```sh
vp run license imports-adopt LICENSE_ID --product studio-proof --granted 50000 --revision 4 --reason "Verified the original purchased allowance" --request-id 22222222-2222-4222-8222-222222222222 --env-file secrets/environments/staging/server.env
```

This creates an account without a new sale or receipt. Existing licenses with multiple historical installations require manual reconciliation rather than guessing a shared offline budget. The SDK must explicitly adopt verified surviving legacy usage; lack of a new ledger never means zero. An already adopted account cannot be reinitialized. A licensing account remembers its installation after seat release; transferring it requires approved recovery. Hardware matching never transfers it. Multiple independent offline computers sharing one budget remain unsupported.

## Renewals and operator permissions

```sh
vp run license renew LICENSE_ID --product studio-proof --plan standard --mode renewal --request-id 33333333-3333-4333-8333-333333333333 --env-file secrets/environments/staging/server.env
vp run license renew LICENSE_ID --product studio-proof --plan standard --mode top_up --request-id 44444444-4444-4444-8444-444444444444 --env-file secrets/environments/staging/server.env
vp run license renew LICENSE_ID --product studio-proof --plan standard --mode extension --request-id 55555555-5555-4555-8555-555555555555 --env-file secrets/environments/staging/server.env
vp run license replace-key LICENSE_ID --product studio-proof --reason "Customer requested a replacement key" --request-id 66666666-6666-4666-8666-666666666666 --env-file secrets/environments/staging/server.env
```

Keep each printed operation UUID and replay **the same body and actor** after a lost response. Changed body/actor conflicts. Selected plan price/terms are snapshots. Renewal, allowance increment, sale, optional full receipt and licensing event commit together. `--paid --method "Bank transfer" --reference TEST-001` records today's UTC receipt. Recording payment later uses the existing finance workflow and adds no units. Generic manual sales creation is rejected for import accounts to prevent disconnected renewal records. Renewals do not issue another key; refresh the existing license binding.

These policy, account, purchase, replacement and recovery-management APIs require admin sessions or the optional admin bearer. Support operators cannot read financial/account details or approve/reject recovery. Existing support/seat-release permissions remain intact. Session writes check Origin as before; session key replacement additionally requires the current `password`. Ordinary device methods never accept administrator credentials.

## SDK storage and import enforcement

Use a secure `SecureStorage` adapter with **atomic `compareAndSwap(expectedRevision, nextState)`**. Expected null means no existing record; otherwise match stored `storageRevision` (legacy absence means zero). Commit the complete snapshot only if the version matches. `save` remains for old adapters/legacy licensing, but new import mutations require CAS. `MemoryStorage` implements CAS for tests only, not persistence or OS security.

For a real import, run the SDK's load/CAS operations inside the same host database transaction as the asset insert. Protect credentials/usage using the application's secure-storage facilities. A framework-independent SDK cannot make an unrelated media database and file vault atomic by itself. The adapter must enlist those operations in the host transaction, including rollback. Concurrent owners get `storage_conflict`; reload and retry the same event UUID. Never catch storage corruption and substitute empty state.

```ts
const client = new KeyForgeClient({ serverUrl, productId, publicKeys, storage });
await client.startTrial(); // online, explicit
await client.activate(customerKey); // online; paid conversion is permanent
const authorization = await client.getAuthorization();
// Inside the host's media transaction, after successful ingestion:
const result = await client.consumeImport(importEventUuid, 1);
// result.recorded=false means this UUID was already charged; do not charge twice.
// Commit the media insert and the storage adapter's CAS together.
const usage = await client.getImportUsage();
```

Use `consumeImport` with a stable UUID per successful operation; receipts survive restarts and backups. A repeated UUID with different units conflicts. Trials and paid imports increment different counters and permanent lifetime history. The legacy `consumeTrial` helper has no caller-supplied replay ID; new integrations should use `consumeImport`. Paid quota exhaustion returns `quota_exhausted`; invalid usage returns `recovery_required`. Neither state should prevent reading existing media. `licensed` alone is not sufficient if the host bypasses consumption or media-transaction integrity.

For legacy state, call `adoptLegacyImportUsage({lifetimeImports,paidConsumed,trialConsumed,lifetimeKnown})` only with independently verified local history. It preserves known counters and refuses repeat initialization after account adoption. Missing/corrupt history requires recovery, not this migration helper. Existing SDK state and credentials are retained; v4/v2 remain valid for products/licenses not opted in. Once an account has used v5, the SDK rejects protocol downgrade and lower signed revisions/granted totals. Publish updated clients before enabling new contracts; older v4-only clients intentionally reject v5.

V5 adds `accountId`, `authorizationRevision`, `paidImportsGranted`, `recoveryGeneration`, `trialConverted:true`. V3 adds `converted`. All other base fields remain; schemas are in the current OpenAPI. Revision increments for authorized changes; refresh can mint a later lease at the same revision with unchanged authorization terms. The SDK rejects conflicting same-revision terms and earlier revisions. Issuance time remains a freshness check, not a replacement for revisions. Signed revoked/expired states still supersede active grants; local clocks and deadlines remain enforced.

## Customer-controlled encrypted backups

```ts
const encrypted = await client.exportUsageBackup(strongBackupPassphrase);
// Save outside the device, separately from the passphrase. Never log either.
```

The backup contains the usage ledger/receipts/account metadata, **not** installation credentials, customer keys or an ordinary configuration export. Retain credentials in platform secure storage or a separately protected application-state backup. Usage backup v1 uses AES-256-GCM, fresh random 16-byte salt and 12-byte nonce, and PBKDF2-HMAC-SHA256 with 600,000 iterations. Use a password-manager-generated passphrase (API accepts 12–1024 characters). Associated data binds `['keyforge-usage-backup',1,canonicalServerUrl,productId]` as compact JSON. Serialized envelope is `{v:1,salt,iv,data}` with canonical unpadded base64url; data includes the GCM tag. Export plaintext cap 24 MB, import envelope cap 32 MB. Wrong passwords, altered data and wrong deployment/product fail authentication. The SDK never sends the backup or its password to KeyForge.

Authenticated encryption follows [OWASP cryptographic storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html); password-derived keys still depend on strong, separately retained passphrases. A valid backup proves an intact snapshot, **not that it is the newest snapshot**. Automatic backup rollback is not supported; restoration requires staff approval. Local receipts currently reside in the state snapshot and grow with usage; applications with large histories need an indexed transactional storage implementation and a backup capacity plan rather than dropping old event IDs.

## Recovery flow and limits

1. If trustworthy history survives, keep it; do not manufacture a recovery event. If usage integrity fails, call `markUsageRecoveryRequired()` and keep the surviving counters/evidence.
2. Restore secure credentials, or register a deliberately new installation if credentials were lost. Possession of a product key or hardware hashes cannot claim the old account.
3. Call `requestUsageRecovery(licenseId, {encrypted,password})` for a verified backup, or omit the backup for lost-history recovery. The SDK persists request UUID, random challenge and candidate before networking. Retry without providing a new backup; the exact request/challenge stays unchanged.
4. An admin independently verifies the customer/account and backup provenance, lists requests and explicitly approves `restore` or `lost_history` with a required reason. Knowing a license ID/challenge is not proof of ownership. Approval is bound to product, account, target installation, nonce commitment and current account revision, and lasts 24 hours.
5. The customer calls `claimUsageRecovery()`. Server claim releases the previous binding, advances revision/generation once and binds the approved installation. The SDK verifies both signatures, context, challenge, commitment and generation, then atomically adopts usage and clears the pending intent. Lost responses/persistence failures replay safely. Older generations and concurrent account changes are rejected.

```sh
vp run license recovery-list --product studio-proof --env-file secrets/environments/staging/server.env
vp run license recovery-approve REQUEST_ID --product studio-proof --revision 1 --mode restore --reason "Verified customer and backup provenance" --request-id 77777777-7777-4777-8777-777777777777 --env-file secrets/environments/staging/server.env
vp run license recovery-reject REQUEST_ID --product studio-proof --revision 1 --reason "Could not verify account ownership" --request-id 88888888-8888-4888-8888-888888888888 --env-file secrets/environments/staging/server.env
```

Use `--mode lost_history` only for a confirmed loss. It treats **all previously granted paid units as consumed**, forfeits trial and marks lifetime totals unknown. It preserves every surviving known counter; it does not invent an exact historical import total. New allowance is an explicit later purchase/goodwill decision, not an automatic refill. A restore merges maxima of surviving and backup counters and compatible event receipts; conflicting receipts fail. Lifetime history after a loss stays unknown with a preserved known lower bound. An expired license requires a deliberate time extension before claim; do not add new units before conservative lost-history recovery unless they are also meant to be treated as consumed.

Recovery artifact fields: base issuer/product/key/installation/time, `kind:'usage-recovery'`, `v:1`, UUID `recoveryId`, accountId, challenge, mode, nullable usageDigest, paidImportsFloor, trialImportsFloor, recoveryGeneration, authorizationRevision. It is **not a license**; `verifySignedToken` rejects it and `verifyRecoveryToken` requires its separate schema and unexpired deadline. The claim response includes a normal v5 token, the recovery token and unsigned serverTime. No raw usage records/counts are uploaded. The optional commitment is SHA-256 over compact UTF-8 JSON in this exact order:

```text
["keyforge-usage-recovery",1,challenge,accountId,paidConsumed,trialConsumed,
 lifetimeImports,lifetimeKnown,integrity,trialConverted,legacyPaidSeen,legacyVerified,
 authorizationRevision,recoveryGeneration,granted,termsHash,
 [[eventUuid,units,source],...]]
```

Sort receipt entries by ascending UUID string; booleans/null/numbers retain JSON types. The random challenge salts the commitment. Native integrations must implement the same ordering if exchanging SDK snapshots. Payload schemas cannot replace signature, challenge, ownership, clock or same-account checks.

After expired/stale/rejected approval, explicitly `abandonUsageRecovery()` and request a fresh approval; never silently replace a pending UUID after a timeout. A claimed record replays only while its generation/owner remain current. Repeated local claim after successful adoption returns current authorization without reapplying the recovery. Multiple approvals cannot both change the same account revision. Licensing events record who approved and why within the same transaction as the operation; ordinary legacy audit logging is unchanged.

This protects normal crashes, retries, concurrent instances and authorized recovery. It does not provide hardware attestation, a secure wall clock or protection against an attacker controlling the OS and rolling back **all** local secure state. Complete local-only history loss cannot yield an exact reconstructed total. Offline copies of old grants remain bounded by their signed deadlines, including after transfer/revocation. Server database rollback must be reconciled against client high-water revisions before service resumes; never lower a client revision to make a restored server accept it.

## API and acceptance

Admin API (all product-scoped): PUT import-policy; GET/POST licenses/:id/import-account; POST licenses/:id/renew; POST licenses/:id/replace-key; GET recovery-requests; POST recovery-requests/:id/approve or /reject. Body schemas and CLI examples above document the workflow; the full route inventory is in [API reference](api.md). Customer recovery request/claim schemas and all new token payloads are in [OpenAPI](client-openapi.json).

Run `vp run check`, `vp run test`, `vp run build:all`, OpenAPI drift and package/browser checks. `test/import-licensing.test.ts` exercises additive renewal, receipts, trial conversion, key replacement, CAS races, legacy migration, encrypted restore, conservative recovery, malformed signatures, expiry, stale approvals and isolated PostgreSQL concurrency when TEST_DATABASE_URL is configured. Never use production keys/data or enable live policy as a test. Deployment and package publication are separate release actions.
