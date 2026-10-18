# Integrate a dependent product or service

Keyforge supplies authorization data. Your application verifies it and enforces your product's features. The open-source server belongs to one company, with an independent catalog, signing keys, installations and licenses for each product.

For JavaScript/TypeScript apps, start with the [client SDK](../packages/keyforge-client/README.md) and [client OpenAPI contract](client-openapi.json). The SDK handles credential creation, registration replay, signed grants and offline authorization; supply a secure storage adapter for your desktop framework. A [bundled AI integration skill](../packages/keyforge-client/skill/keyforge-integrate/SKILL.md) guides coding agents through connecting an existing app. No MCP server is required.

Initial registration, trial onboarding, product-key validation/activation and authorization refresh require internet. Previously authorized use can continue offline until the signed deadline. Skipping key entry grants no paid features: the app must explicitly select a server-authorized trial or remain unlicensed. Registering alone does not select a trial in the SDK.

## Provision the product

An operator creates a product, active entitlement definitions and plans. Obtain its stable product ID and trusted Ed25519 public keys. Ship a pinned trust store in the application. Never ship admin tokens, signing keys, encryption rings or metering credentials to end-user devices.

The initial seeded product has ID `default`; newly created products have their own IDs. Confirm the existing licenses' product with the operator instead of inventing an ID from the app's display name. For a migration, preserve that product and its approved public keys unless an explicit product migration is planned. The token issuer `default` is a separate fixed contract field and does not identify the licensed product. A safe integration handoff contains the server origin, product ID, `kid`-to-public-PEM trust map, token versions and links to this guide/OpenAPI. It contains no customer key or server administration credential.

A plan name is a label; only its copied typed entitlement values grant features. For example, define `seats:number`, `export:boolean` and `tier:string`. Your code decides what each means. Server-side meters can enforce selected nonnegative integer numeric quotas for trusted backends.

## Registration and identity

For optional Windows/Linux/macOS collection, use `createDeviceSignalsProvider()` from `@zdevzone/keyforge-client/device-signals` in a trusted Node process; see [desktop identity and language support](device-identity.md). The official SDK is JS/TS, while HTTPS/OpenAPI works from any language. Native clients must implement secure storage, exact registration replay and signed offline verification themselves; generating an HTTP client does not supply those pieces.

Windows apps can opt in to the Node-only [`@zdevzone/keyforge-client/windows` adapter](windows-device-identity.md) through `deviceSignalsProvider`. It supplies scoped hashes and safe diagnostics; partial or missing signals never replace installation credentials. Existing authenticated installations use `updateDeviceSignals()` for recognition-only backfill. Legacy signals remain supported, but cross-scheme recognition requires backfill. See the linked contract for normalization, test vectors, limits, privacy and recovery guidance.

Generate and persist an installation ID and an independent random 256-bit base64url credential in secure application storage. Generate a UUID request ID and persist it with the registration body until the request succeeds.

```http
POST /v1/products/photos/register
Authorization: Bearer <installation-credential>
Content-Type: application/json

{"installationId":"install-123","requestId":"550e8400-e29b-41d4-a716-446655440000","appVersion":"1.0","platform":"linux"}
```

The first registration pins the credential hash. Later calls must prove the same identity; an installation ID alone is not authentication. Exact retries reuse the same body/request ID and return the saved response. Reusing an ID with different content returns 409.

Optional `machineSignals` are scoped SHA-256 hashes with kinds `machine-guid`, `smbios-uuid`, `volume-serial`, `linux-machine-id`, `macos-platform-uuid` and `root-volume-uuid`; send at most three current signals and never raw hardware identifiers. Follow the [normalization and hashing contract](device-identity.md). Two agreeing distinct kinds are required for machine matching; common identifiers are excluded from evidence. Signals are anti-abuse hints that a modified client can forge, not proof of physical identity. A matching machine is spent after its first trial registration; support can clear it for one additional registration. When trial policy is enabled, registration returns a signed trial v2 token. Persist the first valid grant; do not manufacture a new trial on refresh or reinstall.

Old migrated installation IDs have no credential and cannot be claimed. Use a new ID. Lost credentials require a new registration and operator-assisted seat recovery.

## License flow

All calls below use the installation credential as Bearer authorization:

