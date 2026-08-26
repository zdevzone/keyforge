# CLI reference

Three commands, each for a different job:

| Command | Talks to | For |
|---|---|---|
| `npm run license` | The running service's admin API | Selling and supporting licenses |
| `npm run db` | Databases at rest | Copying, mirroring and comparing ledgers |
| `npm run admin:create` | The auth database directly | Creating the first console operator |

`npm run license` goes through the **admin API** rather than the database on
purpose: the service's ledger is the source of truth, and a second tool writing
to it directly would eventually disagree with it. `npm run db` is the exception,
and it operates on databases that are *not* being served.

## Passing flags through npm

**Always put `--` after the script name.** npm treats `--flags` as its own
unless you separate them, and it does so silently:

```bash
npm run license issue --plan pro --to "Acme Ltd"      # WRONG — npm eats all three
npm run license -- issue --plan pro --to "Acme Ltd"   # right
```

This one is worth dwelling on, because it does not look like a failure. The
first form **succeeds**: it issues a license on the default plan, to nobody, with
no entitlements, and prints a product key you can go and sell. There is no error
to notice. `npm run db` has the same trap with a kinder outcome — it reports a
missing `--from` and stops.

Every example below uses the form that works.

## Environment

Loaded from `.env.local` automatically when present.

| Variable | Used by | Purpose |
|---|---|---|
| `LICENSE_SERVER_URL` | `license` (all but `keygen`, `keycheck`, `inspect`) | Where the service is |
| `LICENSE_ADMIN_TOKEN` | `license` (same) | The token the service was started with |
| `LICENSE_SIGNING_KEY_FILE` | `license keygen`, `keycheck` | Path to the private key PEM |
| `LICENSE_SIGNING_KEY` | `license keycheck` | The PEM inline, as an alternative |
| `DATABASE_URL` | `db` | Default `--from` when set |
| `LICENSE_DB_PATH` | `db` | Default `--from` when `DATABASE_URL` is not set |
| `LICENSE_AUTH_SECRET` | `admin:create` | Required; the console's cookie secret |
| `LICENSE_AUTH_DB_PATH` | `admin:create` | Auth database location |

Commands that need the service exit 1 with
`Set LICENSE_SERVER_URL and LICENSE_ADMIN_TOKEN to talk to the service.` when
either is missing.

---

# `npm run license`

## `keygen`

```
npm run license -- keygen [--force]
```

Generate the Ed25519 signing keypair. Run once, ever.

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--force` | no | off | Overwrite an existing key file |

Writes the private key to `LICENSE_SIGNING_KEY_FILE` (default
`./license-signing.key`, gitignored) and prints the public half.

**Success**

```
Private key written to ./license-signing.key — keep it with the license service only.
  Deploy it as LICENSE_SIGNING_KEY_FILE (or inline as LICENSE_SIGNING_KEY).

Paste this as LICENSE_PUBLIC_KEY in server/license.ts:

"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA…\n-----END PUBLIC KEY-----\n"

Fingerprint: 43:5f:fe:d0:fb:72:36:ee
Check it any time with: npm run license keycheck
```

**Failure** — exit 1 when the file exists and `--force` was not given:

```
./license-signing.key already exists. Pass --force to overwrite — this INVALIDATES every
license ever signed with the old key. You almost never want that.
```

> Regenerating invalidates every license ever issued. Every installed copy of
> your app verifies with the old public key and will reject every new token.

---

## `keycheck`

```
npm run license -- keycheck [--expect <pem-or-file>] [--token <token>] [--server]
```

Validate the signing key this deployment is configured with, and prove it is
the key your app expects.

Worth running whenever you deploy to a new host, rotate an environment
variable, or cannot explain why tokens are being rejected in the field.

| Flag | Required | Type | Meaning |
|---|---|---|---|
| `--expect` | no | PEM text or a path | Compare against the public key your app embeds |
| `--token` | no | string | Verify a real issued token against this key |
| `--server` | no | — | Compare with the fingerprint the deployed service reports |

`--server` needs `LICENSE_SERVER_URL` and `LICENSE_ADMIN_TOKEN`. Everything
else works offline. Requires `npm run build` first.

**Success** (exit 0)

```
Algorithm    ed25519
Fingerprint  43:5f:fe:d0:fb:72:36:ee

-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXpPcHr3saXP5Cx9gnm3+nxS3KNmRbuHl3YxNsLdPtBo=
-----END PUBLIC KEY-----

--expect     matches this key.
--token      verifies against this key.
--server     https://license.example.com signs with this same key.
```

**Failures** — all exit 1. Each check is independent, so one failure never hides
another.

A mismatch against your app's key — the silent one, where issuing appears to
work and every token fails on the customer's machine:

```
--expect     MISMATCH
  this service signs with  43:5f:fe:d0:fb:72:36:ee
  your app expects         de:fc:bc:6d:32:49:b4:1d
  Tokens from this server will fail verification in your app.
```

```
--token      REJECTED: The signature does not match this public key.
```

```
--server     MISMATCH
  local key      43:5f:fe:d0:fb:72:36:ee
  deployed key   de:fc:bc:6d:32:49:b4:1d
