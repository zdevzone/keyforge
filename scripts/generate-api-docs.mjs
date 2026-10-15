import { readFile, writeFile } from "node:fs/promises";

import { buildLicenseApp } from "../dist/src/app.js";
import { LicenseDatabase } from "../dist/src/db.js";
import { generateSigningKeyPair } from "../dist/src/sign.js";

const routes = [];
const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
const app = await buildLicenseApp({
  database,
  privateKey: generateSigningKeyPair().privateKey,
  uiDir: "./.no-ui",
  onRoute: (method, url) => routes.push({ method, url }),
});
try {
  await app.ready();
} finally {
  await app.close();
  await database.close();
}
const codes = new Set(["license_expired", "license_revoked", "rate_limited", "not_found"]);
for (const path of [
  "src/app.ts",
  "src/platform.ts",
  "src/license-delivery.ts",
  "src/finance.ts",
  "src/notifications.ts",
  "src/platform-store.ts",
  "src/backups.ts",
  "src/system-reset.ts",
  "src/maintenance.ts",
  "src/backup-destinations.ts",
]) {
  const source = await readFile(path, "utf8");
  for (const pattern of [
    /new DomainError\(\s*"([a-z_]+)"/g,
    /fail\(reply,\s*\d+,\s*"([a-z_]+)"/g,
    /error:\s*"([a-z_]+)"/g,
  ])
    for (const match of source.matchAll(pattern)) codes.add(match[1]);
}
const table =
  "| Method | Path |\n| --- | --- |\n" +
  routes
    .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))
    .map((r) => "| " + r.method + " | `" + r.url + "` |")
    .join("\n");
const errors =
  "\n\n## Errors\n\nDomain errors use error/message/retryable/serverTime; rate limiting may include Retry-After. Better Auth returns its own error envelope. Retry 429/503 with bounded backoff; 409 usually needs record reload, seat release or a corrected idempotency key. Do not retry invalid credentials indefinitely.\n\n| Code |\n| --- |\n" +
  [...codes]
    .sort()
    .map((c) => "| `" + c + "` |")
    .join("\n") +
  "\n";
await writeFile(
  "docs/api.md",
  "# API reference\n\nThis is the fresh product-scoped contract. Legacy unscoped routes are removed. License tokens are v4; trial tokens are v2. All timestamps are ISO 8601. API responses are non-cacheable.\n\n## Authentication and roles\n\nDevice operations require Bearer installation credentials. Registration pins a random 256-bit base64url secret to the chosen installation ID. Metering requires a distinct product-scoped trusted service credential. Console routes require Better Auth cookies or the optional privileged LICENSE_ADMIN_TOKEN.\n\nAdmins manage products, definitions, plans, licenses, keys, meters, service credentials, operators and backups. Support operators can read product records, release seats, clear machine trials and handle support assignment/status/messages. They cannot reveal product keys or mutate product/catalog/billing-like policy. Profile/password/session controls operate on the signed-in operator's own account. JSON writes from console sessions check request origin when present.\n\nBetter Auth endpoints live under /api/auth/* (GET/POST): sign-in/email, sign-out, get-session, update-user, change-password, list-sessions, revoke-session and configured admin plugin operations. Self profile fields are name, image (HTTPS URL or null), phone, jobTitle and a valid IANA timezone. Email and role cannot be changed by update-user.\n\n## Bodies and response conventions\n\nProduct IDs are lowercase slugs. Definition IDs permit letters, digits, underscore, dot and hyphen (up to 64). Updates to existing catalog, product, meter, schedule and support records require their current integer revision; stale values return revision_conflict. Archive records instead of deleting data used by history.\n\n- Product create: id/name; patch: name/archived/graceDays/trial/revision. Trial contains enabled, nullable nonnegative integer allowance and nullable positive durationDays.\n- Definition PUT: id/type/description/archived, optional defaultValue/minimum/maximum/revision. Types are number/string/boolean/mixed; mixed legacy definitions must be resolved before new grants.\n- Plan PUT: id/description/entitlements/durationDays/activationLimit/archived/revision, price (integer santim or null) and currency (ETB). Configure a price before issuance. Entitlements must match active definitions. durationDays is positive or null.\n- Catalog import: catalog:{version:1,definitions,plans}, preview boolean; apply also requires the preview fingerprint. Export excludes secrets and licenses.\n- License POST: requestId UUID and plan required; issuedTo, installationId or licenseRequestId, subjectKind installation/service, planRevision, expectedPrice optional. Optional payment:{date,method,reference} records the full plan price received on today’s UTC date. Terms cannot be overridden. Atomically returns HTTP 201 with license/key, immutable ETB sale and delivery status. Exact retries reuse the request ID; changed payloads conflict. No price means issuance is refused.\n- License PATCH: editable issuedTo/entitlements/activationLimit/expiresAt and current revision. Revoke is explicit. Key POST requires currentPassword for console sessions; optional key securely retains a matching historical original. API bearer automation has no password prompt.\n- Register: installationId/requestId UUID plus optional appVersion/platform/userName/userEmail/machineSignals. Exact retries return the original response; identity cannot be claimed with a different credential.\n- Validate/activate: installationId/key. Refresh/deactivate: installationId/licenseId. Activation/refresh return token/serverTime. Refresh may return signed expired/revoked status with HTTP 200.\n- Support create: licenseId/requestId/category/urgency/subject/message/createdAt plus optional reporter.name and app.version/platform. Set Idempotency-Key to requestId. Categories: technical/licensing/billing/feature_request/other. Urgencies: low/normal/high/critical. HTTP 202 acknowledges persistence.\n- Support patch: revision/status/assignedTo (operator email or null). States: queued/in_progress/waiting_customer/resolved/closed. Message POST: UUID requestId/message and operator-only internal boolean. Customer reads omit assignment/internal notes.\n- Meter PUT: id/entitlement/period/description/archived/revision. Period lifetime/daily/monthly; entitlement must be numeric. Credentials POST: name/permissions (usage:read, usage:consume); secret is returned once.\n- Usage summary: licenseId/meterId. Consume adds positive safe-integer units and UUID eventId. Atomic quota enforcement; stable events remain idempotent across UTC periods.\n- Backups GET: jobs/destinations with individual schedules and credential readiness (no credential values). POST: destination local/s3/r2/uploadthing or custom UUID ID; HTTP 202 job. Destination POST: name/url/method POST or PUT/format multipart or raw/fileField, optional paired headerName/headerValueEnv (LICENSE_BACKUP_CUSTOM_ variable). Destination PUT also requires revision; archived disables its schedule. Per-destination schedule PUT: enabled/hourUTC/minuteUTC/retentionDays/revision. Existing schedule PUT also accepts destination. Upload-only endpoints retain a local download copy; failed uploads can be downloaded if snapshot creation succeeded. Download routes return binary snapshots or encrypted archives, not JSON.\n- Diagnostics POST: token. Returns untrusted payload plus signatureValid/schemaValid/currentAuthorization/serverTime; it does not mint authorization.\n\nList routes use q/limit/offset (limit at most 200), with additional status/category/urgency/licensed filters where applicable. Audit uses limit/before/licenseId and returns nextBefore. Licenses include masked keyReference and keyStored, never a hash or encrypted key. Installation links include released history and current authorization. Public key discovery includes pending/retired keys; trust must be established separately.\n\n## Registered routes\n\nThe table is generated from an isolated server's route registration. Product-scoped paths use :productId; :id is the relevant record ID.\n\n" +
    table +
    errors,
);
console.log(
  "Documented " + routes.length + " registered routes and " + codes.size + " domain errors.",
);
