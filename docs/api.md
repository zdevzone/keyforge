# HTTP API reference

Every endpoint this service exposes, what it requires, and what it returns when
it works and when it does not.

There are two surfaces, and they exist for different callers:

- **`/v1/*` — the device API.** Called by your application, on your customers'
  machines. No credentials: the product key *is* the credential. Rate limited.
- **`/admin/*` — the operator API.** Called by you, from the console or the
  CLI. Requires an admin token or an operator session.

A fake license server can answer `/v1` requests all day; what it cannot do is
mint a token your app will accept, because that needs the private signing key.
That is why the device API needs no secret and why your server URL does not
need protecting.

---

## Conventions

**Base URL** — wherever the service is deployed. Examples below use
`https://license.example.com`.

**Requests** — `POST` bodies are JSON and need `content-type: application/json`.
Query parameters are used for `GET` filters.

**Timestamps** — ISO 8601 UTC strings (`2027-12-31T00:00:00.000Z`), everywhere,
in both directions. `null` means "no expiry" rather than "unknown".

### Authentication

`/v1/*` takes none.

`/admin/*` accepts either, and one is enough:

```bash
# The CLI's way: the token the service was started with.
curl -H "authorization: Bearer $LICENSE_ADMIN_TOKEN" …

# The console's way: a Better Auth session cookie, sent by the browser.
```

The bearer token predates roles and is the vendor's own key, so it always counts
as **admin**. A session carries the operator's role: `admin` or `support`. An
operator with no role recorded is treated as `support` — unknown authority is
never full authority.

| Role | Can | Cannot |
|---|---|---|
| `admin` | Everything | — |
| `support` | Read licenses, installations, activations, audit; release an activation | Issue, edit, revoke; download backups; manage operators |

With no `LICENSE_ADMIN_TOKEN` **and** no auth configured, the admin API answers
`503 admin_disabled` rather than being open. Misconfiguration fails closed.

### Errors

Every failure has the same shape:

```json
{ "error": "unknown_key", "message": "That product key was not recognised." }
```

`error` is a stable identifier — match on it. `message` is written for a human
and may be reworded.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `bad_request` | A required field is missing or empty |
| 400 | `bad_activation_limit` | `activationLimit` is not a positive integer |
| 400 | `bad_entitlements` | Entitlements are not an object of number/string/boolean |
| 400 | `bad_expiry` | `expiresAt` is neither an ISO date nor `null` |
| 400 | `bad_status` | `status` filter is not `active`, `expired` or `revoked` |
| 400 | `bad_licensed` | `licensed` filter is not `yes` or `no` |
| 400 | `bad_limit` | `limit` is not a positive integer |
| 400 | `bad_offset` | `offset` is not a non-negative integer |
| 400 | `bad_cursor` | `before` is not a valid audit cursor |
| 401 | `admin_unauthorized` | No valid admin token or session |
| 403 | `insufficient_role` | Valid session, but the action needs `admin` |
| 403 | `not_activated_here` | That installation holds no active binding |
| 404 | `unknown_key` | No license has that product key |
| 404 | `unknown_license` | No license has that id |
| 404 | `not_found` | No such route |
| 404 | `registry_disabled` | The install census is switched off |
| 404 | `audit_disabled` | The audit log is switched off |
| 404 | `backups_disabled` | Backups are switched off |
| 404 | `unknown_database` | Backup target is not `licenses` or `auth` |
| 404 | `admin_feature_disabled` | That Better Auth admin surface is not enabled |
| 409 | `activation_limit_reached` | Every seat is in use |
| 410 | `license_revoked` | The license was revoked |
| 410 | `license_expired` | The license passed its expiry |
| 501 | `backup_unsupported` | Online backup needs SQLite; this runs on Postgres |
| 503 | `admin_disabled` | No admin token and no auth configured |
| 503 | `auth_disabled` | The console/auth database is not configured |

`unknown_key` and `license_revoked` are deliberately different answers. A
customer mistyping their own key needs to hear that, not a refund question.

### Rate limits

Applied per IP, configurable under `limits` in `keyforge.config.json`, and
switchable off entirely with `limits.enabled: false`.

| Endpoint | Default |
|---|---|
| `POST /v1/activate` | 20 per minute |
| `POST /v1/validate` | 20 per minute |
| `POST /v1/register` | 30 per minute |

`/v1/refresh` and `/v1/deactivate` are not rate limited: a client that has
already activated is not the attack surface a limiter is for.

---