```

An unusable key, reported with its cause rather than a stack trace:

```
Signing key unusable: The signing key is rsa, but license tokens are signed with Ed25519. Generate one with: npm run license keygen
Signing key unusable: That is a PUBLIC key. The service signs with the PRIVATE half — the public key is the one you embed in your app.
Signing key unusable: The signing key has escaped newlines (\n) but no real ones, so it is a single line and cannot be parsed.
```

The service refuses to start on any of these, so they surface at deploy time
rather than on your customers' first activation.

---

## `issue`

```
npm run license -- issue [--plan standard] [--to "Name"] [--activations 1]
                         [--expires 2027-12-31] [--allowance 200000]
                         [--entitlements '{"seats":5,"pro":true}']
```

Create a license and print its product key.

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--plan` | no | `licenses.defaultPlan` | Preset supplying entitlements, duration, seats |
| `--to` | no | `""` | Who it is issued to |
| `--activations` | no | preset, else config default | Seats |
| `--expires` | no | preset's duration, else never | ISO date |
| `--allowance` | no | — | Sugar for an `allowance` entitlement |
| `--entitlements` | no | the preset's | JSON object; explicit values beat the preset |

**Success**

```
License 9c1e4d2a-… (pro; seats=5, exports=true)
Issued to: Acme Ltd

Product key — shown once, store it now:

  KEY-ABCDE-FGHIJ-KLMNO-PQRST
```

> The key is displayed here and nowhere else, ever. The ledger keeps only its
> hash. Lose it and the license must be revoked and reissued.

**Failure** — exit 1.

```
--entitlements must be a JSON object, e.g. '{"seats":5}'.
400 bad_activation_limit: activationLimit must be a positive integer.
403 insufficient_role: This action requires an admin operator; your role is support.
```

---

## `list`

```
npm run license -- list
```

No flags. One line per license: id, status, plan, recipient, entitlements.

```
9c1e4d2a-…  active   pro       Acme Ltd     seats=5,exports=true
3f7b1c88-…  revoked  standard  Beta Testing
```

Prints `(no licenses issued yet)` when the ledger is empty. Exit 0 either way —
an empty ledger is an answer, not an error.

---

## `inspect`

```
npm run license -- inspect <token-or-payload>
```

Decode a token's payload. Takes the whole token or just its first half. Works
offline; needs no service and no key.

**Success**

```json
{
  "v": 2,
  "licenseId": "9c1e4d2a-…",
  "plan": "pro",
  "entitlements": { "seats": 5 },
  "issuedTo": "Acme Ltd",
  "installationId": "5f3a…",
  "issuedAt": "2026-08-26T09:20:00.000Z",
  "expiresAt": null,
  "offlineGraceUntil": "2026-09-25T09:20:00.000Z",
  "status": "active"
}
```

```
(decoded only — the app verifies the signature, this tool does not)
```

> `inspect` does **not** check the signature — a forged payload decodes just as
> happily. To confirm a token is genuinely signed by this service's key, use
> `keycheck --token`.

**Failure** — exit 1: `That does not decode as a license token.`

---

## `revoke`

```
npm run license -- revoke <licenseId>
```

Takes the license **id**, not the product key.

```
Revoked 9c1e4d2a-… at 2026-08-26T09:40:00.000Z.
Installations learn of it on their next refresh; imports stop there.
```

**Failure** — exit 1: `404 unknown_license: No such license.`

---

## `activations`

```
npm run license -- activations <licenseId>
```

Where a license is bound, live and released.

```
5f3a…  2026-08-26T09:20:00.000Z  active
9b2c…  2026-08-20T11:02:00.000Z  released 2026-08-25T14:31:00.000Z
```

Prints `(never activated)` when there are none.

---

## `deactivate`

```
npm run license -- deactivate <licenseId> --installation <installationId>
```

Release a binding so the key can activate elsewhere — the transfer path when a
customer cannot reach their old machine.

| Flag | Required | Meaning |
|---|---|---|
| `--installation` | **yes** | Which binding to release |

```
Binding released. The key can now activate on another installation.
```

**Failure** — exit 1:

```
Usage: license deactivate <licenseId> --installation <installationId>
```

---

# `npm run db`

Operates on databases at rest, in either direction, across engines. A target is
a `postgres://` URL or a SQLite file path. Requires `npm run build` first; it
uses the compiled server code, and says so rather than failing on a missing
module.

Only the four ledger tables travel — licenses, installations, activations,
audit log. Operator accounts belong to Better Auth and come back through
boot-time seeding (`LICENSE_SEED_ADMIN_EMAIL` / `LICENSE_SEED_ADMIN_PASSWORD`).

## `copy`

```
npm run db -- copy --from <url|file> --to <url|file> [--replace]
```

| Flag | Required | Meaning |
|---|---|---|
| `--from` | **yes** | Source. Never written to — not even migrated |
| `--to` | **yes** | Destination. Migrated first, then written in one transaction |
| `--replace` | no | Permit overwriting a destination that already holds rows |

