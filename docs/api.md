# API reference

This is the fresh product-scoped contract. Legacy unscoped routes are removed. License tokens are v4; trial tokens are v2. All timestamps are ISO 8601. API responses are non-cacheable.

## Authentication and roles

Device operations require Bearer installation credentials. Registration pins a random 256-bit base64url secret to the chosen installation ID. Metering requires a distinct product-scoped trusted service credential. Console routes require Better Auth cookies or the optional privileged LICENSE_ADMIN_TOKEN.

Admins manage products, definitions, plans, licenses, keys, meters, service credentials, operators and backups. Support operators can read product records, release seats, clear machine trials and handle support assignment/status/messages. They cannot reveal product keys or mutate product/catalog/billing-like policy. Profile/password/session controls operate on the signed-in operator's own account. JSON writes from console sessions check request origin when present.

Better Auth endpoints live under /api/auth/* (GET/POST): sign-in/email, sign-out, get-session, update-user, change-password, list-sessions, revoke-session and configured admin plugin operations. Self profile fields are name, image (HTTPS URL or null), phone, jobTitle and a valid IANA timezone. Email and role cannot be changed by update-user.

## Bodies and response conventions

Product IDs are lowercase slugs. Definition IDs permit letters, digits, underscore, dot and hyphen (up to 64). Updates to existing catalog, product, meter, schedule and support records require their current integer revision; stale values return revision_conflict. Archive records instead of deleting data used by history.

- Product create: id/name; patch: name/archived/graceDays/trial/revision. Trial contains enabled, nullable nonnegative integer allowance and nullable positive durationDays.
- Definition PUT: id/type/description/archived, optional defaultValue/minimum/maximum/revision. Types are number/string/boolean/mixed; mixed legacy definitions must be resolved before new grants.
- Plan PUT: id/description/entitlements/durationDays/activationLimit/archived/revision, price (integer santim or null) and currency (ETB). Configure a price before issuance. Entitlements must match active definitions. durationDays is positive or null.
- Catalog import: catalog:{version:1,definitions,plans}, preview boolean; apply also requires the preview fingerprint. Export excludes secrets and licenses.
- License POST: requestId UUID and plan required; issuedTo, installationId or licenseRequestId, subjectKind installation/service, planRevision, expectedPrice optional. Optional payment:{date,method,reference} records the full plan price received on today’s UTC date. Terms cannot be overridden. Atomically returns HTTP 201 with license/key, immutable ETB sale and delivery status. Exact retries reuse the request ID; changed payloads conflict. No price means issuance is refused.
- License PATCH: editable issuedTo/entitlements/activationLimit/expiresAt and current revision. Revoke is explicit. Key POST requires currentPassword for console sessions; optional key securely retains a matching historical original. API bearer automation has no password prompt.
- Register: installationId/requestId UUID plus optional appVersion/platform/userName/userEmail/machineSignals. Exact retries return the original response; identity cannot be claimed with a different credential.
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
| POST | `/admin/products/:productId/licenses/:id/key` |
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
| `initial_sale_exists` |
| `installation_unauthorized` |
| `insufficient_role` |
| `internal_error` |
| `invalid_assignee` |
| `invalid_date` |
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
| `price_required` |
| `product_archived` |
| `product_exists` |
| `quota_exhausted` |
| `rate_limited` |
| `reason_required` |
| `reauthentication_required` |
| `registry_disabled` |
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
| `unknown_sale` |
| `unknown_staged_key` |
| `unknown_support_request` |
| `usage_unauthorized` |
| `verification_unconfigured` |
