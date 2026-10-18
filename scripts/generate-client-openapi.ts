import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { SIGNAL_KINDS } from "../src/machines.js";
import { supportRequestBodySchema } from "../src/support.js";
import {
  licenseTokenSchema,
  trialTokenSchema,
  recoveryTokenSchema,
} from "../src/token-contract.js";

type Schema = Record<string, unknown>;
const string = (extra: Schema = {}): Schema => ({ type: "string", ...extra });
const id = string({ minLength: 1, maxLength: 200 });
const uuid = string({ format: "uuid" });
const timestamp = string({ format: "date-time" });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const boolean: Schema = { type: "boolean" };
const integer: Schema = { type: "integer" };
const array = (items: Schema): Schema => ({ type: "array", items });
const ref = (name: string): Schema => ({ $ref: "#/components/schemas/" + name });
const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
  extra = false,
): Schema => ({ type: "object", properties, required, additionalProperties: extra });
function fromZod(schema: z.ZodType): Schema {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { unrepresentable: "any" });
  return json;
}
const preferences = object({ messages: boolean, expirations: boolean });
const delivery = object(
  {
    id,
    licenseId: id,
    installationId: nullable(id),
    requestId: nullable(id),
    status: string({ enum: ["available", "retrieved", "manual", "failed"] }),
    createdAt: timestamp,
    retrievedAt: nullable(timestamp),
    error: nullable(string()),
  },
  ["id", "licenseId", "installationId", "requestId", "status", "createdAt", "retrievedAt", "error"],
  true,
);
const collected = object({
  key: string(),
  license: object({ id, plan: id, issuedTo: string(), expiresAt: nullable(timestamp) }),
});
const tokenResponse = object({ token: string(), serverTime: timestamp });
const requestInfo = object(
  {
    id: uuid,
    productId: id,
    plan: id,
    name: string(),
    email: string({ format: "email" }),
    status: string({ enum: ["requested", "issued"] }),
    licenseId: nullable(id),
    createdAt: timestamp,
  },
  undefined,
  true,
);
const notification = object(
  {
    id,
    kind: string({ enum: ["reply", "expiration", "license"] }),
    title: string(),
    date: timestamp,
    read: boolean,
    ticketId: id,
    licenseId: id,
    deliveryStatus: string({ enum: ["available", "retrieved", "manual", "failed"] }),
    collectPath: string(),
  },
  ["id", "kind", "title", "date", "read"],
);
const thread = object(
  {
    id,
    revision: integer,
    licenseId: id,
    installationId: id,
    clientRequestId: uuid,
    category: string({ enum: ["technical", "licensing", "billing", "feature_request", "other"] }),
    urgency: string({ enum: ["low", "normal", "high", "critical"] }),
    subject: string(),
    message: string(),
    status: string({ enum: ["queued", "in_progress", "waiting_customer", "resolved", "closed"] }),
    receivedAt: timestamp,
    updatedAt: timestamp,
    reporterName: nullable(string()),
    appVersion: nullable(string()),
    platform: nullable(string()),
    clientCreatedAt: timestamp,
    messages: array(
      object({
        id,
        author: string({ enum: ["customer", "support"] }),
        internal: { const: false },
        body: string(),
        createdAt: timestamp,
      }),
    ),
  },
  [
    "id",
    "revision",
    "licenseId",
    "installationId",
    "clientRequestId",
    "category",
    "urgency",
    "subject",
    "message",
    "status",
    "receivedAt",
    "updatedAt",
    "reporterName",
    "appVersion",
    "platform",
    "clientCreatedAt",
    "messages",
  ],
);
const supportBody = fromZod(supportRequestBodySchema);
const supportProperties = supportBody.properties as Record<string, Schema>;
const schemas: Record<string, Schema> = {
  LicenseToken: fromZod(licenseTokenSchema),
  TrialToken: fromZod(trialTokenSchema),
  UsageRecoveryToken: fromZod(recoveryTokenSchema),
  Error: object(
    { error: string(), message: string(), retryable: boolean, serverTime: timestamp },
    ["error", "message"],
    true,
  ),
  Register: object(
    {
      installationId: id,
      requestId: uuid,
      appVersion: string({ maxLength: 50 }),
      platform: string({ maxLength: 100 }),
      userName: string({ maxLength: 200 }),
      userEmail: string({ maxLength: 200 }),
      machineSignals: {
        description:
          "Registration accepts any JSON and normalizes recognized kind/lowercase SHA-256 pairs, dropping invalid entries and duplicate pairs. Recommended clients send at most three typed signals; unlike backfill this route does not enforce that count.",
      },
    },
    ["installationId", "requestId"],
  ),
  Registration: object({
    ok: { const: true },
    recorded: boolean,
    serverTime: timestamp,
    trial: nullable(object({ token: string() })),
  }),
  KeyOperation: object({ installationId: id, key: string({ minLength: 1 }), licenseId: id }, [
    "installationId",
  ]),
  BoundOperation: object({ installationId: id, key: string({ minLength: 1 }), licenseId: id }, [
    "installationId",
  ]),
  TokenResponse: tokenResponse,
  Preferences: preferences,
  Notification: notification,
  Thread: thread,
  ValidateResponse: object(
    {
      valid: { const: true },
      id,
      plan: id,
      issuedTo: string(),
      expiresAt: nullable(timestamp),
      entitlements: {
        type: "object",
        additionalProperties: { anyOf: [{ type: "number" }, string(), boolean] },
      },
      seatsInUse: integer,
      seatsAvailable: integer,
      serverTime: timestamp,
    },
    [
      "valid",
      "id",
      "plan",
      "issuedTo",
      "expiresAt",
      "entitlements",
      "seatsInUse",
      "seatsAvailable",
      "serverTime",
    ],
    true,
  ),
  SupportCreate: object({ ...supportProperties, licenseId: id }, [
    ...(supportBody.required as string[]),
    "licenseId",
  ]),
  SupportReply: object(
    {
      requestId: uuid,
      revision: integer,
      message: string({ minLength: 1, maxLength: 5000 }),
      internal: { const: false, default: false },
    },
    ["requestId", "revision", "message"],
  ),
  CollectedLicense: collected,
  LicenseRequest: requestInfo,
  LicenseRequestCreate: object({
    id: uuid,
    productId: string({ minLength: 1, maxLength: 60 }),
    plan: id,
    name: string({ minLength: 1, maxLength: 100 }),
    email: string({ format: "email", maxLength: 254 }),
  }),
};
const paths: Record<string, Record<string, unknown>> = {};
function operation(
  method: string,
  path: string,
  name: string,
  description: string,
  response: Schema,
  body?: Schema,
  status = 200,
  auth = "InstallationCredential",
  headers: unknown[] = [],
) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: id,
  }));
  paths[path] ??= {};
  paths[path][method] = {
    operationId: name,
    summary: name.replace(/([A-Z])/g, " $1"),
    description,
    security: auth ? [{ [auth]: [] }] : [],
    parameters: [...parameters, ...headers],
    ...(body
      ? { requestBody: { required: true, content: { "application/json": { schema: body } } } }
      : {}),
    responses: {
      [status]: { description: "Success", content: { "application/json": { schema: response } } },
      default: {
        description: "Failure; inspect error and retryable. Never treat an error as a grant.",
        content: { "application/json": { schema: ref("Error") } },
      },
    },
  };
}
const product = "/v1/products/{productId}",
  installation = product + "/installations/{installationId}";