**Success**

```
Copying ./licenses.sqlite -> postgres://user@host/neondb
  licenses             128
  installations        412
  activations          96
  audit_log            1043
1679 rows copied sqlite -> postgres.
```

**Failures** — exit 1.

```
Destination already holds 128 licenses. Pass --replace to overwrite it.
Source and destination are the same database (./licenses.sqlite). That would empty it, not copy it.
No such SQLite database: ./typo.sqlite
```

Connection strings are printed with the password removed, because this output
lands in cron mail and CI logs.

## `mirror`

```
npm run db -- mirror --to <url|file> [--from <url|file>]
```

A copy aimed at a standby, safe on a schedule.

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--to` | **yes** | — | The standby |
| `--from` | no | `DATABASE_URL`, else `LICENSE_DB_PATH` | This deployment's own database |

`--replace` is implied — overwriting the standby every run is what a mirror is.

```
Mirroring postgres://user@host/neondb -> ./standby/licenses.sqlite
  …
This is a backup, not a replica — it is as old as this run.
```

## `verify`

```
npm run db -- verify --from <url|file> --to <url|file>
```

Compare row counts and a per-table content checksum. `--from` defaults to this
deployment's database, as with `mirror`.

**Identical** — exit 0:

```
  licenses             128     128  ok
  audit_log           1043    1043  ok

Identical.
```

**Different** — exit 1, naming the first divergence per table so cron tells you
what changed rather than only that something did:

```
  licenses             3       3  MISMATCH
    licenses id=5565bad6…: status is "revoked" in the source, "active" in the destination
  audit_log            4       3  MISMATCH
    audit_log id=4 is missing from the destination
```

See [backups.md](backups.md) for scheduling and the promotion procedure.

---

# `vp` — the Vite+ toolchain

Development only. Nothing in the deployed artifact needs `vp`: the server is
compiled by `tsc`, and the Docker image never installs it.

`vite-plus` is a devDependency, so `npm ci` puts a local `vp` in
`node_modules/.bin` and the npm scripts below resolve it. A global install
(`curl -fsSL https://vite.plus | bash`) is optional and only buys you the bare
`vp` command outside npm scripts.

| Script | Runs | For |
|---|---|---|
| `npm run lint` | Oxlint | Correctness and a11y rules |
| `npm run fmt` | Oxfmt | Formats in place |
| `npm run check` | lint + `fmt --check` + typecheck | What CI runs |

Configuration lives in `vite.config.ts` at the repo root (`lint` and `fmt`
blocks only — the root is a Fastify service, not a Vite app) and in
`ui/vite.config.ts` for the console, which is a real Vite project.

## What stays off Vite+, and why

- **The server build stays `tsc`.** `scripts/create-admin.mjs`,
  `scripts/db-tool.mjs` and `scripts/license-tool.mjs` import compiled modules
  by path (`../dist/src/<name>.js`). That works because tsc emits a plain
  unbundled tree; a bundler collapses it and breaks all three — on the cPanel
  host that cannot rebuild.
- **Tests stay on `node:test`.** They run against SQLite *and* Postgres through
  `fastify.inject`. Vitest would add risk to the dual-engine coverage and buy
  nothing.

## If you re-run `vp migrate`

It writes a `devEngines.packageManager` block with `onFail: "download"`. That
mode needs npm 11+; **npm 10 rejects it outright** and `npm install` exits 1
before any code runs, which takes CI and the Docker build down with it. Both
`package.json` files here set `onFail: "warn"` instead — npm 12 is still
declared and still announced, without blocking anyone on an older npm.

Check it after any migration:

```bash
node -p "require('./package.json').devEngines.packageManager.onFail"
node -p "require('./ui/package.json').devEngines.packageManager.onFail"
```

`vp migrate` also aliases `vite` to `npm:@voidzero-dev/vite-plus-core` with a
matching `overrides` entry. That is expected — Vite+ ships its own Vite core.

---

# `npm run admin:create`

```
npm run admin:create -- --email you@example.com --password "long secret" [--name "You"]
```

Create the first console operator. Writes to the auth database directly, since
there is no operator yet to authenticate as.

| Flag | Required | Default |
|---|---|---|
| `--email` | **yes** | — |
| `--password` | **yes** | — |
| `--name` | no | the email |

Needs `LICENSE_AUTH_SECRET` set.

**Success**

```
Admin user you@example.com created in ./auth.sqlite.
```

Running it again is safe and changes nothing:

```
Admin user you@example.com already exists in ./auth.sqlite — nothing changed.
```

**Failure** — exit 1.

```
Usage: npm run admin:create -- --email you@example.com --password "long secret" [--name "You"]
Set LICENSE_AUTH_SECRET (a long random string) in the environment first.
Could not create you@example.com: <reason>
```

For deployments where running a command is awkward, `LICENSE_SEED_ADMIN_EMAIL`
and `LICENSE_SEED_ADMIN_PASSWORD` seed the same operator at boot. That is also
how operators come back after promoting a mirrored database.
