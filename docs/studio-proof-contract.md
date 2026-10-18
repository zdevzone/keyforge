# Studio Proof integration contract review

Reviewed **2026-10-18** against running production and its source commit **`a75fb8db6485ea2bacbe8831537feeeb1d8f31ad`**. This is an assessment of the questionnaire, not approval to change quotas, create customer licenses, reset usage or issue recovery authorizations. Production was inspected using read-only requests. No customer identifiers, license keys or financial entries are included here.

## Verified deployment and evidence

Every item labelled confirmed by Studio Proof was independently rechecked:

| Setting | Verified value |
| --- | --- |
| Origin | `https://keyforge.1hubengineering.com` |
| Product | `default`, currently named `Keyforge`; the only product observed |
| Issuer | Literal `default`, independent of the product ID |
| Token versions | License **4**, trial **2**; `/healthz` advertises only these versions |
| Active key ID | `key-a9d7d15deea7be3e` |
| SHA-256 of DER SPKI | `a9d7d15deea7be3e7dfb7189096617363d0e31cf80881bb37f293de9e415813e` |
| Offline grace | 30 days for newly minted paid-license tokens |
| Trial | Enabled, allowance **20,000**, duration **null** |

The public PEM matches the previously supplied `studio-proof.json`. There is no separately configured Studio Proof product. This does **not** establish that all records under the generic product belong to Studio Proof, or that `default` must remain the long-term product choice. Confirm ownership before moving existing customer licenses.

