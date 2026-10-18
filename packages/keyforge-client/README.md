# KeyForge TypeScript client

**0.2.0 is the fresh v1 baseline.** License, trial and usage-recovery grants use v1 only. Previous development tokens, databases and cached SDK state are unsupported; start with a fresh database and new installation state while retaining server signing keys. Production storage must implement atomic compare-and-swap. Use `consumeImport(eventId, units)` for trial and paid imports; there is no counter-adoption or old-format conversion API.


`@zdevzone/keyforge-client` provides online onboarding, registration/activation, signed offline authorization, trial accounting, public support threads and in-app notifications. It supports the existing product-scoped server API, license, trial and recovery v1. It uses Fetch, Web Crypto Ed25519, and Zod; it has no server, database, UI or desktop-framework dependency. Node 22.18+ is the reference runtime. Other desktop runtimes must support those Web APIs or run the client in their trusted Node/main process.

Install in an existing application:

```sh
vp add @zdevzone/keyforge-client
```

Or create a separate Node.js integration starter:

```sh
vp create keyforge-client
```

The [starter](../create-keyforge-client/README.md) includes explicit onboarding commands, public-key pinning and a secure-storage adapter boundary. Its memory demo supports local status only; implement secure atomic storage before real activation or offline restart testing.

For workspace development, use `"@zdevzone/keyforge-client": "workspace:*"`. To install a reviewed local build in another repository, run `vp -C packages/keyforge-client pm pack --pack-destination ../../.artifacts`, copy the archive into that app's `vendor/` folder, and run `vp add ./vendor/zdevzone-keyforge-client-0.1.0.tgz`. The prepack hook builds and verifies JavaScript/type exports automatically; do not disable lifecycle scripts. Commit the archive, dependency and lockfile so installs remain reproducible. Zod is the only runtime dependency.

The old name `@keyforge/client` belongs to another project. Maintainers should follow the [package release guide](../../docs/publishing.md).

## Onboarding and authorization

```ts
import { KeyForgeClient, type SecureStorage } from "@zdevzone/keyforge-client";

// Implement this using your framework's credential vault and an atomic state record.
declare const secureStorage: SecureStorage;
declare const pinnedPublicKeys: Record<string, string>;

const client = new KeyForgeClient({
  serverUrl: "https://licenses.example.com",
  productId: "your-product",
  publicKeys: pinnedPublicKeys, // { "trusted-kid": "-----BEGIN PUBLIC KEY-----\n..." }
  storage: secureStorage,
  registration: { appVersion: "1.0.0", platform: "windows" },
});

// Choose one from customer onboarding; these require internet.
// await client.activate(keyEnteredByCustomer);
// await client.startTrial();

// Skipping onboarding leaves the app unlicensed. This call needs no network.
const authorization = await client.getAuthorization();
if (authorization.state === "licensed" && authorization.entitlements.export === true) {
  // Permit this specific export operation.
}
```

Customers enter their **product/license key**. The SDK generates a different, random **installation secret** behind the scenes. It authenticates subsequent device requests and must survive app restarts. There is no customer-facing credential entry field. Trial onboarding is offered only when provider policy permits it; `startTrial` obtains/evaluates the server's grant and cannot manufacture permission.

`register()` registers online without selecting a trial. `validate(key)` is online inspection only and consumes no seat; only activation returns a paid offline grant. `activate(key)` registers if necessary, binds a seat online, verifies and saves the grant, and returns current authorization. Product keys are never persisted by the SDK. `refresh()` contacts KeyForge for the current bound license; schedule it while online ahead of `deadline`, also after network recovery. There is no hidden background worker. Use a single refresh loop (for example on startup, connectivity recovery, then every few hours with jitter); surface failures and back off instead of polling in a tight loop.

`deactivate()` releases the seat online and clears local paid authorization after success. It does not silently enable a previously selected trial. `collectLicense(licenseId)` retrieves an installation-targeted key; call `activate(result.key)` separately. Collection never grants features by itself.

| State | App behavior |
| --- | --- |
| `unlicensed` | Offer key entry, allowed trial onboarding, or explicitly free features. |
| `trial` | Enforce provider/app trial features and the returned `remaining` allowance. |
| `licensed` | Enforce typed signed `entitlements` at every protected operation. |
| `reconnect_required` | Offer reconnection/activation recovery; do not enable protected features. Inspect `reason`. |
| `expired` | Offer renewal/key entry; no paid/trial authorization. |
| `revoked` | Stop protected use; contact the provider. |