# Device API — `/v1`

## `POST /v1/register`

The install census. Call it on every install, licensed or not, so you can
compare installs against licenses actually sold. Re-registering is a cheap
upsert, so calling it more than once is safe.

| Field | Required | Type | Notes |
|---|---|---|---|
| `installationId` | **yes** | string | Your stable per-machine id. Trimmed, capped at 200 chars |
| `appVersion` | no | string | Capped at 50 chars |
| `platform` | no | string | Capped at 100 chars |
| `userName` | no | string | Ignored when `registry.collectUserInfo` is false |
| `userEmail` | no | string | Ignored when `registry.collectUserInfo` is false |

```bash
curl -X POST https://license.example.com/v1/register \
  -H 'content-type: application/json' \
  -d '{"installationId":"5f3a…","appVersion":"2.1.0","platform":"win32"}'
```

**200**

```json
{ "ok": true, "licensed": false }
```

`licensed` reports whether this installation is already tied to a license.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | `installationId` missing or empty |
| 404 | `registry_disabled` | `registry.enabled` is false — old installers fail cleanly rather than half-working |

---

## `POST /v1/validate`

Is this key any good, and are there seats left? **Reads only** — validating
during install never consumes a seat. Use it for instant feedback on a key
field before the customer commits.

| Field | Required | Type |
|---|---|---|
| `key` | **yes** | string — the product key, any case, trimmed |

```bash
curl -X POST https://license.example.com/v1/validate \
  -H 'content-type: application/json' -d '{"key":"KEY-ABCDE-FGHIJ-KLMNO-PQRST"}'
```

**200**

```json
{
  "valid": true,
  "plan": "pro",
  "entitlements": { "seats": 5, "exports": true },
  "issuedTo": "Acme Ltd",
  "expiresAt": "2027-12-31T00:00:00.000Z",
  "activationLimit": 3,
  "seatsInUse": 1,
  "seatsAvailable": 2
}
```

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | `key` missing or empty |
| 404 | `unknown_key` | No license with that key |
| 410 | `license_revoked` | Revoked |
| 410 | `license_expired` | Past `expiresAt` |

---

## `POST /v1/activate`

Bind a key to one installation and receive a signed token. This is the call
that consumes a seat.

| Field | Required | Type |
|---|---|---|
| `key` | **yes** | string |
| `installationId` | **yes** | string — the same id you registered |

**Idempotent for the same installation.** Re-activating where the key is already
bound returns a fresh token without consuming another seat, which is what a
reinstall on the same machine needs.

**200**

```json
{ "token": "eyJ2IjoyLCJsaWNlbnNlSWQ….MEUCIQDf…" }
```

The token is `base64url(payload).base64url(signature)`, Ed25519. Verify it in
your app with the embedded public key — see [verify-token.md](verify-token.md)
for the snippet. Payload fields are documented there.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | `key` or `installationId` missing |
| 404 | `unknown_key` | No license with that key |
| 409 | `activation_limit_reached` | Every seat is in use on other installations |
| 410 | `license_revoked` / `license_expired` | Not usable |

---

## `POST /v1/refresh`

Re-issue the token for an existing binding. Call it periodically so the
installation learns about revocation and expiry.

| Field | Required | Type |
|---|---|---|
| `licenseId` | **yes** | string — from the token payload, not the product key |
| `installationId` | **yes** | string |

**200** — `{ "token": "…" }`

The token carries the verdict **whether or not the news is good**: a revoked or
expired license still returns a signed token, with `status` set accordingly.
That is deliberate — the installation persists an *authenticated* refusal rather
than a bare flag anyone could delete, or a response anyone could fake.

| Status | `error` | When |
|---|---|---|
| 404 | `unknown_license` | No license with that id |
| 403 | `not_activated_here` | No active binding for that installation |

---

## `POST /v1/deactivate`

Release this installation's seat so the key can be used elsewhere. The
customer-facing half of a transfer.

| Field | Required | Type |
|---|---|---|
| `licenseId` | **yes** | string |
| `installationId` | **yes** | string |

**200** — `{ "ok": true }`

Releasing a binding that does not exist is **not** an error; the end state is
what was asked for either way.

| Status | `error` | When |
|---|---|---|
| 404 | `unknown_license` | No license with that id |

---

# Operator API — `/admin`

All of these need a bearer token or a session. Roles as per the table above.

## `POST /admin/licenses`

Issue a license. **Admin only.**

