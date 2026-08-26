# Keyforge

A self-hostable product-key server you can read in an afternoon: signed
offline license tokens, activation seats, an install census, and an admin
console — one process, deployable on a free tier. Download it, configure it
with one JSON file, and ship licenses for your app. MIT licensed.

Built with Fastify, Kysely over **SQLite or Postgres**, and Ed25519
signatures. The web console is React (Vite + Tailwind + TanStack Query) with
[Better Auth](https://better-auth.com) session login.

**It is not DRM.** Offline licensing keeps honest customers honest. A
determined user can patch the public key out of their own copy of your app,
and Keyforge does not pretend otherwise — see
[how verification works](docs/verify-token.md) for exactly what the guarantee
is and where it stops.

## How it works

The service holds the only copy of the vendor's Ed25519 private key. Every
answer an installation receives — active, expired, even revoked — arrives as a
**signed token** the app verifies against an embedded public key, so a spoofed
license server can answer requests all day without ever minting a token the
app will accept.

- **Product keys** (`KEY-XXXXX-…`, format configurable) are stored as SHA-256
  hashes only. The plaintext key appears exactly once, in the issue response.
- **Entitlements are yours to define.** A license carries freeform key/value
  entitlements — a usage allowance, seat counts, feature flags, a tier name —
  signed into every token verbatim. The server never interprets them; your
  app enforces the ones it cares about. Use-cases are just shapes: count-based
  = a numeric entitlement, time-based = an expiry, editions = flags.
- **Activations** bind a key to an installation id. Limits are enforced at
  activation; releasing a binding (transfer) frees the seat.
- **Tokens** carry the entitlement (plan, allowance, expiry) plus an offline
  grace window, after which the app must revalidate against this service.
- **Installations register on install.** The installer requires internet and
  reports every install — licensed or not — with optional user details, so the
  vendor can compare the installed base against licenses actually issued.
  Entering a key during installation is optional; when entered, the installer
  validates it (`/v1/validate`) without consuming a seat, and activation binds
  it afterwards.
- **Usage is out of scope by design**: the ledger knows where the app is
  installed and where keys are activated, never what customers do with the
  product.

## Quick start

Scaffold a server already configured for your product:

```bash
npm create keyforge@latest my-license-server
```

It asks for a product name, a database, a licensing model, and how much of the
operator admin surface to expose — then writes `keyforge.config.json`, generates
real secrets into `.env.local`, and hands you the next three commands. Every
answer is also a flag, so `--db postgres --auth full --use-case time -y` skips
the questions entirely. See [packages/create-keyforge](packages/create-keyforge)
for the full list.

Or clone this repository and configure it by hand:

```bash
npm install
npm run license keygen              # one-time: generate the signing keypair
cp .env.example .env.local          # then fill in the values below
npm run build:all                   # server → dist/, console → dist/public
npm run admin:create -- --email you@example.com --password "long secret"
npm run start
```

The console is served at `/`, the health check at `/healthz`.

## Configuration

Policy lives in an optional JSON file — `keyforge.config.json` (or the path
in `LICENSE_CONFIG`); see `keyforge.config.example.json` for every knob:
branding, key format, offline grace, rate limits, plan presets (entitlements,
duration, seats), the install census and its user-info collection, and the
audit/backup features. Anything omitted takes a sensible default; an invalid
file refuses to boot rather than half-applying.

Secrets stay in environment variables (`.env.local` is loaded automatically
by every npm script; see `.env.example`).

| Variable | Required | Purpose |
| --- | --- | --- |
| `LICENSE_SIGNING_KEY` / `LICENSE_SIGNING_KEY_FILE` | yes | Ed25519 private key (PEM inline, or path). `npm run license keygen` writes to the `_FILE` path. The service refuses to start without it. |
| `LICENSE_ADMIN_TOKEN` | no | Bearer token for the CLI. Absent → CLI admin access disabled (503). |
| `LICENSE_AUTH_SECRET` | no | Session-cookie secret for the web console. Absent → console login disabled (503). |
| `LICENSE_PORT` / `LICENSE_HOST` | no | Defaults: `4100` / `0.0.0.0`. When `LICENSE_PORT` is unset, a platform-assigned `PORT` is used — that is how Fly, Railway and Koyeb hand out ports. |
| `DATABASE_URL` | no | `postgres://…` runs the ledger on Postgres (operators too). Unset = SQLite, which is the default. Works with any provider — Neon, Supabase, Render, your own. |
| `LICENSE_DB_POOL_MAX` | no | Connections per Postgres pool. Default `5`; the process opens two (ledger, operators). |
| `LICENSE_DB_PATH` | no | SQLite ledger location. Default `licenses.sqlite`. Ignored on Postgres. |
| `LICENSE_AUTH_DB_PATH` | no | Console users/sessions DB. Default: `auth.sqlite` beside the ledger. |
| `LICENSE_SEED_ADMIN_EMAIL` / `LICENSE_SEED_ADMIN_PASSWORD` | no | Seed this operator at boot if missing. Idempotent — an existing user's password is never changed. |
| `LICENSE_CONFIG` | no | Path to the policy JSON. Default `./keyforge.config.json`. |
| `LICENSE_SERVER_URL` | no | Public origin — used by the CLI as the target, and by the console for cookie origin checks. |

Both admin surfaces fail closed: an unset secret disables that surface
rather than leaving it open.

## Admin console

Sign-up is disabled on the running service. The first operator is provisioned
by hand with `npm run admin:create` (which writes to the auth database
directly, so it must run on the machine hosting the service), or seeded at boot
via `LICENSE_SEED_ADMIN_EMAIL` / `LICENSE_SEED_ADMIN_PASSWORD` — the right
choice for hosts without shell access or with ephemeral disks. After that,
admins add operators from the **Operators** page.

### Roles

| | `admin` | `support` |
| --- | --- | --- |
| Read licenses, installations, audit | yes | yes |
| Release an activation (seat transfer) | yes | yes |
| Issue, edit, revoke licenses | yes | no |
| Download database backups | yes | no |
| Manage operators | yes | no |

Roles are enforced **server-side** (403 `insufficient_role`), not by hiding
buttons — a support operator crafting the request by hand is refused too. The
CLI's `LICENSE_ADMIN_TOKEN` predates roles and acts as an admin.

Operator management uses Better Auth's admin plugin, scoped by `auth.admin` in
the config: `"core"` (the default) enables operator and session management;
`"full"` adds bans and impersonation; an array (`["operators","bans"]`) picks
features individually. Endpoints behind a disabled feature answer 404 —
switching impersonation off actually switches it off.

The console covers:

- **Licenses** — server-side search, status filter, and pagination; summary
  counts; issue flow with a one-time key reveal; edit customer / seat limit /
  expiry; revoke; release individual activations for transfer.
- **Installations** — the installed base as the installer reports it:
  licensed vs unlicensed counts against licenses issued, per-install user
  info, app version, platform, and last-seen; searchable and paginated.
- **Inspector** — paste a token an installation holds to read what it claims
  (decoded in the browser; signature verification stays in the app).
- **Audit** — append-only log of every admin action. Operators appear by
  email; actions taken with the shared CLI token are recorded as `cli`.
- **Operators** (admins only) — add operators, change roles, set passwords,
  review and revoke their sessions; ban and impersonate when those features are
  enabled.
- **Settings** — change your operator password (revokes other sessions), and
  download consistent snapshots of the license and auth databases; scheduled
  off-site backups will build on the same endpoints.

For UI development, `npm --prefix ui run dev` starts Vite on
`http://localhost:5173` and proxies API calls to a local server on port 4100.

## Admin CLI

```bash
npm run license -- issue --allowance 200000 --to "Customer Name" \
    [--plan standard] [--activations 1] [--expires 2027-12-31]
npm run license -- list
npm run license -- inspect <token>
npm run license -- revoke <licenseId>
npm run license -- activations <licenseId>
npm run license -- deactivate <licenseId> --installation <installationId>
npm run license -- keygen
```

All commands except `keygen` and `inspect` talk to the deployed service's
admin API; point them at production with `LICENSE_SERVER_URL` and
`LICENSE_ADMIN_TOKEN`.

## API

Public (called by installations):

| Route | Purpose |
| --- | --- |
| `POST /v1/register` | Installer census: record an install (id, app version, platform, optional user name/email). Rate-limited. |
| `POST /v1/validate` | Check a product key — status, plan, seats available — without binding a seat. Rate-limited. |
| `POST /v1/activate` | Bind a product key to an installation; returns a signed token. Rate-limited. |
| `POST /v1/refresh` | Re-issue the token for an existing activation (also how revocation reaches the app); bumps the installation's last-seen. |
| `POST /v1/deactivate` | Release this installation's binding. |

Admin (bearer token **or** console session):

| Route | Purpose |
| --- | --- |
| `GET /admin/licenses` | List; supports `q`, `status`, `limit`, `offset`. |
| `POST /admin/licenses` | Issue. The response is the only place the key ever appears. |
| `GET /admin/licenses/:id` · `PATCH …/:id` | Detail; edit customer, seat limit, expiry. |
| `POST /admin/licenses/:id/revoke` | Revoke (permanent). |
| `GET /admin/licenses/:id/activations` · `POST …/:id/deactivate` | Activation history; release a seat. |
| `GET /admin/installations` | Installed-base census; supports `q`, `licensed=yes|no`, `limit`, `offset`. |
| `GET /admin/audit` | Audit log, cursor-paginated. |
| `GET /admin/backup/licenses` · `GET /admin/backup/auth` | Download a consistent SQLite snapshot (online backup API); audited. |

## Databases

SQLite by default: one file, no server, plenty for the scale most vendors
reach. Set `DATABASE_URL=postgres://…` and the same service runs on Postgres
instead — ledger and operator accounts both — for durability or multiple
processes. Schema migrations run automatically at boot on either engine, so
switching is a config change, and an existing SQLite deployment keeps working
untouched.

Any Postgres provider works; [docs/deploy.md](docs/deploy.md) has a Neon recipe
covering the pooled endpoint and what a compute that suspends after five idle
minutes means for a service that is idle most of the time. TLS is resolved by
this service rather than left to the driver's version-dependent default, and
boot migrations take a transaction-scoped advisory lock so two instances
starting together cannot race.

Backups differ by engine: SQLite gets consistent snapshots from the console,
Postgres uses `pg_dump`. `npm run db` covers what neither does — copying a
whole ledger between databases in either direction, and keeping a standby in
step with `mirror` and `verify`. A mirror is a backup, not a replica, and
promoting one is a decision you make by hand. See
[docs/backups.md](docs/backups.md).

## Deployment

Scaffolding with `--deploy <target>` writes that host's manifest — named after
*your* project — and leaves the others out:

| `--deploy` | Cost | Keeps data? |
| --- | --- | --- |
| `local` (default) | — | Yes, on your disk |
| `docker` | Whatever the box costs | Yes, named volumes |
| `render` | Free web service tier | **No** on free — no persistent disk |
| `fly` | Trial credit, then pay-as-you-go | Yes, with a volume |
| `railway` | Trial credit, then ~$5/mo | Only with a volume |
| `koyeb` | One free instance per org | **No** — no persistent volume |
| `cpanel` | Hosting you already pay for | Yes |

On a host with no persistent disk, a SQLite ledger is empty again after every
deploy — licenses, activations, audit log and operator accounts alike. Use
`DATABASE_URL` with managed Postgres there; boot-time seeding
(`LICENSE_SEED_ADMIN_*`) at least recreates the operator. The scaffolder says
so out loud when you pick that combination.

Hosts that assign a port pass it as `PORT`, which the service reads whenever
`LICENSE_PORT` is unset. Full recipes, secrets and caveats per host:
[docs/deploy.md](docs/deploy.md).

## Project layout

```
src/            Fastify service: routes, config, SQLite ledger, signing, auth
scripts/        Admin CLI (license-tool), ledger copying (db-tool), operator seeding
ui/             Admin console (React + Vite), built into dist/public
                (dist/ is generated by `npm run build:all`, not tracked)
packages/       create-keyforge, the `npm create keyforge` scaffolder
test/           node:test suite (npm test) exercising the API end to end
docs/           API and CLI reference, token verification, deploy recipes, backups
```

`npm run typecheck` covers the service, tests, and console; `npm test` runs the
API suite against in-memory SQLite and scaffolds a project end to end, checking
what the scaffolder writes against this service's own config schema. Consuming
apps verify tokens with the embedded public key — see `docs/verify-token.md`.

## Reference

Every endpoint and every command, with required and optional parameters and
what comes back on success and on failure:

- **[docs/api.md](docs/api.md)** — the HTTP API. `/v1/*` is what your
  application calls on customers' machines; `/admin/*` is what you call.
  Includes the full error-code table.
- **[docs/cli.md](docs/cli.md)** — `npm run license`, `npm run db` and
  `npm run admin:create`.
- **[docs/verify-token.md](docs/verify-token.md)** — how your application
  verifies a token with the embedded public key. The shortest doc here and
  the one to read first if you are deciding whether to trust this.

If tokens are being rejected in the field, start with
`npm run license -- keycheck --expect <your app's public key>`: it compares the key
this service signs with against the one your app verifies against, which is the
one mismatch that looks like success on the server and failure everywhere else.

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for how we behave here. Report
vulnerabilities privately per [SECURITY.md](SECURITY.md) — never in a public
issue. Licensed [MIT](LICENSE).
