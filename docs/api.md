# API reference

Vercel-only internal worker: `GET /api/internal/backups/tick` requires `Authorization: Bearer CRON_SECRET`; it is not a dependent-app API. It returns `unauthorized` (401) when the credential is absent or incorrect, and `backup_worker_failed` (503) when processing cannot complete. See [Vercel deployment](vercel.md) for scheduling and isolation.

For dependent apps, use the [client OpenAPI document](client-openapi.json) and [TypeScript SDK guide](../packages/keyforge-client/README.md). The machine-readable contract covers current public routes and explicitly separates installation, private-request and trusted-backend credentials. Its request/response examples are exercised against the server by `test/client-sdk.test.ts`; regenerate with `vp run docs:client-api`.

This is the fresh product-scoped v1 contract. License, trial and usage-recovery tokens are v1; no older formats are accepted. All timestamps are ISO 8601. API responses are non-cacheable.

## Authentication and roles

`PUT /v1/products/:productId/installations/:installationId/device-signals` authenticates the installation bearer credential and accepts `{machineSignals: [{kind, hash}]}` (maximum three; kinds `machine-guid`, `smbios-uuid`, `volume-serial`, `linux-machine-id`, `macos-platform-uuid`, `root-volume-uuid`; lowercase SHA-256 hex). It updates current signal availability and appends evidence to the authenticated identity's existing group, never matching or merging another group. Empty signals mark current availability unavailable without deleting historical group evidence. Response: `{ok: true, serverTime}`. It never registers again, issues a trial, changes counters, consumes/releases seats, resets usage or affects finances. See the [desktop adapter contract](device-identity.md).

Device operations require Bearer installation credentials. Registration pins a random 256-bit base64url secret to the chosen installation ID. Metering requires a distinct product-scoped trusted service credential. Console routes require Better Auth cookies or the optional privileged LICENSE_ADMIN_TOKEN.

Admins manage products, definitions, plans, licenses, keys, meters, service credentials, operators and backups. Support operators can read product records, release seats, clear machine trials and handle support assignment/status/messages. They cannot reveal product keys or mutate product/catalog/billing-like policy. Profile/password/session controls operate on the signed-in operator's own account. JSON writes from console sessions check request origin when present.

