# Current KeyForge client contract

The SDK supports Node 22.18+ as its reference runtime and needs Fetch, Web Crypto Ed25519, TextEncoder/TextDecoder, base64 helpers and secure randomness. It contains no UI or framework-specific credential vault. Keep installation identity in the desktop trusted/main process. For another language, implement against the server's OpenAPI and token contracts with shared test vectors; do not import Node-specific assumptions.

## Setup and state

```ts
import { KeyForgeClient, type SecureStorage } from "@zdevzone/keyforge-client";
declare const storage: SecureStorage;
declare const publicKeys: Record<string, string>;
const client = new KeyForgeClient({
  serverUrl: "https://licenses.example.com",
  productId: "your-product",
  publicKeys,
  storage,
});
```

`SecureStorage.load()` returns a snapshot of `ClientState | null`; `save(state)` atomically replaces it. Scope a record to server URL, product and subject kind. Preserve identity, pending registration UUID/body, tokens, consumed trial usage, denial and clock checkpoint across restarts. Only a truly new installation returns null. Lost credentials need operator-assisted seat recovery, not silent state deletion. `MemoryStorage` is test-only/ephemeral. One SDK owner serializes calls; the host must prevent multiple writers across processes.

## Online onboarding and offline usage

- `activate(key)` registers if needed, activates online, verifies and saves the returned license, then returns authorization.
- `startTrial()` requires online access and explicitly selects the previously obtained/server-issued trial. Registration alone does not select it; skipping onboarding grants no paid features.
- `register()` persists identity and exact request before networking. Its bearer is a generated installation secret, not the product key or an administrator credential. Retry the same body/UUID after an ambiguous timeout. Do not change pending registration metadata.
- `validate(key)` is online inspection; it does not bind a seat or create offline authorization.
- `getAuthorization()` needs no network. Allow paid operations only for `state === "licensed"` and the exact required signed entitlement. Trial behavior must be defined by the app; trial grants do not contain paid plan entitlements.
- `refresh()` requires a bound license and internet. Schedule before the returned paid `deadline`; the SDK does not run background workers. Transport retries bounded network/429/502/503/504 failures. A transient failure leaves an otherwise usable cached grant. Explicit binding/identity denials block fallback.
- `deactivate()` releases the seat online, clears local paid use after success, and does not silently enable trial use.
- States: `unlicensed`, `trial`, `licensed`, `reconnect_required`, `expired`, `revoked`. Reason codes explain failures. Correct a rolled-back system clock before reconnecting.
- `consumeTrial(units)` persists cumulative consumption independently of grants and returns post-consumption state. Check available units before allowing work. No refresh/restart may reset consumption. Local counters are not authoritative on compromised devices.

## Verification invariants

`createDeviceSignalsProvider()` from `@zdevzone/keyforge-client/device-signals` automatically selects Windows, Linux or macOS in a trusted Node process. Explicit `/linux` and `/macos` exports are available; the `/windows` contract remains compatible. Consult the packaged README or `docs/device-identity.md` for per-OS sources and hash vectors. Never elevate to obtain DMI signals. Unsupported/sandboxed platforms still use installation credentials, not fabricated fingerprints. Only JS/TS has an official SDK; other languages implement the same HTTPS, secure-storage, retry and signed-token contracts. OpenAPI generation covers HTTP plumbing, not offline authorization.

For opt-in Windows recognition, use `@zdevzone/keyforge-client/windows` only in a trusted Node process. Follow the SDK README's exact v1 normalization/hash scope; never invent an all-platform fingerprint. Preserve pending registration signals before networking. Use `getDeviceSignalsDiagnostics()` to explain partial/unsupported collection and `updateDeviceSignals()` for existing authenticated identities. Backfill does not register, reset trial consumption, change meters/seats or merge groups. Test permission/timeout/placeholder cases, interrupted registration with changed hardware, legacy backfill and wrong-product credentials. URL/product changes require coordinated state migration, not silent identity replacement. Hardware signals are forgeable hints; do not promise physical-device enforcement or offline seat transfer.

License v4/trial v2 tokens are `base64url(JSON bytes).base64url(Ed25519 signature)`. The signature covers **decoded UTF-8 JSON bytes**, without reserialization. These are not JWTs. `verifySignedToken` authenticates payload/context even for negative statuses; it alone does not grant access. Prefer `getAuthorization` for permission.

Pin approved SPKI public PEMs by `kid`. Never automatically trust keys fetched beside a token. Reject malformed payloads, unknown versions/kids, wrong issuer/product/installation/subject, implausible future issuance and invalid signatures. Paid access ends at the earlier of expiry and offline grace. A signed revoked/expired refresh can be HTTP 200: save it before evaluating access. Trial `spent`, allowance exhaustion and expiry fail closed. Trials use their own nullable expiry/allowance contract, not the paid offline-grace field. Offline revocation is bounded by the signed deadline; no client can promise immediate offline revocation or prevent all local tampering.

## Optional communication

Register first, then use `getNotifications()`, `setNotificationPreferences({messages, expirations})`, and `markNotificationRead(eventId)`. Poll while online, pause when backgrounded/offline, and back off on failures. There is no email/realtime delivery; collections are currently unpaginated at the server.

`collectLicense(licenseId)` retrieves a key targeted to this installation. It does not activate it. Construct collection through the SDK instead of following arbitrary `collectPath` URLs with a credential.

Use `listSupportThreads()`/`getSupportThread(id)`. `createSupportThread` takes `requestId`, `licenseId`, `category`, `urgency`, `subject`, `message`, `createdAt` and optional reporter/app metadata. The SDK sets `Idempotency-Key` to requestId. Technical/feature/other categories require an active binding; licensing/billing also permit existing expired/released bindings; trial-only installations cannot create cases.

`replyToSupportThread(id, {requestId, revision, message})` requires the latest revision. Persist exact request/body in a durable host outbox before sending. On revision conflict reload and reconcile; on ambiguous timeout replay exactly. Customer replies reopen resolved/waiting cases, while closed cases require a new case. Internal notes and assignments remain server-private. Request-link secrets for preinstallation customers are separate from installation credentials. Usage metering uses a trusted backend's scoped service credential and is intentionally absent from this desktop SDK.