operation(
  "get",
  "/healthz",
  "getHealth",
  "Unsigned liveness and supported token versions, not a build identifier or authorization grant.",
  object({
    ok: { const: true },
    serverTime: timestamp,
    tokenVersions: object({ min: { const: 1 }, max: { const: 1 } }),
    trialTokenVersions: object({ min: { const: 1 }, max: { const: 1 } }),
    recoveryTokenVersions: object({ min: { const: 1 }, max: { const: 1 } }),
  }),
  undefined,
  200,
  "",
);
operation(
  "get",
  "/v1/meta",
  "getServerMetadata",
  "Public deployment branding and runtime metadata. This unsigned response does not grant application features.",
  object({ name: string(), serverTime: timestamp }),
  undefined,
  200,
  "",
);
operation(
  "get",
  product + "/keys",
  "getProductKeys",
  "Discovery only. Trust must be established through the application's pinned update channel, never by automatically trusting this response.",
  object({
    keys: array(
      object(
        { kid: id, publicKeyPem: string(), retiredAt: nullable(timestamp) },
        ["kid", "publicKeyPem", "retiredAt"],
        true,
      ),
    ),
    serverTime: timestamp,
  }),
  undefined,
  200,
  "",
);
operation(
  "post",
  product + "/register",
  "registerInstallation",
  "Online registration pins a client-generated random 256-bit base64url bearer credential. Persist the credential, body and requestId before sending; replay exactly after interruption. machineSignals are optional hashed hints, not proof of identity. A returned trial must be explicitly selected and verified; registration alone need not enable trial use.",
  ref("Registration"),
  ref("Register"),
);
operation(
  "post",
  product + "/validate",
  "validateKey",
  "Online inspection only; consumes no seat and does not return an offline grant.",
  ref("ValidateResponse"),
  ref("KeyOperation"),
);
operation(
  "post",
  product + "/activate",
  "activateLicense",
  "Online activation binds an installation seat and returns a signed v1 token. Repeating the same key/identity reuses the binding. Verify and atomically persist the grant before enabling features.",
  ref("TokenResponse"),
  ref("KeyOperation"),
);
operation(
  "post",
  product + "/refresh",
  "refreshLicense",
  "Requires an existing binding. HTTP 200 may contain a signed revoked or expired license. Verify and persist negative grants; do not retain old authorization after a verified denial.",
  ref("TokenResponse"),
  ref("BoundOperation"),
);
operation(
  "post",
  product + "/deactivate",
  "deactivateLicense",
  "Online seat release. Clear local authorization after success; no offline seat release is supported.",
  object({ ok: { const: true }, serverTime: timestamp }),
  ref("BoundOperation"),
);
operation(
  "put",
  installation + "/device-signals",
  "updateDeviceSignals",
  "Authenticated recognition-only backfill. Does not register again, merge groups, change trial counters, consume seats or reset usage. Reports hashes only; empty signals preserve historical recognition evidence while current availability becomes unavailable.",
  object({ ok: { const: true }, serverTime: timestamp }),
  object({
    machineSignals: {
      type: "array",
      maxItems: 3,
      items: object({
        kind: string({ enum: [...SIGNAL_KINDS] }),
        hash: string({ pattern: "^[a-f0-9]{64}$" }),
      }),
    },
  }),
);
operation(
  "post",
  installation + "/recovery-requests",
  "requestUsageRecovery",
  "Installation-authenticated request only; never grants recovery without independent admin approval. Persist UUID/challenge before networking, reuse exact body. Send only an optional nonce-bound usage commitment, not usage history.",
  object({ id, status: string({ enum: ["requested", "approved", "claimed", "rejected"] }) }),
  object({
    requestId: uuid,
    licenseId: id,
    challenge: string({ pattern: "^[A-Za-z0-9_-]{43}$" }),
    usageDigest: nullable(string({ pattern: "^[a-f0-9]{64}$" })),
  }),
);
operation(
  "post",
  installation + "/recovery-requests/{id}/claim",
  "claimUsageRecovery",
  "Claims an approved, unexpired recovery once on the server. Exact retries are safe while the generation remains current. Verify the separate recovery signature, challenge, account, generation and candidate commitment before atomically adopting it with the v1 license. Approval expires after 24 hours.",
  object({ recoveryToken: string(), token: string(), serverTime: timestamp }),
);
operation(
  "get",
  installation + "/notifications",
  "getNotifications",
  "Poll while online with backoff; only this installation's public replies, expiration notices and license deliveries are returned. No email or realtime transport.",
  object({ items: array(ref("Notification")), preferences: ref("Preferences") }),
);
operation(
  "put",
  installation + "/notifications/preferences",
  "setNotificationPreferences",
  "Installation-specific preferences. License deliveries are always shown.",
  object({ ok: { const: true } }),
  ref("Preferences"),
);
operation(
  "post",
  installation + "/notifications/read",
  "markNotificationRead",
  "Mark an event read for this installation only.",
  object({ ok: { const: true } }),
  object({ eventId: string({ minLength: 1, maxLength: 500 }) }),
);
operation(
  "post",
  installation + "/licenses/{id}/collect",
  "collectLicense",
  "Retrieve a delivered key for its targeted installation; repeatable. Collection does not activate a license or consume a seat. Never log the returned key.",
  ref("CollectedLicense"),
);
operation(
  "get",
  installation + "/support",
  "listSupportThreads",
  "Returns this installation's cases and public messages. Currently unpaginated; no internal notes or operator assignments.",
  object({ requests: array(ref("Thread")) }),
);
operation(
  "get",
  installation + "/support/{id}",
  "getSupportThread",
  "Retrieve a public thread including revision for replies. Operator authors are presented as support.",
  object({ request: ref("Thread") }),
);
operation(
  "post",
  installation + "/support",
  "createSupportThread",
  "Requires a license binding. Technical/feature/other categories require an active binding; licensing/billing also work with an existing expired/released binding. Trimmed subject is 3–120 characters and message 10–5000. Persist the exact request and UUID before sending; Idempotency-Key must equal requestId.",
  object({
    request: object({ id, clientRequestId: uuid, status: string(), receivedAt: timestamp }),
    serverTime: timestamp,
  }),
  ref("SupportCreate"),
  202,
  "InstallationCredential",
  [{ name: "Idempotency-Key", in: "header", required: true, schema: uuid }],
);
operation(
  "post",
  installation + "/support/{id}/messages",
  "replyToSupportThread",
  "Persist requestId/body across retries. Use the current revision; on revision_conflict retrieve the thread before asking the user to retry. Exact replay returns the existing message even with an old revision. Resolved cases reopen; closed cases require a new case. Customers cannot write internal notes.",
  object({ request: ref("Thread") }),
  ref("SupportReply"),
);
operation(
  "get",
  "/v1/license-request-catalog",
  "getLicenseRequestCatalog",
  "Public product/plan choices for preinstallation requests.",
  object({
    products: array(
      object({ id, name: string(), plans: array(object({ id, description: string() })) }),
    ),
  }),
  undefined,
  200,
  "",
);
operation(
  "post",
  "/v1/license-requests",
  "createLicenseRequest",
  "Separate preinstallation credential: random 256-bit base64url secret, not an installation or admin credential. Exact id/body/secret replay is supported. The public status page keeps this secret in the URL fragment, never a query string.",
  object({ id: uuid, status: { const: "requested" } }),
  ref("LicenseRequestCreate"),
  202,
  "RequestCredential",
);
operation(
  "get",
  "/v1/license-requests/{id}",
  "getLicenseRequest",
  "Only the holder of the private request secret may read status. No customer email account or portal login is implied.",
  object({ request: ref("LicenseRequest"), delivery: nullable(delivery) }),
  undefined,
  200,
  "RequestCredential",
);
operation(
  "post",
  "/v1/license-requests/{id}/collect",
  "collectRequestedLicense",
  "Private-secret retrieval after operator approval. Returned key is activated through the installation API later; pending requests return request_pending.",
  ref("CollectedLicense"),
  undefined,
  200,
  "RequestCredential",
);
for (const consume of [false, true])
  operation(
    "post",
    product + "/usage/" + (consume ? "consume" : "summary"),
    consume ? "consumeUsage" : "getUsage",
    "Trusted backend only. Never embed the product-scoped service credential in a desktop or browser app. Consumption uses a durable UUID eventId and identical units across retries; it does not reset on refresh.",
    object(
      { quota: integer, consumed: integer, remaining: integer },
      ["quota", "consumed", "remaining"],
      true,
    ),
    object({
      licenseId: id,
      meterId: id,
      ...(consume ? { eventId: uuid, units: { type: "integer", minimum: 1 } } : {}),
    }),
    200,
    "ServiceCredential",
  );