New activation, validation, trial onboarding and refresh require internet. Offline usage checks the authenticity and remaining lifetime of a previously saved grant; it cannot validate a new product key. Paid authorization ends at the earlier of signed expiry and `offlineGraceUntil`. Expiry deadlines have no grace extension for clock tolerance. A signed revoked/expired refresh can arrive with HTTP 200 and is persisted before returning. Refresh failures do not erase a still-usable signed grant for transient network outages; explicit binding/identity denials prevent fallback to an older active grant.

Trials retain their distinct existing contract: `fresh`/`spent`, nullable expiry and nullable allowance. An allowance-only trial may have no time deadline. Call `consumeImport(eventId, units)` at the app's billable trial operation; it serializes and saves cumulative usage separately from grants. Activation, refresh, registration replay and app restarts never reset this counter. Its return state describes authorization **after** consumption, so inspect the pre-operation allowance before starting work and retain the consumed result for the next operation. App-local accounting is mutable on a compromised device; authoritative usage belongs on a trusted backend. A trial grant does not contain paid plan entitlements.

## Storage and trust boundaries

`SecureStorage` has `load(): Promise<ClientState | null>` and `save(state): Promise<void>`. Supply it explicitly. `load` returns an isolated snapshot; `save` must atomically replace a coherent record including identity, pending registration, token(s), counters, denial and clock checkpoint. Protect this record with the operating system's credential storage/encryption, restrict file permissions, and handle failures visibly. For a vault-plus-file design, encrypt state with a vault-held key and atomically replace the ciphertext; never split identity/token/counter updates across non-atomic writes.

Use one SDK owner per installation (typically the desktop main process) and a narrow IPC interface for UI requests. The SDK serializes operations within that instance; cross-process ownership/locking belongs to the host app. Scope storage to deployment URL, product and subject kind. Mismatches or malformed state fail closed rather than creating a new identity. Lost credentials need a new installation and operator-assisted seat recovery; do not silently erase state to work around an authorization failure. `MemoryStorage` is an explicitly ephemeral test/reference adapter, not production storage.

Ship trusted Ed25519 SPKI public PEM keys indexed by `kid` through your signed app/update distribution. The SDK never adds trust by fetching `/keys`. It verifies signatures over the decoded JSON bytes (not the encoded segment or reserialized JSON), strict payload shape, versions, issuer `default`, product, installation and subject, and plausible issuance. `verifySignedToken` authenticates even negative or expired tokens; its return value alone is **not permission**. Use `getAuthorization` for current access. Unknown keys/versions fail closed until an approved app/trust-store update.

Clock checkpoints persist observed local time and authenticated grant issuance times. A rollback greater than five minutes returns `clock_rollback`; correct the system clock and reconnect. Clock tolerance is configurable via `clockToleranceMs` and never extends expiry. This is basic rollback detection, not resistance to a modified binary, restored disk snapshot or compromised device. The SDK does not rely on unsigned `serverTime` to extend access. Offline revocation remains delayed until the signed deadline or a successful refresh.

HTTPS is required except loopback HTTP for local development. Redirects are rejected so credentials do not follow another server. Do not expose SDK state, product keys, tokens or installation secrets in renderer globals, analytics, screenshots, logs or error reports. Signing keys, administrator credentials and metering credentials never belong in the dependent app. Sales/payments and license issuance remain server/operator workflows.

## Retries and communication

Registration identity, UUID and exact body are persisted **before** the first request and reused after interruption/restart. Changes to registration metadata take effect for a new identity, not by mutating a pending request. Activation repeats safely against the same binding; the SDK never creates sales or issues replacement licenses. Default transport uses three attempts, a ten-second per-attempt timeout and bounded exponential backoff with jitter for network failures and HTTP 429/502/503/504. `Retry-After` is honored; waits over 30 seconds return control to the caller instead of retrying early. `KeyForgeError` exposes safe `code`, `status`, `retryable`; `TokenError` identifies verification failures without including secrets.

Optional methods:

- `getNotifications()`, `setNotificationPreferences({messages, expirations})`, `markNotificationRead(eventId)`.
- `listSupportThreads()`, `getSupportThread(id)`.
- `createSupportThread({requestId, licenseId, category, urgency, subject, message, createdAt, reporter?, app?})`.
- `replyToSupportThread(id, {requestId, revision, message})`.

Register before invoking optional methods (getting notifications also registers automatically). Poll while online with a reasonable interval (for example 60 seconds while the inbox is visible), pause when offline/backgrounded, and back off after errors. Collections currently return all installation-visible records; paginate in your app. Private operator notes and assignments are excluded by the server. There is no email, attachment or realtime transport. Technical/feature/other cases need an active paid binding; licensing/billing can use an existing expired or released binding. Trials cannot create cases.