| Action | Route suffix | JSON body |
| --- | --- | --- |
| Inspect a key before activation | /validate | installationId, key |
| Claim a seat | /activate | installationId, key |
| Get current authorization | /refresh | installationId, licenseId |
| Release this seat | /deactivate | installationId, licenseId |

Prefix each route with `/v1/products/<productId>`. Activation returns `token` and `serverTime`. Store the signed token atomically; avoid logging it or the product key. Refresh only works for an existing active binding. Validate consumes no seat and its unsigned JSON is not an offline license.

An expired or revoked bound license returns a signed negative status from refresh with HTTP 200. Inspect the verified token status, not only the response code. Released bindings return `not_activated_here`. Seats are serialized across server processes, preventing concurrent oversubscription.

## Offline enforcement

License tokens are `base64url(JSON).base64url(Ed25519 signature)`, version 4; they are not JWTs. Verify the signature over the decoded UTF-8 JSON bytes of the first segment, then validate the complete payload. Reject unknown versions/kids, product or issuer mismatch, wrong installation/subject, non-active status, passed expiry or offline deadline, invalid types and implausible future issuance.

A usable grant requires all checks; its expiry deadline is the earlier of `expiresAt` (if present) and `offlineGraceUntil`. Refresh ahead of that deadline and retry transient failures with bounded exponential backoff and jitter. Never convert a failed response into an unsigned grant. Offline revocation cannot be immediate: a previously signed token can remain usable until its deadline. Use a shorter grace policy when that tradeoff matters.

See [verification](verify-token.md) for the full contract. Keep cumulative consumption separate from refreshed entitlement ceilings; a refresh does not reset usage. Client-local offline counters are mutable by the user and cannot provide authoritative billing.

## Support

With the installation credential, submit to `/v1/products/<productId>/installations/<installationId>/support`. Technical, feature and other categories require an active license binding. Licensing and billing cases may use an existing expired or released binding. A trial-only installation cannot create a case. Use a UUID `requestId` and `Idempotency-Key` header with that same value; persist them across retries.

```json
{"requestId":"550e8400-e29b-41d4-a716-446655440001","licenseId":"<license-id>","category":"technical","urgency":"normal","subject":"Export fails","message":"Steps and expected behavior","createdAt":"2026-10-12T09:00:00.000Z","reporter":{"name":"Ada"},"app":{"version":"1.0","platform":"linux"}}
```

GET that collection or `/<ticketId>` to retrieve your installation's cases and public replies. POST `/<ticketId>/messages` with `requestId`, the current integer `revision`, and `message` to reply. Preserve the same request on retries; if the revision conflicts, retrieve the thread and reconcile before submitting again. Operator assignment and internal notes are not returned. Closed cases require a new case; a customer reply can reopen a resolved case. No email delivery or attachment upload is provided. Customer thread and notification collections currently return all matching records; render pagination locally where needed.

## Trusted-backend metering

Admins define a meter linked to an active numeric entitlement with a lifetime, UTC daily or UTC monthly period, then create a product-scoped service credential with `usage:read` and/or `usage:consume`. Store it on your backend only.

POST `/v1/products/<productId>/usage/summary` with `licenseId,meterId`, or `/usage/consume` with those fields plus a UUID `eventId` and positive integer `units`. Authorization is the service credential. Consumption atomically checks the active license and quota, records units, and returns consumed/quota/remaining. Reuse an event ID and identical units for retries. Events remain idempotent across period boundaries; a reused event ID with other units conflicts.

For SaaS, a service subject still uses a credential-bearing registered service instance and seat binding. Customer identity, billing, subscriptions, billing webhooks and your own authorization layer remain your application's responsibility.

## Preinstallation requests and license delivery

Customers can use the server's `/request-license` page before installing. See [License requests and sales](license-sales.md). A private fragment-bearing status link authorizes request status and key collection without an operator session. Do not put its credential in logs, query strings or analytics.

Installed apps continue polling `GET /v1/products/:productId/installations/:installationId/notifications` using the installation bearer credential. A `kind=license` item contains `licenseId`, `deliveryStatus` and `collectPath`, never the key. POST `collectPath` using the same credential to receive `{key,license}`. Display failures and allow retry; collection is safe to repeat. Pass the returned key to the existing activation API. Retrieving a key never activates the license or changes seat limits. Existing registration, activation, validation, signing and support-reply contracts are unchanged.