export const clientOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "KeyForge dependent-app API",
    version: "1.0.0",
    description:
      "Current product-scoped API. Tokens are two base64url segments (not JWTs); Ed25519 signs the decoded UTF-8 JSON bytes. License, trial and separate usage-recovery payloads use only v1. Import-account fields are explicitly nullable for products without import quotas; no older token format is accepted. Full contextual, time and status checks are required. Private/admin routes are deliberately excluded.",
  },
  servers: [
    {
      url: "https://license.example.com",
      description: "Replace with your KeyForge deployment URL",
    },
  ],
  paths,
  components: {
    schemas,
    securitySchemes: {
      InstallationCredential: {
        type: "http",
        scheme: "bearer",
        description:
          "Client-generated per-installation secret pinned at registration; not the product/license key.",
      },
      RequestCredential: {
        type: "http",
        scheme: "bearer",
        description:
          "Private preinstallation request secret; separate from installation credentials.",
      },
      ServiceCredential: {
        type: "http",
        scheme: "bearer",
        description:
          "Trusted-backend product-scoped usage credential with usage:read/usage:consume permissions.",
      },
    },
  },
};
export const clientOpenApiJson = JSON.stringify(clientOpenApi, null, 2) + "\n";
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = new URL("../docs/client-openapi.json", import.meta.url);
  if (process.argv.includes("--check")) {
    if (JSON.stringify(JSON.parse(readFileSync(target, "utf8"))) !== JSON.stringify(clientOpenApi))
      throw new Error("Run vp run docs:client-api to regenerate the client contract.");
  } else {
    writeFileSync(target, clientOpenApiJson);
    execFileSync("vp", ["fmt", "docs/client-openapi.json"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: "pipe",
    });
  }
}