| Field | Required | Type | Default |
|---|---|---|---|
| `plan` | no | string | `licenses.defaultPlan` (`standard`) |
| `entitlements` | no | object | The plan preset's entitlements |
| `allowance` | no | number | Sugar for `entitlements.allowance` |
| `issuedTo` | no | string | `""` |
| `activationLimit` | no | positive integer | Preset, else `licenses.defaultActivationLimit` |
| `expiresAt` | no | ISO date or `null` | Preset's `durationDays` from now, else `null` |

Anything sent explicitly beats the preset.

**201**

```json
{
  "license": {
    "id": "9c1e…", "plan": "pro",
    "entitlements": { "seats": 5 },
    "issuedTo": "Acme Ltd", "status": "active", "activationLimit": 3,
    "issuedAt": "2026-08-26T09:12:00.000Z", "expiresAt": null, "revokedAt": null,
    "keyHash": "4f2b…"
  },
  "key": "KEY-ABCDE-FGHIJ-KLMNO-PQRST"
}
```

> **`key` appears in this response and nowhere else, ever.** The ledger stores
> only its SHA-256 hash. If it is lost, the license must be revoked and reissued.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_entitlements` | Not an object of number/string/boolean values |
| 400 | `bad_activation_limit` | Not a positive integer |
| 401/403 | `admin_unauthorized` / `insufficient_role` | Not an admin |

---

## `GET /admin/licenses`

List and search. Either role.

| Parameter | Required | Type | Default |
|---|---|---|---|
| `q` | no | string | Matches id or `issuedTo` |
| `status` | no | `active` \| `expired` \| `revoked` | all |
| `limit` | no | positive integer | server default |
| `offset` | no | non-negative integer | `0` |

**200** — `{ "licenses": [ … ], "total": 128 }`

`status=expired` is computed against the clock, not stored — a license whose
`expiresAt` has passed is still `active` in the database.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_status` / `bad_limit` / `bad_offset` | Bad filter |

---

## `GET /admin/licenses/:id`

One license. Either role. **200** — `{ "license": { … } }`, else `404
unknown_license`.

---

## `PATCH /admin/licenses/:id`

Edit a license. **Admin only.** Every field is optional; anything omitted is
left as it is.

| Field | Type | Notes |
|---|---|---|
| `entitlements` | object | Replaces the whole map, not merged |
| `allowance` | number | Sugar for `entitlements.allowance` |
| `issuedTo` | string | |
| `activationLimit` | positive integer | Lowering it does not release existing seats |
| `expiresAt` | ISO date or `null` | `null` makes it perpetual |

**200** — `{ "license": { … } }`

| Status | `error` | When |
|---|---|---|
| 400 | `bad_entitlements` / `bad_activation_limit` / `bad_expiry` | Invalid value |
| 404 | `unknown_license` | No such license |

---

## `POST /admin/licenses/:id/revoke`

Revoke. **Admin only.** No body.

**200** — `{ "license": { …, "status": "revoked", "revokedAt": "…" } }`

Installations learn of it on their next `refresh`; they do not stop instantly.
An installation offline past its grace window stops on its own.

| Status | `error` | When |
|---|---|---|
| 404 | `unknown_license` | No such license |

---

## `GET /admin/licenses/:id/activations`

Every binding, live and released. Either role.

**200**

```json
{ "activations": [
  { "licenseId": "9c1e…", "installationId": "5f3a…",
    "activatedAt": "2026-08-26T09:20:00.000Z", "deactivatedAt": null }
] }
```

---

## `POST /admin/licenses/:id/deactivate`

Release a seat on the customer's behalf — the transfer path when they can no
longer reach the old machine. **Either role**, because it is the common support
action and it destroys nothing.

| Field | Required | Type |
|---|---|---|
| `installationId` | **yes** | string |

**200** — `{ "ok": true }`

| Status | `error` | When |
|---|---|---|
| 400 | `bad_request` | `installationId` missing |
| 404 | `unknown_license` | No such license |

---

## `GET /admin/installations`

The install census. Either role.

| Parameter | Required | Type | Default |
|---|---|---|---|
| `q` | no | string | Matches installation id, user name or email |
| `licensed` | no | `yes` \| `no` | all |
| `limit` | no | positive integer | server default |
| `offset` | no | non-negative integer | `0` |

**200** — `{ "installations": [ … ], "total": 412 }`

| Status | `error` | When |
|---|---|---|
| 400 | `bad_licensed` / `bad_limit` / `bad_offset` | Bad filter |
| 404 | `registry_disabled` | Census switched off |