Better Auth endpoints live under /api/auth/* (GET/POST): sign-in/email, sign-out, get-session, update-user, change-password, list-sessions, revoke-session and configured admin plugin operations. Self profile fields are name, image (HTTPS URL, a validated bounded raster data URL, or null), phone, jobTitle and a valid IANA timezone. See the profile image constraints below. Email and role cannot be changed by update-user.

## Bodies and response conventions

Product IDs are lowercase slugs. Definition IDs permit letters, digits, underscore, dot and hyphen (up to 64). Updates to existing catalog, product, meter, schedule and support records require their current integer revision; stale values return revision_conflict. Archive records instead of deleting data used by history.

- Product create: id/name; patch: name/archived/graceDays/trial/revision. Trial contains enabled, nullable nonnegative integer allowance and nullable positive durationDays.
- Definition PUT: id/type/description/archived, optional defaultValue/minimum/maximum/revision. Types are number/string/boolean.
- Plan PUT: id/description/entitlements/durationDays/activationLimit/archived/revision, price (integer santim or null) and currency (ETB). Configure a price before issuance. Entitlements must match active definitions. durationDays is positive or null.
- Catalog import: catalog:{version:1,definitions,plans}, preview boolean; apply also requires the preview fingerprint. Export excludes secrets and licenses.
- License POST: requestId UUID and plan required; issuedTo, installationId or licenseRequestId, subjectKind installation/service, planRevision, expectedPrice optional. Optional payment:{date,method,reference} records the full plan price received on today’s UTC date. Terms cannot be overridden. Atomically returns HTTP 201 with license/key, immutable ETB sale and delivery status. Exact retries reuse the request ID; changed payloads conflict. No price means issuance is refused.
- License PATCH: editable issuedTo/entitlements/activationLimit/expiresAt and current revision. Revoke is explicit. Key POST requires `password` for console sessions; optional key securely retains a matching historical original. API bearer automation has no password prompt.
- Register: installationId (trimmed nonempty string, maximum 200 characters; SDK generates a UUID), requestId UUID plus optional appVersion/platform/userName/userEmail/machineSignals. Exact retries return the original response; identity cannot be claimed with a different credential.
- Validate/activate: installationId/key. Refresh/deactivate: installationId/licenseId. Activation/refresh return token/serverTime. Refresh may return signed expired/revoked status with HTTP 200.
- Support create: licenseId/requestId/category/urgency/subject/message/createdAt plus optional reporter.name and app.version/platform. Set Idempotency-Key to requestId. Categories: technical/licensing/billing/feature_request/other. Urgencies: low/normal/high/critical. HTTP 202 acknowledges persistence.
- Support patch: revision/status/assignedTo (operator email or null). States: queued/in_progress/waiting_customer/resolved/closed. Message POST: UUID requestId/message and operator-only internal boolean. Customer reads omit assignment/internal notes.
- Meter PUT: id/entitlement/period/description/archived/revision. Period lifetime/daily/monthly; entitlement must be numeric. Credentials POST: name/permissions (usage:read, usage:consume); secret is returned once.
- Usage summary: licenseId/meterId. Consume adds positive safe-integer units and UUID eventId. Atomic quota enforcement; stable events remain idempotent across UTC periods.
- Backups GET: jobs/destinations with individual schedules and credential readiness (no credential values). POST: destination local/s3/r2/uploadthing or custom UUID ID; HTTP 202 job. Destination POST: name/url/method POST or PUT/format multipart or raw/fileField, optional paired headerName/headerValueEnv (LICENSE_BACKUP_CUSTOM_ variable). Destination PUT also requires revision; archived disables its schedule. Per-destination schedule PUT: enabled/hourUTC/minuteUTC/retentionDays/revision. Existing schedule PUT also accepts destination. Upload-only endpoints retain a local download copy; failed uploads can be downloaded if snapshot creation succeeded. Download routes return binary snapshots or encrypted archives, not JSON.
- Diagnostics POST: token. Returns untrusted payload plus signatureValid/schemaValid/currentAuthorization/serverTime; it does not mint authorization.

List routes use q/limit/offset (limit at most 200), with additional status/category/urgency/licensed filters where applicable. Audit uses limit/before/licenseId and returns nextBefore. Licenses include masked keyReference and keyStored, never a hash or encrypted key. Installation links include released history and current authorization. Public key discovery includes pending/retired keys; trust must be established separately.

## Registered routes

The table is generated from an isolated server's route registration. Product-scoped paths use :productId; :id is the relevant record ID.

| Method | Path |
| --- | --- |
| GET | `/admin/audit` |
| GET | `/admin/backup/:database` |
| GET | `/admin/backups` |
| POST | `/admin/backups` |
| GET | `/admin/backups/:id/download` |
| POST | `/admin/backups/:id/verify` |
| POST | `/admin/backups/destinations` |
| PUT | `/admin/backups/destinations/:id` |
| PUT | `/admin/backups/destinations/:id/schedule` |
| PUT | `/admin/backups/providers/:id` |
| POST | `/admin/backups/providers/:id/verify` |
| PUT | `/admin/backups/schedule` |
| PUT | `/admin/backups/storage-default` |
| GET | `/admin/config` |
| GET | `/admin/operators/directory` |
| GET | `/admin/products` |
| POST | `/admin/products` |
| PATCH | `/admin/products/:productId` |
| GET | `/admin/products/:productId/catalog` |
| GET | `/admin/products/:productId/catalog/export` |
| POST | `/admin/products/:productId/catalog/import` |
| GET | `/admin/products/:productId/credentials` |
| POST | `/admin/products/:productId/credentials` |
| POST | `/admin/products/:productId/credentials/:id/revoke` |
| PUT | `/admin/products/:productId/definitions/:id` |
| POST | `/admin/products/:productId/diagnostics` |
| GET | `/admin/products/:productId/finance` |
| PUT | `/admin/products/:productId/finance/prices/:priceId` |
| GET | `/admin/products/:productId/finance/report` |
| POST | `/admin/products/:productId/finance/sales` |
| POST | `/admin/products/:productId/finance/sales/:saleId/entries` |
| PUT | `/admin/products/:productId/import-policy` |
| GET | `/admin/products/:productId/installations` |
| POST | `/admin/products/:productId/keys/:kid/activate` |
| POST | `/admin/products/:productId/keys/stage` |
| GET | `/admin/products/:productId/license-recipients` |
| GET | `/admin/products/:productId/license-requests` |
| GET | `/admin/products/:productId/licenses` |
| POST | `/admin/products/:productId/licenses` |
| GET | `/admin/products/:productId/licenses/:id` |
| PATCH | `/admin/products/:productId/licenses/:id` |
| GET | `/admin/products/:productId/licenses/:id/activations` |
| POST | `/admin/products/:productId/licenses/:id/deactivate` |
| GET | `/admin/products/:productId/licenses/:id/delivery` |
| GET | `/admin/products/:productId/licenses/:id/import-account` |
| POST | `/admin/products/:productId/licenses/:id/key` |
| POST | `/admin/products/:productId/licenses/:id/renew` |
| POST | `/admin/products/:productId/licenses/:id/replace-key` |
| POST | `/admin/products/:productId/licenses/:id/revoke` |
| GET | `/admin/products/:productId/machines` |
| POST | `/admin/products/:productId/machines/:id/clear` |
| GET | `/admin/products/:productId/meters` |
| PUT | `/admin/products/:productId/meters/:id` |
| GET | `/admin/products/:productId/notifications` |
| POST | `/admin/products/:productId/notifications/bulk` |
| PUT | `/admin/products/:productId/notifications/preferences` |
| POST | `/admin/products/:productId/notifications/read` |
| PUT | `/admin/products/:productId/plans/:id` |
| GET | `/admin/products/:productId/recovery-requests` |
| POST | `/admin/products/:productId/recovery-requests/:id/approve` |
| POST | `/admin/products/:productId/recovery-requests/:id/reject` |
| GET | `/admin/products/:productId/reports` |
| GET | `/admin/products/:productId/support` |
| GET | `/admin/products/:productId/support/:id` |
| PATCH | `/admin/products/:productId/support/:id` |
| POST | `/admin/products/:productId/support/:id/messages` |
| POST | `/admin/products/:productId/support/:id/read` |
| GET | `/admin/system` |
| GET | `/admin/system/reset` |
| POST | `/admin/system/reset` |
| GET | `/api/auth/*` |
| POST | `/api/auth/*` |
| GET | `/api/meta` |
| GET | `/healthz` |
| GET | `/v1/license-request-catalog` |
| POST | `/v1/license-requests` |
| GET | `/v1/license-requests/:id` |
| POST | `/v1/license-requests/:id/collect` |
| GET | `/v1/meta` |
| POST | `/v1/products/:productId/activate` |
| POST | `/v1/products/:productId/deactivate` |
| PUT | `/v1/products/:productId/installations/:installationId/device-signals` |
| POST | `/v1/products/:productId/installations/:installationId/licenses/:id/collect` |
| GET | `/v1/products/:productId/installations/:installationId/notifications` |
| PUT | `/v1/products/:productId/installations/:installationId/notifications/preferences` |
| POST | `/v1/products/:productId/installations/:installationId/notifications/read` |
| POST | `/v1/products/:productId/installations/:installationId/recovery-requests` |
| POST | `/v1/products/:productId/installations/:installationId/recovery-requests/:id/claim` |
| GET | `/v1/products/:productId/installations/:installationId/support` |
| POST | `/v1/products/:productId/installations/:installationId/support` |
| GET | `/v1/products/:productId/installations/:installationId/support/:id` |
| POST | `/v1/products/:productId/installations/:installationId/support/:id/messages` |
| GET | `/v1/products/:productId/keys` |
| POST | `/v1/products/:productId/refresh` |
| POST | `/v1/products/:productId/register` |
| POST | `/v1/products/:productId/usage/consume` |
| POST | `/v1/products/:productId/usage/summary` |
| POST | `/v1/products/:productId/validate` |

## Errors

Domain errors use error/message/retryable/serverTime; rate limiting may include Retry-After. Better Auth returns its own error envelope. Retry 429/503 with bounded backoff; 409 usually needs record reload, seat release or a corrected idempotency key. Do not retry invalid credentials indefinitely.

| Code |
| --- |
| `account_mismatch` |
| `activation_limit_reached` |
| `admin_disabled` |
| `admin_unauthorized` |
| `assignment_unavailable` |
| `audit_disabled` |
| `auth_disabled` |
| `backup_cache_missing` |
| `backup_corrupt` |
| `backup_database_unconfigured` |
| `backup_destination_changed` |
| `backup_destination_unconfigured` |
| `backup_encryption_unconfigured` |
| `backup_operation_unavailable` |
| `backup_provider_access_denied` |
| `backup_provider_failed` |
| `backup_provider_not_found` |
| `backup_provider_timeout` |
| `backup_remote_http_error` |
| `backup_retention_failed` |
| `backup_storage_missing` |
| `backup_too_large` |
| `backup_tool_unavailable` |
| `backup_unavailable` |
| `backup_unsupported` |
| `backup_verification_failed` |
| `backup_worker_failed` |
| `backups_disabled` |
| `bad_credential` |
| `bad_definition` |
| `bad_entitlements` |
| `bad_meter` |
| `bad_request` |
| `bad_trial` |
| `customer_required` |
| `definition_in_use` |
| `delivery_failed` |
| `delivery_unavailable` |
| `duplicate_catalog_id` |
| `encryption_key_missing` |
| `encryption_unconfigured` |
| `excess_credit` |
| `future_date` |
| `historical_overpayment` |
| `idempotency_conflict` |
| `import_account_missing` |
| `import_account_required` |
| `import_migration_required` |
| `initial_sale_exists` |
| `installation_unauthorized` |
| `insufficient_role` |
| `internal_error` |
| `invalid_assignee` |
| `invalid_date` |
| `invalid_import_allowance` |
| `invalid_license_request` |
| `invalid_message` |
| `invalid_origin` |
| `invalid_payment` |
| `invalid_payment_reference` |
| `invalid_recipient` |
| `invalid_refund` |
| `invalid_request_secret` |
| `invalid_support_request` |
| `key_already_staged` |
| `key_mismatch` |
| `key_required` |
| `license_` |
| `license_expired` |
| `license_revoked` |
| `malformed_token` |
| `meter_in_use` |
| `not_activated_here` |
| `not_found` |
| `notification_confirmation_required` |
| `notification_selection_required` |
| `original_key_unavailable` |
| `overpayment` |
| `paid_license_required` |
| `policy_locked` |
| `price_required` |
| `product_archived` |
| `product_exists` |
| `quota_exhausted` |
| `rate_limited` |
| `reason_required` |
| `reauthentication_required` |
| `recovery_rate_limited` |
| `recovery_required` |
| `recovery_stale` |
| `recovery_unavailable` |
| `registry_disabled` |
| `renewal_unavailable` |
| `request_closed` |
| `request_not_found` |
| `request_pending` |
| `reset_busy` |
| `reset_in_progress` |
| `reset_unavailable` |
| `reset_unrelated_data` |
| `revision_conflict` |
| `revision_required` |
| `service_unauthorized` |
| `signing_unavailable` |
| `single_installation_required` |
| `storage_credentials_required` |
| `storage_not_saved` |
| `support_rate_limited` |
| `unauthorized` |
| `unknown_backup` |
| `unknown_backup_destination` |
| `unknown_credential` |
| `unknown_license` |
| `unknown_machine` |
| `unknown_meter_or_license` |
| `unknown_plan` |
| `unknown_product` |
| `unknown_recovery` |
| `unknown_sale` |
| `unknown_staged_key` |
| `unknown_support_request` |
| `usage_unauthorized` |
| `use_license_renewal` |
| `verification_unconfigured` |

## Console reports

`GET /admin/products/:productId/reports` requires an operator session or admin bearer token. Both admin and support roles may read reports for the selected product. It returns explicit report fields, never stored product keys, credential hashes, private keys, or support message bodies.

Query fields: `type` (`licenses`, `expirations`, `usage`, `activations`, `support`; default `licenses`), optional `from` and `to` (inclusive UTC calendar dates), `customer` (case-insensitive name substring), and `status` (default `all`). Invalid dates or a reversed range return 400. Activation reports return 404 `registry_disabled` when registry collection is disabled.

The response contains `rows`, status `counts`, per-meter `meters` totals for usage, and `generatedAt`. Dates refer to license issuance, expiry, activation, or support receipt according to type. Status is current at generation time, not historical. Expiration reports omit perpetual licenses. Usage is stored as cumulative daily/monthly/lifetime buckets: dated ranges include whole overlapping buckets and omit undated lifetime totals. Units from different meters are never combined. Reports are not an event-level billing ledger.

The console paginates the returned snapshot, exports all filtered rows to CSV (with spreadsheet-formula neutralization), and prints all filtered rows using the browser's Save as PDF destination. No report is publicly shared.

Profile updates at `/api/auth/update-user` retain their existing session, origin, and field restrictions. The `image` field accepts an HTTPS URL, null/empty for removal, or a PNG/JPEG/WebP base64 data URL up to 256 KiB with a matching raster signature. The console accepts source images up to 5 MiB and resizes them to at most 256 pixels before saving. The image is stored in the operator database and travels with its backup; SVG data and arbitrary data URLs are refused.

## Manual ETB sales and finance

Financial routes require an admin session or privileged admin bearer token; support operators are denied reads as well as writes. All amounts are integer **santim**, with 100 santim = ETB 1.00. No currency conversion, tax computation or payment gateway is involved.

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/admin/products/:productId/finance` | Sales with derived balances/status, immutable transaction entries, price defaults and safe license/plan choices. |
| PUT | `/admin/products/:productId/finance/prices/:priceId` | `{amount: integer|null, revision?: integer}`. `__product__` is the product fallback; other IDs are plan IDs. Null inherits the fallback. |
| POST | `/admin/products/:productId/finance/sales` | `{requestId: UUID, licenseId, kind: initial|renewal, date: YYYY-MM-DD, listAmount, discount, amount, dueDate?: date|null, note?: string}`. Amount must equal listAmount minus discount. One initial sale per license; multiple renewals supported. |
| POST | `/admin/products/:productId/finance/sales/:saleId/entries` | `{requestId: UUID, kind: payment|refund|credit, amount, date, paymentId?: string|null, method?: string, reference?: string, reason?: string}`. Refunds reference a payment; refunds and credits require a reason. |
| GET | `/admin/products/:productId/finance/report` | Optional `from`, `to`, `customer`. Sale value follows sale dates; receipts/refunds/credits follow their own dates; outstanding is cumulative through `to` (default current UTC date). Returns ETB totals, period sales, period entries and as-of balances. |

Sale and entry UUIDs provide idempotency: retries with identical normalized payloads return the original record; changed payloads return `idempotency_conflict`. Dates cannot be future-dated, and entries cannot precede their sale. Overpayments, excessive credits, and refunds exceeding the referenced receipt are rejected. Historical daily balances cannot become negative through backdating. Financial records are append-only through these APIs; corrections retain history using refunds, credits and new sale records.

A cash refund reopens the amount owed. A credit reduces the agreed charge; when cancelling a paid charge, record its refund then credit. This distinguishes money returned from debt cancelled. A zero-value sale is `complimentary`, never evidence of cash received. Legacy licenses have no sales record until explicitly recorded. Default price changes do not rewrite sale snapshots. Renewals record a new sale; expiry changes remain a separate explicit licensing action. New issuance atomically records a plan-priced sale, unpaid unless a payment is supplied. Existing licenses without sales remain unchanged. No token payload, signing, activation or validation behavior changes.

New errors: `future_date`, `initial_sale_exists`, `unknown_sale`, `invalid_date`, `overpayment`, `reason_required`, `excess_credit`, `invalid_refund`, `invalid_payment_reference`, `historical_overpayment`. These are validation errors (400), except unknown sale (404) and initial sale conflict (409).

## Inbox read state and in-app notifications

| Method | Route | Contract |
| --- | --- | --- |
| POST | `/admin/products/:productId/support/:id/read` | `{lastMessageId}` where the original request uses `original`. Stores the current operator's read marker. `invalid_message` means the message does not belong to this ticket. |
| GET | `/admin/products/:productId/notifications` | Current attention/assignment/expiration items, per-operator read state and preferences. |
| PUT | `/admin/products/:productId/notifications/preferences` | `{messages, assignments, expirations}` booleans; scoped to the operator and product. |
| POST | `/admin/products/:productId/notifications/read` | `{eventId}` marks an item read for the current operator. |
| GET | `/v1/products/:productId/installations/:installationId/notifications` | Installation-authenticated public reply and license expiration notices, read state and preferences. No internal notes or operator identity. |
| PUT | `/v1/products/:productId/installations/:installationId/notifications/preferences` | Installation-authenticated `{messages, expirations}` booleans. |
| POST | `/v1/products/:productId/installations/:installationId/notifications/read` | Installation-authenticated `{eventId}`. |

Support listing accepts `view=all|attention|unread|mine|unassigned`, existing status/category/urgency/search filters and limit/offset pagination. It includes an operator-only preview, unread and needsAttention flags. Newest updated conversations come first. Read state is personal; assignment and status are shared. Existing original messages and replies remain intact. Private notes are shown in a separate history view and remain excluded from every customer response.

Notifications are a **pull-based current-attention feed**, not background email or push delivery. The console polls every 30 seconds while open. Stable event IDs let clients mark notices read without duplicates; a new customer message or expiration threshold produces a new ID. Expirations are derived within 30, 7 and 1 days of the current expiry. Read notices and preferences persist in the database; changing or revoking a license removes obsolete expiry notices. Assignment notices represent current assignments, not an assignment-event audit.

Dependent apps must poll the authenticated notification endpoint, render unread items, open the existing support thread API, and POST read markers. Preference controls can use the corresponding PUT endpoint. Replying continues through the existing installation support message endpoint. Preinstallation requests now use a private status page; no email transport is introduced. A saved operator reply is available for retrieval; it is not falsely labelled delivered or read.

All new data uses versioned `platform_records` kinds (`price`, `sale`, `financial_entry`, `conversation_read`, `notification_read`, `notification_preferences`) and existing SQLite/Postgres transaction locking. The fresh v1 schema does not import previous development databases. Existing full database backups include these records. Very large datasets may later warrant indexed relational tables; current list views are paginated and exports include all filtered records.

## Notification history and bulk controls

`GET /admin/products/:productId/notifications` now captures operator notifications in personal product-scoped history and returns `createdAt` in addition to the event's `date` (expiry date for expiration events). Previously captured notifications remain visible after the conversation resolves. Preferences control new captures; they do not erase history. Deleted event IDs remain tombstoned for that recipient, so polling cannot recreate them. Existing `notification_read` state is honored. Customer notification routes and privacy boundaries retain their existing contract.

`POST /admin/products/:productId/notifications/bulk` accepts `{action:"read"|"unread"|"delete",scope:"selected"|"matching"|"all",filter:"all"|"unread"|"read",eventIds?:string[],confirmed?:boolean}`. `selected` requires at least one event ID (maximum 2000). `matching` applies the filter across all pages. `all` ignores the filter and acts on every nondeleted notification owned by the current operator in the product. Deletion requires `confirmed:true` and only dismisses notifications; it preserves the referenced license/conversation. Returns `{ok:true,affected:number}`. Actions are atomic and cannot change another recipient's notification state. Errors: `notification_confirmation_required`, `notification_selection_required` (HTTP 400), plus validation errors.

Raw SQLite snapshots support `GET /admin/backup/:database` with `database=database|licenses|auth`; unified deployments return the shared file through all three aliases. The preferred path is `/admin/backup/database`. See [Database setup](database.md).

## Requests before installation and automatic issuance

See [License requests and sales](license-sales.md) for the complete operator/customer workflow. Issuance requires `requestId` and an active, priced plan. It does not accept entitlement, seat or expiry overrides. A linked ETB initial sale is created atomically; optional `payment:{date,method,reference}` records full payment on today's UTC date. Exact retries return the same license, key and sale. Existing records are not rewritten.

- `GET /v1/license-request-catalog`: public available product and requested-plan choices (no financial data).
- `POST /v1/license-requests`: `{id:UUID,productId,plan,name,email}` with a new random 256-bit base64url/hex bearer credential. Exact retries reuse both. Returns 202; the customer must save `/license-request/ID#CREDENTIAL`. No email is sent; contact email is unverified.
- `GET /v1/license-requests/:id`: bearer-authorized status, contact details and delivery metadata, never the key or stored credential hash.
- `POST /v1/license-requests/:id/collect`: same bearer; returns `{key,license}` after issuance and records retrieval. Safe to repeat; invalid/revoked/expired licenses cannot be retrieved.
- `GET /admin/products/:productId/license-recipients`: admin-only installation and unissued request choices.
- `GET /admin/products/:productId/license-requests`: operator request listing, with credential hashes removed.
- `GET /admin/products/:productId/licenses/:id/delivery`: operator-safe delivery status. Available is not proof of retrieval; retrieved, manual and failed are explicit.
- `POST /v1/products/:productId/installations/:installationId/licenses/:id/collect`: installation bearer credential, restricted to the targeted installation. The dependent app's notification item provides this `collectPath`. No key is included in notification listings.

Plan PUT accepts optional `price` in integer santim (null inherits the existing product fallback) and `currency:ETB`. Catalogs and exports expose resolved prices only to admins. Import price changes participate in the existing preview fingerprint. Sales and payment history remain fixed.

## Online application reset

Admin-only `GET /admin/system/reset` returns the retained seeded administrator identity, availability/reason and backup prerequisites. `POST /admin/system/reset` accepts `{confirmation:"DELETE ALL",backup:boolean,requestId:UUID}`. Case and spacing must match exactly. It retains the first recorded seeded admin's ID, profile, password/provider accounts and non-impersonated sessions; other operators, sessions and application records are deleted. Schema/migration state, the bootstrap identity and reset replay receipts remain. Default product/configured plan defaults are recreated using normal bootstrap logic. A request ID that completed previously returns its receipt without clearing newer data.

With `backup:true`, enabled/encrypted local backups are mandatory. The server locks writers, captures the complete pre-reset database, verifies the encrypted archive through the existing restore/integrity checks, and only then deletes data in the same reset transaction. PostgreSQL requires pg_dump/pg_restore and a separate `LICENSE_BACKUP_VERIFY_DATABASE_URL` with temporary-database creation permission. The new verified archive remains downloadable through `/admin/backups/:id/download`. Backup failure aborts deletion; database errors roll back deletion, retaining any already verified backup. External configuration, signing keys, encryption rings and archive files are never deleted. Already-issued offline tokens can remain valid until their original expiry.

Errors: `reset_unavailable` (missing/inactive bootstrap admin or auth, 409/503), `reset_busy` (running backups or requests, 409), `reset_in_progress` (concurrent operation, 409/503), `reset_unrelated_data` (unrelated data/dependencies, 409), `reset_failed` (rolled-back reset, 500), plus existing backup errors and `bad_request` for invalid confirmation/body. Other requests on this server receive 503 with Retry-After during reset, except health checks. Deleted operators must sign in using a newly provisioned account; the retained administrator can continue their original session.

## Database-managed backup storage

Admin-only `PUT /admin/backups/providers/:id` accepts `blob`, `s3`, `r2` or `uploadthing` and a current `revision` (zero for first setup). Blob/UploadThing accept `token`; S3/R2 accept `bucket`, `region`, optional HTTPS `endpoint`, `accessKeyId`, `secretAccessKey` and optional `sessionToken`. Blank secret fields retain saved values; `clearSessionToken:true` removes a temporary token. R2 requires an endpoint. Configuration is encrypted with the external data keyring. Responses expose metadata/credential-presence flags, never credentials or ciphertext. Stale revisions return 409.

`POST /admin/backups/providers/:id/verify` tests upload, byte-exact download and deletion using the saved credentials. It records verification only if that configuration remains current; database archive recovery is a separate verification. `PUT /admin/backups/storage-default` accepts `{destination}` for a configured provider (or persistent-host local storage). The default applies to immediate downloads and reset backups. Settings reset retains storage configuration and historical versions. Jobs keep their original destination version.

Custom destination writes may supply `headerValue` with `headerName` to save an encrypted authorization value, or `keepAuthorization:true` to preserve one during edits. Clear the header name to remove authorization. The legacy restricted `headerValueEnv` contract remains accepted. The listing returns `hasAuthorization`, never the saved value/ciphertext.