For support creation/replies, persist a durable outbox with the UUID **and exact body** before calling; SDK transport retries reuse these values, but it does not create an app-specific outbox. Case creation sets `Idempotency-Key` to `requestId`. Replies need the current thread revision; a conflict is surfaced for reconciliation rather than silently overwriting newer content. Do not generate a new UUID after an ambiguous timeout. A closed case needs a new case; resolved/waiting cases reopen on a customer reply.

The preinstallation public form/private status link continues to work independently. Request secrets and installation secrets are distinct. Use the issued key in desktop onboarding later. Trusted-backend metering uses separate service credentials and is documented in OpenAPI; it is intentionally absent from the desktop client API.

## Example, skill and validation

The [Node reference](../../examples/keyforge-node.ts) runs with `vp exec tsx examples/keyforge-node.ts` from the repository root. Set `KEYFORGE_SERVER_URL`, `KEYFORGE_PRODUCT_ID`, and `KEYFORGE_PUBLIC_KEYS_FILE` (JSON object mapping trusted kids to public PEMs). Optionally set `KEYFORGE_LICENSE_KEY` or `KEYFORGE_TRIAL=1`; do not put a key in command-line arguments. This executable uses ephemeral storage, creates a new installation each run, and prints only the resulting state. Use a test product: repeated activation can exhaust seats. Its reusable `runReference` function accepts a real storage adapter.

The [AI integration skill](skill/keyforge-integrate/SKILL.md) can be copied with its entire folder into the dependent repository's `.agents/skills/keyforge-integrate/`. It is bundled in the package archive; no global agent configuration is changed by installing the SDK.

The [OpenAPI document](../../docs/client-openapi.json) covers public routes, including separately authenticated preinstallation requests and trusted-backend usage. Regenerate it with `vp run docs:client-api`; `vp run docs:client-api --check` detects drift. SDK tests send real HTTP requests to a temporary KeyForge server and validate requests/responses against this contract. Normal `vp run typecheck`, `vp run test`, `vp run check`, and `vp run build:all` include the package. The SDK does not change server database schemas, token formats, users, license issuance, financial records or signing behavior.

## Optional desktop recognition

Use `createDeviceSignalsProvider()` from `@zdevzone/keyforge-client/device-signals` to select **Windows, Linux or macOS** automatically in a trusted Node process. Explicit `/windows`, `/linux` and `/macos` entry points are also exported. The core import stays framework-independent. This SDK remains JavaScript/TypeScript; other languages can use the HTTP API/OpenAPI contract directly and implement the documented signing, secure storage and retry rules. A generated HTTP client alone does not provide offline authorization.

Linux reports hashed `linux-machine-id`, accessible `smbios-uuid` and `root-volume-uuid`; macOS reports hashed `macos-platform-uuid` and `root-volume-uuid`. Linux reads fixed machine-id/DMI files and queries findmnt; macOS uses fixed ioreg/diskutil queries. No elevation is requested. Permission/tool/sandbox failures yield safe partial reports; browsers/mobile platforms retain installation-based operation. Reads and individual identifiers are bounded to 4 KiB, Apple tool output to 64 KiB, and queries to eight seconds. Available means the OS's complete set (two Mac signals, three Windows/Linux), not an attested physical device. See the repository's `docs/device-identity.md` for sources, normalization, cross-language hash vectors and recovery guidance. `KEYFORGE_DEVICE_SIGNALS=1` enables auto selection in the Node example.

### Existing Windows setup

The core entry point remains framework-independent. In a trusted Node process, opt in with:

```ts
import { createWindowsDeviceSignalsProvider } from "@zdevzone/keyforge-client/windows";
// Add to the existing KeyForgeClient options (keep the same secure storage):
const deviceSignalsProvider = createWindowsDeviceSignalsProvider();
const client = new KeyForgeClient({ serverUrl, productId, publicKeys, storage, deviceSignalsProvider });
await client.register(); // Online registration alone does not grant paid access.
const diagnostics = await client.getDeviceSignalsDiagnostics();
// Existing installations: recollect metadata without registering again.
await client.updateDeviceSignals();
```

Fixed read-only, hidden PowerShell subprocesses collect Windows MachineGuid, SMBIOS UUID and system-volume serial, with no elevation, 8-second execution and 4 KiB output limits per query. CPU IDs, MAC/IP addresses and raw identifiers are never transmitted. Unsupported platforms, missing values, placeholders, timeout and permissions failures return safe per-kind diagnostics, permitting ordinary installation licensing. Diagnostics contain only kind/status codes. Treat hashes as pseudonymous data and explain optional collection to users. A volume serial identifies a filesystem volume, not a unique physical disk.