---

## `GET /admin/entitlements`

Every entitlement key the ledger actually contains. Either role. No parameters.

Entitlements are free-form, so nothing stops `seats` on one license and `seat`
on the next. This is the endpoint that makes that visible; the console renders
it on the Entitlements page.

**200**

```json
{
  "licensesScanned": 128,
  "catalog": [
    { "name": "seats", "types": ["number"], "licenseCount": 96,
      "activeLicenseCount": 91, "plans": ["pro", "team"],
      "values": [ { "value": "5", "count": 60 }, { "value": "10", "count": 36 } ],
      "moreValues": 0 }
  ]
}
```

`types` with more than one entry means the same key holds different types on
different licenses — an app doing a numeric comparison will handle some and
silently ignore the rest. `moreValues` counts distinct values beyond those
listed, so a capped list never reads as complete.

---

## `GET /admin/config`

What the console needs to render itself. Either role. No parameters.

**200**

```json
{
  "viewer": { "actor": "ops@example.com", "role": "admin" },
  "adminScope": ["operators", "sessions"],
  "branding": { "name": "Keyforge" },
  "features": { "audit": true, "backups": true, "ledgerBackup": true, "registry": true },
  "engine": "sqlite",
  "licenses": { "defaultPlan": "standard", "defaultActivationLimit": 1, "planPresets": { … } },
  "signingKey": {
    "keyType": "ed25519",
    "fingerprint": "43:5f:fe:d0:fb:72:36:ee",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"
  }
}
```

`signingKey` is the **public half only** — the value you embed in your app. The
private key never leaves the server and appears in no response. Compare
`fingerprint` against `npm run license keycheck`; if they differ, the server is
signing with a key your app will not accept.

`ledgerBackup` is false on Postgres, where snapshots come from `pg_dump`.

---

## `GET /admin/backup/:database`

Download a consistent SQLite snapshot, taken through SQLite's online backup API
— safe while the service is running, unlike copying the file. **Admin only.**
Recorded in the audit log.

`:database` is `licenses` or `auth`.

**200** — `application/octet-stream`, `content-disposition: attachment;
filename="licenses-backup-2026-08-26T09-12-00.sqlite"`

| Status | `error` | When |
|---|---|---|
| 404 | `backups_disabled` | `features.backups` is false |
| 404 | `unknown_database` | Not `licenses` or `auth` |
| 501 | `backup_unsupported` | Running on Postgres — use `pg_dump` |
| 503 | `auth_disabled` | No auth database configured |

See [backups.md](backups.md) for scheduling, and for copying a ledger to a
second database.

---

## `GET /admin/audit`

The audit log, newest first. Either role.

| Parameter | Required | Type | Default |
|---|---|---|---|
| `limit` | no | positive integer | server default |
| `before` | no | cursor | from the previous page's `nextBefore` |
| `licenseId` | no | string | Only entries for that license |

**200**

```json
{ "entries": [
    { "id": 412, "at": "2026-08-26T09:12:00.000Z", "actor": "ops@example.com",
      "action": "license.issue", "licenseId": "9c1e…",
      "detail": { "plan": "pro", "activationLimit": 3 } }
  ],
  "nextBefore": 400 }
```

`nextBefore` is `null` on the last page. Pass it back as `before` to continue.

Recorded actions: `license.issue`, `license.update`, `license.revoke`,
`license.deactivate`, `backup.download`.

| Status | `error` | When |
|---|---|---|
| 400 | `bad_limit` / `bad_cursor` | Bad paging |
| 404 | `audit_disabled` | `features.audit` is false |

---

# Service endpoints

## `GET /healthz`

Liveness, for your platform's health check. No auth. **200** — `{ "ok": true }`.

Answers as soon as the process is listening. The signing key is validated
*before* the port binds, so a service that answers here has a usable key.

## `GET /api/meta`

Public deployment identity, for the login page title. No auth.

**200** — `{ "name": "Keyforge" }`

## `ALL /api/auth/*`

Better Auth: sign-in, sign-out, session, password change, and operator
management when enabled. Handled by Better Auth itself rather than defined here
— consult its documentation for shapes.

Answers `503 auth_disabled` when `LICENSE_AUTH_SECRET` is unset, which also
means the console is switched off.

---

## Anything else

Unmatched `GET` requests that are not under `/v1/`, `/admin/` or `/api/` return
the console's `index.html`, so the single-page app can route them. Everything
else gets `404 not_found`.