Immutable evidence: [deployed HTTP implementation](https://github.com/zdevzone/keyforge/blob/a75fb8db6485ea2bacbe8831537feeeb1d8f31ad/src/platform.ts), [delivery](https://github.com/zdevzone/keyforge/blob/a75fb8db6485ea2bacbe8831537feeeb1d8f31ad/src/license-delivery.ts), [notifications](https://github.com/zdevzone/keyforge/blob/a75fb8db6485ea2bacbe8831537feeeb1d8f31ad/src/notifications.ts), [token schemas](https://github.com/zdevzone/keyforge/blob/a75fb8db6485ea2bacbe8831537feeeb1d8f31ad/src/token-contract.ts), [SDK evaluator](https://github.com/zdevzone/keyforge/blob/a75fb8db6485ea2bacbe8831537feeeb1d8f31ad/packages/keyforge-client/src/client.ts), and [original deployed OpenAPI](https://github.com/zdevzone/keyforge/blob/a75fb8db6485ea2bacbe8831537feeeb1d8f31ad/docs/client-openapi.json).

The original OpenAPI has documentation gaps: untyped metadata, omitted health route and optional customer `internal:false`, and overly restrictive registration-signal/core-operation descriptions. These are corrected in the current [client OpenAPI](client-openapi.json), without changing runtime behavior. The [frozen review package](examples/studio-proof-contract/manifest.json) includes its own corrected OpenAPI, token JSON Schemas, checksums, public policy snapshot and test-only signed vectors. The manifest identifies the runtime source commit; check out the commit containing this review to reproduce its artifacts. This is a client contract, **not** an exhaustive administrator OpenAPI. Cross-field equality, trimming, replay and authorization rules below remain necessary beyond JSON Schema.

Studio Proof's local Rust enforcement, keeping existing content accessible, monotonic lifetime usage, and excluding secrets/identity/usage from configuration export are appropriate **application responsibilities**. KeyForge does not implement or certify those local behaviors. There is no Rust SDK; implement HTTPS plus the verified token contract directly, without adding Node solely for REST.

## Common wire rules

Use HTTPS to the configured origin, JSON request bodies (`Content-Type: application/json`) and `Authorization: Bearer <credential>`. Credential examples must be generated locally, not copied from documentation. No cookies or administrator token belong in device requests. Public health, metadata, key discovery and request catalog need no authentication. Installation and private-request credentials are distinct. URL-encode path IDs; reject redirects when sending credentials. There are no undocumented query parameters required for these client routes.

Unless stated otherwise, object inputs are strict: unknown fields cause `400 bad_request`; omission is allowed only for optional/defaulted fields; explicit null, zero, false, arrays and objects are invalid for string fields. Empty strings are allowed only where noted. Successful bodies are JSON **objects**, never bare grants or arrays. Normal success is 200; support/request submission is 202; administrator issuance is 201, including replay. Framework/proxy errors may have different envelopes or non-JSON bodies; do not authorize from them.

| Shared type | Actual rule |
| --- | --- |
| Installation ID in HTTP bodies | Trimmed string, 1–200 characters; **UUID is recommended, not required by the server**. SDK stored identities are UUIDs. |
| Request IDs | Zod `string().uuid()`; generate a standard random UUID v4 and persist it before sending. No undocumented ULID assumption. |
| Product ID | Configured lowercase slug, creation pattern `^[a-z][a-z0-9-]{0,59}$`. Unknown route product gives 404. |
| Credential | Generate 32 cryptographically random bytes, encode unpadded base64url (43 characters). Registration accepts `[A-Za-z0-9_-]{43,128}`; padding/whitespace rejected. The server cannot measure entropy and does not prove canonical base64 decoding. |
| Product key | Nonempty string; lookup hashes its trimmed uppercase form. Never log the input or response key. |
| Timestamp | Token/administrative timestamps use Zod offset-aware datetime validation; server emits UTC ISO strings. Support submission additionally normalizes its ISO timestamp with seconds and timezone to UTC. |
| Entitlements | Map, keys 1–64 characters, values finite JSON numbers, strings or booleans. No nulls, arrays or nested objects. Zero/false/empty-string values are structurally permitted, not implied authorization. |

## Core lifecycle (CORE-1–7)

Here `P=/v1/products/default`. All five POST routes require a registered installation credential. Nothing registers implicitly on the server; SDK `activate`/`validate` first perform explicit registration for you.

| Operation | Canonical body | Success and effects |
| --- | --- | --- |
| `POST P/register` | `installationId`, UUID `requestId`; optional metadata below | `{ok:true,recorded:boolean,serverTime,trial:null|{token:string}}`; pins credential and stores replay/trial decision atomically. |
| `POST P/validate` | `installationId,key` | `{valid:true,...safeLicense,seatsInUse,seatsAvailable,serverTime}`; **no seat and no signed offline grant**. A full license can still validate with `seatsAvailable:0`. Invalid/negative keys return errors, not `{valid:false}`. |
| `POST P/activate` | `installationId,key` | `{token,serverTime}`; binds this license/installation once. A repeated active binding succeeds even when all seats are occupied. |
| `POST P/refresh` | `installationId,licenseId` | `{token,serverTime}` for a retained active binding; token status can be **revoked/expired with HTTP 200**. |
| `POST P/deactivate` | `installationId,licenseId` | `{ok:true,serverTime}`; releases the selected license's binding. Existing license plus already released/missing binding also succeeds. |

Runtime accepts optional `key` and `licenseId` on **all four** post-registration operations, with key taking precedence. Missing both yields `unknown_license`; activation still requires a key. Use the canonical bodies above rather than depending on this permissiveness. `maxTokenVersion`, arbitrary issuance terms and other extras are rejected. Old unscoped routes are **unsupported**, with no negotiated compatibility window; do not treat SPA HTML fallback as an API response.

Activation decisions are serialized across processes using database transactions/workspace locks. Retries of the same key/installation reuse one binding; the minted token/time can change. Concurrent distinct licenses can each bind the same installation: **replacement does not release the old license**. `installation.licenseId` is a convenience pointer, not an exclusive binding. Explicitly release the old seat when appropriate. A failed replacement attempt leaves the existing SDK grant unchanged; do not discard it solely because an unrelated candidate key failed. Successful replacement must verify and atomically persist before use, and must not reset local usage.

| Refresh outcome | Result / cached authorization |
| --- | --- |
| Active bound license | Verify and save new grant; enforce signed expiry and grace. |
| Expired or revoked, binding retained | 200 signed negative token; **persist and supersede old active grant**. |
| Released or never bound | 403 `not_activated_here`; SDK saves denial and blocks fallback. |
| Unknown license/product | 404 `unknown_license` / `unknown_product`; SDK refresh saves denial. |
| Archived product | 410 `product_archived`; SDK refresh saves denial. |
| Another license activated | Old binding remains refreshable until separately released/revoked/expired. There is no signed “replaced” status. |

After a lost deactivation response, retry the same identity/license. On success clear the local paid grant and deselect trial atomically; preserve usage. If the application cannot persist success, block protected mutations until reconciled. Do not create a new identity to repair an ambiguous operation.

## Registration and recognition (AUTH-1–7, DEVICE-1–3)

Optional registration fields: `appVersion` max50, `platform` max100, `userName`/`userEmail` max200, all strings defaulting to `""`. Empty permitted, null rejected; userEmail is not email-format validated here. Omit them for privacy. Registry-disabled operation still persists credential, replay and machine/trial security records, but returns `recorded:false` and suppresses registry metadata; this is **not** a grant or a registration failure. User name/email retention additionally requires `registry.collectUserInfo`. Trials depend on product policy and machine evidence, not the presence of contact details. `trial:null` means product trial disabled; a disabled registry does not disable registration or trials.

Registration replay key is product + installation + request UUID. The fingerprint is SHA-256 of **JSON.stringify of the parsed/defaulted object**, not raw HTTP bytes. Top-level schema order/defaults are normalized; `machineSignals` is retained as supplied in the fingerprint, so array order and nested raw JSON differences can conflict. Missing metadata and explicit empty strings normalize alike. Credential must still match. Same ID/body returns the original complete response/token; changed parsed body gives 409 `idempotency_conflict`. Records have no automatic replay TTL. Preserve the original body even if version/user/hardware changes while pending. A new UUID is a new registration decision, not a safe way to renew a trial.

The credential is stored as a hash scoped to product/installation. The SDK also pins deployment URL and subject kind in secure state, but the server credential itself is **not cryptographically bound to URL, hardware or subject kind**. Copying valid identity+credential+grant to another machine is not prevented by hardware hints. Credential rotation/recovery under the same identity is **unsupported**. Restore a trusted atomic secure-state backup, or have staff release old seats and register a new identity with explicit migration. Keep surviving local usage linked to the new remote identity. Do not silently erase corrupt/context-mismatched state or register a new identity after storage errors.

`PUT P/installations/{installationId}/device-signals` requires that installation's credential. Strict body `{machineSignals:[{kind,hash}]}`; required array, max3, empty permitted; each item strict, kind one of `machine-guid`, `smbios-uuid`, `volume-serial`, `linux-machine-id`, `macos-platform-uuid`, `root-volume-uuid`, hash exactly 64 lowercase hex characters. Null/malformed values reject. Legacy registration is more permissive: any JSON `machineSignals` is accepted, valid pairs normalized, malformed/unknown entries dropped, identical kind/hash pairs deduplicated, with no server-side three-entry bound on that registration field. SDK limits it to three. Backfill stores the current list and unions normalized evidence into the authenticated identity's existing groups. It never matches/merges other groups; empty clears current availability while retaining history. Duplicate pairs are not a unique physical-device assertion.

New native installations should implement the existing **v1 namespaced hash**, not a bespoke CPU fingerprint. [Device identity](device-identity.md#shared-v1-normalization-and-hashing) and [Windows vectors](windows-device-identity.md) give normalization/placeholders and reproducible Rust-compatible vectors. Hash compact UTF-8 JSON `["keyforge-device-signals",1,canonicalServerUrl,productId,kind,normalizedIdentifier]` with SHA-256. Canonicalization must match the documented URL serialization. Send no raw IDs. Permission failure/hardware replacement yields partial/empty diagnostics; continue installation-based operation. Preserve old credentials/usage, backfill rather than re-register. Cross-scheme or cross-origin recognition is not automatic. New-registration recognition needs two distinct matching kinds, discards overly common evidence and chooses the oldest best match without merging. Hints can influence trial recognition but never authenticate, transfer/free seats or reset usage.

## Signed payloads and trust (TOKEN-1–6)

Complete strict JSON Schemas are in the frozen package. All token fields are required, including nullable fields. License `subject` has only `kind:"installation"|"service"` and `id` (1–200 string); `subject.id` must equal `installationId` in addition to schema checks. Rust desktop clients must require `kind:"installation"` and match the expected ID/product/issuer. Trial has no subject object. `issuedTo` is an unbounded string in the token schema, not necessarily nonempty. Trial allowance is nullable nonnegative integer (Zod safe-integer range), independent of paid entitlements; `supportReference` is nullable string. Trial v2 has no `offlineGraceUntil`.

Signature is Ed25519 over **decoded JSON UTF-8 bytes**, not the encoded segment or reserialized JSON. SDK requires exactly two canonical unpadded base64url segments, a 64-byte signature, valid UTF-8 and total token length at most65,536 characters. JSON Schema cannot encode signature verification or subject-ID equality. JSON numbers must be finite; native clients should reject quota numbers outside their agreed safe-integer policy. The current JS parser uses JSON.parse: **duplicate property names are last-wins, not explicitly rejected**. New server tokens never deliberately contain duplicate keys. A native verifier can reject duplicates conservatively; do not claim this rejection is already implemented in the SDK.

Verification authenticates signature, strict shape, approved key, context and issuance time. It can return an authentic **negative** grant. Import authorization must additionally enforce status, expiry, offline deadline and Studio Proof's quota/integrity policy. Current SDK tolerance is 300,000ms for future issuance and rollback detection; it **never extends expiry/grace**. At equality with a deadline, authorization ends. Persist max(local time, signed issuedAt) and refuse when clock+tolerance is below prior maximum. Unsigned response `serverTime` must not advance trusted time. This is not a secure clock or resistance to a compromised host.

Stage key → authenticate/distribute new public trust to clients → activate key → retain retired trust for previously signed grants. Discovery exposes optional `pending` plus `kid/publicKeyPem/retiredAt` and `serverTime`; it does not establish trust. There is no signed compromised-key feed or immediate offline revocation. Remove compromised trust via authenticated application update/policy with an explicit offline impact decision. Unknown kid means reconnect/update trust, never fetch-and-trust. Legacy token versions/missing context are **unsupported by the current SDK**. There is no built-in grandfather policy; any temporary legacy verifier requires an explicit separately reviewed migration policy.

## Product-policy snapshot and unresolved quotas (QUOTA-1–7)

Read-only production catalog snapshot at review time:

| Definition / plan | Exact configured values |
| --- | --- |
| `imports` definition, revision2 | type `number`, default10000, minimum1000, maximum100000, active; description “this would limit the number of import a person could perform” |
| `standard`, revision2 | `{imports:20000}`, duration32 days, activationLimit1, active, price50000 santim = **ETB500.00** |
| `standard-plus`, revision1 | `{imports:50000}`, duration90 days, activationLimit1, active, price100000 santim = **ETB1,000.00** |

These are plan templates, **not disclosure of customer license snapshots**. Existing licenses can have different copied terms. Definition defaults are not automatically injected into absent license entitlements. Bounds/type validation do not establish integral lifetime-count semantics: the number definition currently accepts fractional values within bounds. The server signs terms; it does not count Studio Proof imports or know photographs/videos/duplicates/deletions. A trial's 20,000 units are not intrinsically “imports” until application policy maps them.

**QUOTA-2–6 require a product-owner decision.** Recommended contract for the stated requirement is a safe-integer **lifetime cumulative ceiling**, a monotonic local counter, both time and quota checks for hybrid grants, and explicit separately typed unlimited policy. Do not implement this recommendation as an already agreed server rule. Define the unit, successful-import commit point, duplicate/retry deduplication, deleted-media treatment, trial-to-paid accounting, top-ups and downgrade behavior first. Missing/wrongly typed/negative/fractional/out-of-range quota should fail closed for new imports; zero is exhausted, and missing must never silently mean unlimited. Existing catalog minimum1000 prohibits newly configured zero paid grants; generic token structure still permits zero.

Illustrations **only if the owner adopts a lifetime ceiling**: at12,000 total usage, ceiling50,000 leaves38,000. Same-plan renewal or replacement with the same ceiling leaves38,000, not50,000. An extra10,000 purchase must explicitly raise signed ceiling to60,000, leaving48,000; reusing50,000 does not add units. Downgrade to10,000 blocks new imports without reducing12,000 used. Trial-to-paid retains12,000 and leaves38,000 against50,000. A hybrid expired grant blocks imports even with quota left. There is no current top-up/recovery endpoint that performs these application-specific decisions.

No vendor metering credential or per-import network call is required by desktop activation. `/usage/summary` and `/usage/consume` use separate trusted-backend credentials; they cannot enforce purely local offline lifetime history. Never distribute these credentials. Paid authorization evaluation in the SDK returns entitlements without consuming them; SDK `trialConsumed` is a trial-only counter, **not** Studio Proof's complete lifetime ledger.

## Trials, renewal and offline use (TRIAL-1–6, RENEW-1–4, OFFLINE-1–3)

Fresh = first recognized registration or exactly one registration after a staff clear. Spent = previously recognized group; signed allowance is then0. Fresh allowance0 is exhausted; null allowance means no numeric trial cap, requiring the duration policy. Null expiry means no time deadline. Current quota-only fresh grant20,000/null-expiry has no paid-grace refresh deadline; enforce persisted local consumption. `trial:null` supplies no trial authorization. Never replace a signed spent/unusable trial with a local fresh trial. If neither paid grant nor explicitly selected usable trial exists, remain unlicensed for protected imports.

Staff `POST /admin/products/default/machines/{machineId}/clear` records `clearedAtCount` and audit. Next **new request UUID** registration for that authenticated identity re-evaluates eligibility; old registration replay returns the old decision. Retain body/UUID for each pending registration until resolved. SDK `register()` short-circuits once registered and `startTrial()` replays its old body without adopting a new decision; **no SDK trial-reconsideration method is supplied**. A native implementation may perform a deliberate new registration after staff approval while preserving credentials and usage. Do not reset `trialConsumed` or the lifetime ledger. Staff clear is eligibility metadata, not a signed recovery grant. There is no dedicated durable signed registration witness when trials are disabled; do not repurpose an expiring/spent trial as a new witness protocol.

The server does not define whether trial can resume after paid expiry/revocation/release. SDK keeps trial data across paid use, prioritizes any paid token even when negative/expired, and deactivation clears paid state and deselects trial. An explicit later startTrial can select the retained still-usable trial; there is no irrevocable paid-conversion lockout. **Choose and implement Studio Proof's resume policy explicitly** without reducing usage.

Renewal alternatives: admin PATCH existing license expiry/entitlements with optimistic revision, then refresh its binding; or issue a new plan-based license, deliver/activate the new key, and explicitly release old binding. Plan edits do not rewrite licenses or immutable sales. PATCH changes neither plan ID nor payment history and does not automatically record a renewal sale; use the separate staff finance renewal workflow if appropriate. A new license creates its own initial sale. Refresh cannot discover a replacement ID; use delivery/explicit key entry.

**Signed revision and total ordering are unsupported in v4.** Administrative record `revision` is not signed. SDK rejects earlier issuedAt for the same license and equal-time active grants replacing a cached negative grant. Equal timestamps with different active terms, concurrent processes, different license IDs and re-presented old keys are not totally ordered. Serialize native operations, correlate requests and persist negative outcomes, but do not claim these solve cryptographic rollback. If that guarantee is required, agree a versioned signed revision protocol and migrate verifiers before use; do not add bespoke fields to strict v4 or overload generic entitlements as a security revision.

Refresh well before grace expires, at app startup/resume and periodically online (for example daily with jitter). Scheduling is application policy; the SDK has no background scheduler. Use earlier of expiry and offlineGraceUntil for paid licenses, with no extension on network error. Offline revocation is only learned on reconnection or expiry of cached bounds. After clock correction, re-evaluate retained time/deadlines; never roll back a persisted clock maximum just to restore access. Server backup restoration can resurrect historical policy/bindings; client durable negative/high-water state must survive, and there is no signed restore epoch.

## Recovery and migration (RECOVERY-1–5, MIGRATION-1–6)

**Recovery-specific signed usage authorization, one-time recovery adoption, signed usage baselines and a signed recovery/reference/revision schema are unsupported.** No existing endpoint can issue such an artifact. Ordinary license keys authorize normal activation only, never bypass local usage-integrity checks. A machine support reference is a lookup aid, not a secret or recovery credential. Explicit contract decision for the current version: reject bespoke recovery claims in v4 and keep usage recovery fail-closed. A separate versioned signed artifact is a future design requiring owner approval and server/client work; it is not delivered by this documentation change.

| Local migration/recovery situation | Supported safe handling / remaining boundary |
| --- | --- |
| One verified history survives | Preserve it and its maximum count; repair redundant storage atomically under Studio Proof's own integrity rules. |
| Histories conflict | Preserve evidence and any known high-water mark; block new imports pending explicit local/staff reconciliation. Do not choose the smallest count. |
| Credentials survive, usage unverifiable | Existing license does not authorize resetting history. Keep read access; import recovery is unresolved/unsupported. |
| Usage survives, credentials lost | Preserve local usage identity; staff releases old seats; register new remote identity and explicitly associate it with surviving usage. No hardware-based credential recovery. |
| Nothing trustworthy survives | No supported zero-reset or signed baseline-recovery shortcut. Requires a new approved recovery protocol/policy. |
| Old ID has no credential | It cannot be claimed: register a new ID/credential and use operator-assisted release/reissue. Preserve old usage separately. |
| Historical key available | Re-enter it through registered product-scoped activation, subject to current status/seats. Hash-only originals cannot be reconstructed. |
| Original unavailable | Admin may reveal an encrypted retained original, or explicitly reissue; reissue has financial side effects and needs staff decision. |

Production has aggregate catalog usage, but the generic product contains no trustworthy Studio Proof provenance tag. **MIGRATION-3 cannot be answered by naming all `default` records as Studio Proof**. Have the owner reconcile provenance privately; no customer rows were exported for this review. Hardware replacement alone does not require a new identity if secure state survives. Reinstall/app-data loss/restore must not erase known usage or silently claim a new trial. Stage migration with atomic checkpoints, retain trusted original state for rollback, verify token formats before switching, and never downgrade to a client that ignores negative grants/new identities or resets usage. Legacy offline grandfathering and protected-usage recovery remain explicit blockers, not implemented guarantees.

## Support transport (SUPPORT-1–6)

Let `I=P/installations/{installationId}`. All routes require that installation's credential. No filters or pagination apply to customer GET collections; records are ordered by record ID, not guaranteed chronologically. Paginate/render locally and sort by timestamps if needed.

| Route | Input / output |
| --- | --- |
| `POST I/support` | Strict `requestId` UUID, `licenseId` string validated after trim (1–200; send it without surrounding whitespace because lookup uses the original value), category, urgency, subject, message, createdAt; optional strict `reporter:{name?}` and `app:{version?,platform?}`. Require `Idempotency-Key` **equal to requestId**. Returns202 `{request:{id,clientRequestId,status,receivedAt},serverTime}`. |
| `GET I/support` | `{requests:[Thread...]}`; this installation only. |
| `GET I/support/{id}` | `{request:Thread}`; nonexistent/other-installation ticket gives404 `unknown_support_request`. |
| `POST I/support/{id}/messages` | Strict UUID `requestId`, integer current `revision`, trimmed message1–5000, optional `internal:false` defaultfalse. `true` rejected for customers. Returns `{request:Thread}`. No Idempotency-Key header is required here. |

Category enum: `technical`, `licensing`, `billing`, `feature_request`, `other`. Urgency: `low`, `normal`, `high`, `critical`. Trimmed initial subject3–120 and message10–5000; initial createdAt must have ISO date, seconds and `Z`/offset (fraction optional1–9 digits) and parse as a date; normalized UTC persisted. Optional reporter.name max200, app.version max50/platform max100 before trimming; missing/empty/whitespace → null, explicit null rejected. Subject/message/createdAt required, no null. Input schema plus normalization both apply.

Thread fields: `id`, integer `revision`, licenseId, installationId, clientRequestId, category, urgency, subject, original message, nullable reporterName/appVersion/platform, clientCreatedAt/receivedAt/updatedAt, status, messages array. States `queued|in_progress|waiting_customer|resolved|closed`. Each public message `{id,author:"customer"|"support",body,internal:false,createdAt}`; array is insertion order. Assignment is omitted, internal notes filtered, operator author identities mapped to support. Current new ticket IDs are `srv_`+UUID; historical imports may differ (old helper produced prefixed ULID). **Treat IDs as opaque**.

Creation requires an existing license **and binding** for the installation. Technical/feature_request/other additionally require active license and unreleased binding. Licensing/billing accept expired/revoked/released bindings. Trial-only/never-bound installations cannot create tickets; customer GET/reply authenticate ownership without rechecking license status. An unbound user needs the operator's separately advertised external contact; KeyForge supplies no public help/email endpoint.

Creation replay compares normalized category/urgency/subject/message/reporter/app/timestamp scoped to license+installation+requestId. Changed body gives409 `idempotency_conflict`. **Eligibility is checked before replay**, so a later binding/status change can prevent replay acknowledgment; retain outbox and reconcile, do not rewrite the queued identity to a new license silently. Reply replay finds requestId among messages; same body/internal/author returns current thread before stale revision/closed checks. New replies require current revision (409 `revision_conflict`); GET/reconcile before a deliberate revised retry. Closed gives409 `request_closed`; resolved/waiting_customer customer replies reopen queued. Durable outbox must retain original identity/body and distinguish acceptance from staff response.

Configured creation quota defaults10 per hour per license+installation based on stored tickets, 429 `support_rate_limited`; this domain error does not supply Retry-After. No automatic ticket TTL, attachments, email delivery or realtime transport. Poll for retrieval with bounded backoff. HTTP202 means stored, not delivered to a staff email or resolved.

## Notifications, delivery and preinstallation requests (DELIVERY-1–5)

| Route | Strict body / success |
| --- | --- |
| `GET I/notifications` | No body/filter/pagination; `{items:[Notification...],preferences:{messages:boolean,expirations:boolean}}`. Both defaults true. |
| `PUT I/notifications/preferences` | Required booleans messages/expirations (false accepted, null/omission rejected); `{ok:true}`. License deliveries always included. |
| `POST I/notifications/read` | `eventId` string1–500, `{ok:true}`. Repeated marker idempotent in effect, updates timestamp. |
| `POST I/licenses/{id}/collect` | No required JSON body; `{key:string,license:{id,plan,issuedTo,expiresAt:string|null}}`; no seat consumed and no automatic activation. |

Notification required fields: `id,kind,title,date,read`. Reply adds ticketId; expiration adds licenseId; license delivery adds licenseId/deliveryStatus/collectPath. kind is `reply|expiration|license`; deliveryStatus `available|retrieved|manual|failed`. IDs: `reply:<messageId>`, `license:<licenseId>`, expiry includes licenseId+expiry+threshold1/7/30. Feed contains latest public staff reply **per thread**, deliveries, and current pointed license's upcoming expiration. It is not an immutable event archive; notices can disappear as source state changes. No fixed retention/polling/collection-size guarantee; read markers have no TTL. No stable chronological feed order promised.

Collection requires exact targeted installation; wrong recipient/missing delivery404 `delivery_unavailable`, inactive/missing license409 `delivery_unavailable`, decryption failure503 `delivery_failed`. Repeat collection returns same retained key and preserves first retrievedAt; fixes can permit retry of failed delivery. Prefer explicit user confirmation before replacing an existing key/grant; collection alone is not consent to replace. Server builds a relative same-origin collectPath. Native clients should construct the path from validated IDs (as SDK does), never forward credentials to an arbitrary supplied URL.

Preinstallation requests are enabled in this deployment (public catalog verified). They use a **different** 32-byte random secret, same accepted43–128 base64url character pattern, and a private status URL fragment; send that secret as Bearer, never querystring or installation credential.

| Route | Contract |
| --- | --- |
| `GET /v1/license-request-catalog` | No auth/query; `{products:[{id,name,plans:[{id,description}]}]}`; active products/plans only. |
| `POST /v1/license-requests` | Strict UUID id, productId string1–60, plan1–200, trimmed name1–100, email valid format/max254. All required, null/zero/false invalid. Secret Bearer; no Idempotency-Key header required.202 `{id,status:"requested"}`, even replay after issuance; GET status for current state. |
| `GET /v1/license-requests/{id}` | Secret Bearer; `{request:{id,productId,plan,name,email,status,licenseId,createdAt,revision},delivery:Delivery|null}`. Status requested/issued; licenseId nullable. Secret hash omitted. |
| `POST /v1/license-requests/{id}/collect` | Same secret, no required body;409 `request_pending` before issuance, otherwise collected model above. |

Delivery includes id/licenseId, nullable installationId/requestId, status, createdAt, nullable retrievedAt/error, and persisted revision where read from store. Exact ID/body/secret replay works; changes409 `idempotency_conflict`. Invalid/missing secret404 `request_not_found` on retrieval,400 `invalid_request_secret` on submission. Inactive/unknown plan400 `unknown_plan`, unknown product404. Submission limit10/hour/IP. No request-secret expiration, rotation, recovery or email status delivery; preserve private link securely. Contact data remains server-side for staff handling; do not log/share fragments or embed the private request object in analytics.

## Staff-only contract (ADMIN-1–6)

Never ship this domain in Studio Proof desktop. Staff automation may use configured admin Bearer (actor `cli`); console sessions use Better Auth cookies. Admin-token absence disables bearer administration. Invalid credential401 `admin_unauthorized`, disabled administration503 `admin_disabled`. Session non-GET writes reject an explicitly different Origin (403 `invalid_origin`); omission is accepted, not a mandatory Origin header. Financial/license mutations and key reveal require admin; support can read **safe** catalogs/licenses/activations and release seats/clear trials. All operators belong to one workspace, without per-product membership isolation.

Here `A=/admin/products/default`:

| Endpoint | Exact applicable contract |
| --- | --- |
| `GET A/catalog` | Product, definitions, plans, planUsage, usage, licensesScanned, keyStorageEnabled. Prices in plans exposed to admins only. Definition/plan types are in pinned platform source; snapshot above lists actual terms. |
| `GET A/licenses` | Optional status filter raw equality; `q` case-insensitive JSON substring, limit default25 clamped1–200, offset default0. Use nonnegative integers. `{licenses:[safeLicense],total,counts:{active,expired,revoked}}`; counts precede filters. Order by record ID, not issuance date. |
| `GET A/licenses/{id}` | `{license:safeLicense}`,404 unknown_license. |
| `POST A/licenses` | See issuance below; admin only,201 license/key/sale/delivery. |
| `PATCH A/licenses/{id}` | Strict required integer revision; optional issuedTo string/max200 (empty permitted), entitlements map, activationLimit positive integer, expiresAt datetime or null. Omitted terms unchanged; null expiry perpetual.409 revision_conflict,400 bad_entitlements; `{license:safeLicense}`. No plan/status/price override. |
| `POST A/licenses/{id}/revoke` | No parsed body required, admin only; `{ok:true}`. Repeated revocation updates timestamp/revision/audit; current tokens remain valid offline until bounded. |
| `GET A/licenses/{id}/activations` | `{activations:[{id,licenseId,installationId,activatedAt,deactivatedAt,revision,machineGroups,signalKinds,signalAvailability}]}`. Released deactivatedAt is string, active null. No pagination; a nonexistent license can yield empty array. |
| `POST A/licenses/{id}/deactivate` | Required `{installationId}` trimmed1–200; this handler ignores other body properties rather than parsing a strict object. Support/admin allowed. `{ok:true}`, repeated or missing binding succeeds. Does not create license or sale. |
| `POST A/licenses/{id}/key` | Admin only; session requires **`password`**, bearer CLI bypasses password. Optional `key` string lets staff store a supplied matching historical original (normalized key hash). Returns `{key}`, no-store.5/min/IP; audit reveal/store.400 key_mismatch;404 original_key_unavailable/unknown_license;401 reauthentication_required; encryption/provider failures503 or500. Hash-only originals cannot be reversed. |

Safe license fields: id, productId, keyReference (masked), plan, entitlements, issuedTo, stored status active/revoked, subjectKind installation/service, issuedAt, nullable revokedAt/expiresAt, activationLimit, revision, keyStored boolean. Original key/hash/encryptedKey are excluded. Stored status is **not always derived expiry status**; compare expiresAt or use signed refresh. Validation adds seatsInUse/seatsAvailable/serverTime to this representation. Machine groups expose `{id,supportReference}` and kinds/availability only, not hashes.

Issuance strict body: required UUID requestId and trimmed plan1–200; optional integer planRevision, expectedPrice integer0–100,000,000,000 santim; issuedTo trimmed/max200/defaultempty; installationId trimmed1–200 or licenseRequestId UUID, mutually exclusive; subjectKind installation/service defaultinstallation; optional strict payment `{date:"YYYY-MM-DD",method:trimmed1–100,reference:trimmed1–200}`. No null alternatives except absent payment. Recipient/name required after resolution; registered installation requires credentialHash; request must be unissued and same product. Current active plan terms and resolved ETB price copied; optional revisions/prices should be supplied to catch stale quotes. Direct allowance/expiry/seat overrides at issuance are unsupported; configure a plan or explicitly PATCH later.

Issuance atomically creates license, one immutable-price **initial** sale (id=requestId), optional full payment, delivery and request linkage/replay marker. No payment→unpaid, zero price→complimentary. Initial payment date must equal today's UTC sale date; zero-price payment rejected. No financial records were created by this review. Same parsed body/requestId/actor returns same license/key/sale (201); differing actor/body409 idempotency_conflict. Current sale balances/delivery may evolve on replay. Plan edits do not change historical sale amounts. Audits are appended **after** domain transactions: audit failure can return500 after commit; replay/reconcile rather than issue with a new UUID. Mutation+audit is not one atomic guarantee.

Trial intervention uses the machine clear route above (support/admin), audit `machine.clear`; seat release audit `license.deactivate`; issuance/update/revoke/key reveal similarly audited when deployment audit feature enabled. There is **no recovery-authorization issuance endpoint**, no mandatory staff comment/reference on trial clear, and no transactionally guaranteed audit outbox. A requirement for immutable referenced recovery approvals needs server changes, not an invented CLI command.

## Errors, retries and local state (TRANSPORT-1–4)

Normal domain envelope `{error:string,message:string,retryable:boolean,serverTime:string}`. Framework rate errors may additionally include statusCode/retryAfter. SDK uses status/code, not untrusted text; its retryable status set is429/502/503/504 plus network/timeouts. A generic500 is not automatically retried. Retain idempotency keys across manual retry.

| HTTP / code | Recommended action / cached-state effect |
| --- | --- |
| 400 bad_request, bad_credential, key_required, invalid_support_request, invalid_request_secret, unknown_plan, bad_entitlements, price_required, invalid_payment/date/recipient/customer | Correct input/policy; do not loop. Unrelated failed candidate activation preserves prior valid grant. |
| 401 installation_unauthorized | Stop credential use, restore/reconcile identity; SDK refresh persists denial. Never auto-register a new identity to evade it. |
| 403 not_activated_here | Binding absent/released; block cached paid grant; explicit activation/staff release as appropriate. |
| 404 unknown_key | Candidate key invalid; no seat, preserve unrelated prior authorization. |
| 404 unknown_license / unknown_product;410 product_archived | Refresh denial blocks cached fallback; operator correction needed. |
| 410 license_expired / license_revoked | Validate/activate reject; do not adopt candidate. A corresponding refresh instead supplies signed negative200; persist it. |
| 409 activation_limit_reached | No seat available; staff/user releases another binding, retry activation without changing identity. |
| 409 idempotency_conflict | Stop, restore original durable body or deliberate new operation; never blindly change request UUID. |
| 409 revision_conflict | GET latest; reconcile, then deliberately submit revised update. Same pending message replay remains unchanged. |
| 403 paid_license_required;404 unknown_support_request;409 request_closed | Support unavailable/ownership/status issue; preserve queued identity/history and obtain staff help. |
| 429 rate_limited | Honor Retry-After seconds (HTTP client may also understand date); bounded backoff+jitter. Plugin emits header. |
| 429 support_rate_limited | Same durable request later; no Retry-After header supplied by this domain error. |
| 503 signing_unavailable / encryption_unconfigured / encryption_key_missing;500 internal_error | Do not unlock or rotate identity. Reconcile mutations; operator repairs provider. Signing/decryption can fail after other operations already committed. |
| 409 delivery_unavailable / request_pending;404 delivery_unavailable / request_not_found;503 delivery_failed | Reconcile exact recipient/private secret and status; retry transient failed decryption only after operator repair. No new activation implied. |
| Network/timeout/502–504 | Ambiguous mutation: reuse original body/identity/UUID. Previously valid cached grant can remain only within all signed/local limits. |
| Malformed JSON, wrong signature/context/schema, unknown kid | Never adopt response or unlock from it. SDK retains prior grant; it can remain within its old limits unless a persisted verified denial blocks it. No automatic trust discovery. |

No server-enforced minimum TLS version, HTTP-client timeout or redirect behavior is declared by this app; hosting terminates HTTPS. SDK enforces HTTPS except loopback, rejects redirects, timeout10s/attempt, default3 attempts (configurable1–5), bounded exponential backoff/jitter and Retry-After. JSON body cap is Fastify default1MiB; host may reject sooner. There is no explicit maximum customer response collection or total response byte limit in the SDK. No compression contract guaranteed. Rate defaults: registration/backfill30/min, validate20/min, activate20/min when limits enabled; refresh/deactivate no route quota. In-memory plugin counters are not global across serverless instances; ticket quota uses stored records. Do not advertise globally uniform throttling or an SLA. Use conservative polling and own response/output bounds.

Secure storage must atomically persist credentials, exact pending body, grants, denial, clock high-water and usage state. SDK serialization is per client instance, **not cross-process storage locking**. Implement durable locking/transactions in Rust/storage adapter; a failed save must not be interpreted as fresh state. After remote success/local save failure block mutations and retry/reconcile original operation. Registration replays original token, activation re-mints same binding, deactivation repeats safely, support uses durable IDs/revision, issuance reuses request UUID.

Never log Bearer/cookies, keys, token bodies, raw device IDs/hashes, private-link fragments, customer names/emails or entire request/response objects. Zod error messages can contain field paths, allowed values or unrecognized field **names**; framework parse/proxy messages may echo malformed input. Do not rely on every message being safely redacted; display controlled code-specific copy and redact transport logs. Fastify request logger is disabled here, but host/app logs need their own policy.

## State transitions and staging acceptance

| Trigger | Required transition |
| --- | --- |
| Fresh launch / skip | Persist identity before networking; unlicensed; never silently grant paid/trial access. |
| Registration | Retain signed trial decision but do not select it automatically. |
| Explicit trial | Require online onboarding; verify fresh/time/allowance; select only if application policy allows; preserve consumption. |
| Valid activation | Verify context/signature/terms; atomic save; licensed within time/quota/integrity limits. |
| Failed replacement | Keep unrelated prior valid grant and usage; report failure. |
| Refresh / signed negative | Persist new grant, including expired/revoked, before returning; block old-grant fallback on denial. |
| Release | Reconcile remote release; clear paid grant and deselect trial, retaining usage. |
| Deadline / exhausted quota / corrupt usage | Block new imports; Studio Proof keeps existing content readable. |
| Recovery / legacy state | Fail closed for protected mutations until supported migration or separately approved recovery exists. |

The [offline fixture file](examples/studio-proof-contract/fixtures.json) includes a clearly test-only public key, fixed clock/context, decoded payloads, signed tokens, expected verifier results and SDK authorization states. It contains **no private key or production license**. Valid active/expired/revoked, trial fresh/spent/zero/null, null expiry, quota-only/time-only/hybrid examples and context/schema/signature/key failures are exercised by `test/integration-contract.test.ts`. Fixture entitlement labels illustrate structure, not an approved Studio Proof quota policy. Unsupported signed revision/recovery cases are explicitly listed as gaps, not fabricated success fixtures.

For transport scenarios, existing `test/client-sdk.test.ts` exercises lost registration response/restart, duplicate activation, exhausted seats, disabled/spent trials, signed negative refresh, clock rollback, storage/context corruption, support retries/privacy, collection, native signal backfill and unchanged counters/finances. Use those tests against a **temporary isolated server/database with generated test keys**, not production. Before a hosted staging drill: confirm separate database/verification database, independent signing/auth/encryption keys, demo accounts and storage; never copy production keys/customer data. With owner-authorized disposable staging records, configure priced test plans, issue/revoke/release, inject response loss/races, and verify sales/payments were not duplicated. Staging issuance necessarily creates demo financial records; this questionnaire does not authorize production fixtures. Clean only isolated test records. Run `vp run check`, `vp run test`, `vp run build:all` and browser/package checks. Native Rust acceptance must independently prove monotonic usage, cross-process locking and retention through migration; passing SDK fixtures is insufficient for these app-local guarantees.

## Handoff decision list

- **Supported now:** scoped registration/activation/refresh/deactivation, pinned v4/v2 verification, bounded paid offline use, optional OS signals/backfill, seat limits, plan snapshots/manual ETB finance, installation support/polling/delivery and private preinstallation requests.
- **KeyForge configuration:** confirm product ownership; configure active/priced plans, numeric bounds, trial/time/offline policy, trust distribution and isolated staging. Current values above are a dated snapshot, not permanent policy.
- **Studio Proof implementation:** Rust verifier, secure atomic/locked persistence, explicit onboarding, import entitlement enforcement, monotonic lifetime ledger, safe retry/outbox, grant/denial handling, no-reset migration, consent to replace keys and preserving read access.
- **Product-owner decisions:** imports counting unit/ceiling/top-ups/unlimited semantics, trial-to-paid/resume, grandfathering, historical-record provenance and no-history recovery. These block a complete business integration; neither “confirmed” deployment values nor SDK state names settle them.
- **Unsupported / changes required:** credential rotation/recovery, signed total ordering/revision, signed registration witness without trials, signed protected-usage recovery and one-time adoption, physical-device attestation, immediate offline revocation, customer email/attachments/realtime, fully enumerated privileged OpenAPI and transactionally guaranteed audit. Do not invent endpoints or add incompatible claims to v4.