UUIDs normalize to trimmed lowercase unbraced hyphenated hex. Volume serials normalize to eight lowercase hex digits (optional middle hyphen removed). Zero, repeated and known OEM placeholders are rejected. Scheme v1 hashes each signal separately with SHA-256 over UTF-8 compact JSON: `["keyforge-device-signals",1,canonicalServerUrl,productId,kind,normalizedValue]`. Canonical URL is `new URL(serverUrl).toString()` with a final slash removed; credentials/query/fragment are prohibited. Test vector for `https://licenses.example.test`, `studio`, `machine-guid`, `a1234567-b123-c123-d123-e123456789ab`: `aa7f9a3b0eeee456daced7ae390c08795b46934418950b09e5a7aeb7a0d8127f`.

Initial signals and diagnostics are saved atomically with the registration UUID/body before networking. The saved request is replayed unchanged after interruption/restart; hardware changes never rewrite it. Manual `registration.machineSignals` still take precedence for initial registration. `updateDeviceSignals()` requires the provider and uses the installation-authenticated PUT; no trial consumption, seat, meter, grant or financial state changes. Empty reports clear current availability but retain historical group evidence. Retry the update after network recovery.

Legacy hashes and namespaced hashes do not automatically recognize one another. Authenticated backfill anchors new evidence to the existing installation's group without automatic group merges. A server URL/product change changes the namespace and storage context; coordinate a credential-preserving migration/backfill rather than deleting state. Lost credentials need operator-assisted recovery. Signals can be changed, cloned or forged; they are recognition hints, not physical-device proof. Activation limits still count installations, and matching hardware never automatically transfers/releases seats. Keep production credentials in your application-supplied secure storage adapter; never silently fall back to plaintext files.

## Import accounts and approved recovery

SDK 0.2.0 supports only the clean v1 contract. Use a fresh development server database and secure-state store. Existing deployment signing keys are retained; there is no token/state conversion or old parser. Production deployment is separate. Read [the complete contract](../../docs/import-licensing.md).

- `consumeImport(eventId, units=1)` records one idempotent successful operation and returns its receipt/authorization. Use a UUID durable with the media operation; retries with changed units conflict. Do not charge failed work, duplicates or previews. `getImportUsage()` exposes separate paid/trial/lifetime accounting.
- Import operations require `SecureStorage.compareAndSwap(expectedRevision, nextState)`: expected null means absent state, otherwise compare the integer storageRevision (required) and atomically replace the whole snapshot. Secure the data and implement this across all processes. A normal atomic file rename alone is not CAS. MemoryStorage is test-only.
- Enlist CAS and the media insert in the same application database transaction. If those stores cannot share a transaction, implement a durable reconciled import journal before shipping; do not claim SDK serialization makes independent stores atomic. After storage_conflict, reload and retry the same event ID.
- Remaining paid allowance is the signed cumulative paidImportsGranted minus local paidConsumed. Trial consumption never reduces purchased units. Renewal/top-up add once; refresh, key replacement and recording a receipt add none. Paid conversion permanently forfeits trial. quota_exhausted and recovery_required deny new imports, not access to existing work.
- `exportUsageBackup(passphrase)` returns a separate AES-256-GCM/PBKDF2 encrypted usage snapshot. Use a strong separately retained passphrase and off-device copies; never include it in ordinary configuration exports. It excludes credentials. A valid backup does not prove freshness.
- `markUsageRecoveryRequired()` blocks import use while retaining known evidence. `requestUsageRecovery(licenseId, {encrypted,password})` commits a pending UUID/challenge/candidate before networking; omit backup for lost history. Retry without supplying new backup data, preserving the pending request. A product key does not approve recovery.
- After independent staff approval, `claimUsageRecovery()` verifies both recovery/license signatures, nonce, account, installation, revision/generation and backup commitment, then adopts once atomically. The approval expires after24 hours; stale/expired/rejected cases need an explicit `abandonUsageRecovery()` and a new approval. `verifyRecoveryToken()` is separate from `verifySignedToken()`; a recovery artifact never authorizes paid use by itself.
- Lost-history recovery treats all previous paid allowance as consumed, disables trial and marks lifetime history unknown while preserving surviving known totals. Restore merges maxima and compatible receipts. Neither can reconstruct completely lost local facts or prevent a hostile OS rolling back every local secure record.

Usage receipts grow with lifetime operations. Keep an indexed transactional adapter/backup capacity plan for large deployments; never discard receipt IDs merely to shrink state and then charge old retries again. No raw usage history, password or backup is uploaded; only an optional nonce-salted commitment accompanies a recovery request. Administrator/metering credentials remain absent from the SDK.
