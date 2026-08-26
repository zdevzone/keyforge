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

## Quick start

Scaffold a server already configured for your product:

```bash
npm create keyforge@latest my-license-server
```

It asks for a product name, a database, a licensing model, a package manager
and how much of the admin surface to expose, then writes the config, generates
real secrets, and hands you the next commands. Every answer is also a flag, so
`--db postgres --auth full --use-case time -y` skips the questions. See
[packages/create-keyforge](packages/create-keyforge).

Or clone this repository and configure it by hand:

```bash
npm install
npm run license keygen              # one-time: generate the signing keypair
cp .env.example .env.local          # then fill in the values
npm run build:all                   # server → dist/, console → dist/public
npm run admin:create -- --email you@example.com --password "long secret"
npm run start
```

The console is served at `/`, the health check at `/healthz`.

## How it works

The service holds the only copy of your Ed25519 private key. Every answer an
installation receives — active, expired, even revoked — arrives as a **signed
token** the app verifies against an embedded public key. A spoofed license
server can answer requests all day without ever minting a token your app
accepts.

- **Product keys** (`KEY-XXXXX-…`, format configurable) are stored as SHA-256
  hashes. The plaintext appears exactly once, in the issue response.
- **Entitlements are yours to define** — a usage allowance, seat counts,
  feature flags, a tier name — signed into every token verbatim. The server
  never interprets them; your app enforces the ones it cares about. Licensing
  models are just shapes: count-based is a numeric entitlement, time-based is
  an expiry, editions are flags.
- **Activations** bind a key to an installation id. Limits are enforced at
  activation; releasing a binding frees the seat for transfer.
- **Tokens** carry the entitlements plus an offline grace window, after which
  the app must revalidate.
- **Installations register on install**, licensed or not, so you can compare
  the installed base against licenses actually issued.
- **Usage is out of scope by design.** The ledger knows where the app is
  installed and where keys are activated, never what customers do with it.

## What you get

An **admin console** — licenses, the installed base, a token inspector, an
append-only audit log, entitlements, operators and backups — with `admin` and
`support` roles enforced server-side. See [docs/console.md](docs/console.md).

An **admin CLI** for everything the console does, plus key generation and
ledger copying, at `npm run license`, `npm run db` and `npm run admin:create`.
See [docs/cli.md](docs/cli.md).

**SQLite by default**, one file and no server. Set `DATABASE_URL=postgres://…`
and the same service runs on Postgres — migrations run automatically on either
engine, so switching is a config change.

## Deploying

`npm create keyforge --deploy <target>` writes that host's manifest, named
after *your* project: `local`, `docker`, `render`, `fly`, `railway`, `koyeb`
or `cpanel`.

> **On a host with no persistent disk** — Render's free tier and Koyeb — a
> SQLite ledger is empty again after every deploy: licenses, activations,
> audit log and operator accounts alike. Use managed Postgres there. The
> scaffolder says so out loud when you pick that combination.

Full recipes, secrets and caveats per host: [docs/deploy.md](docs/deploy.md).

## Documentation

| Doc | What is in it |
| --- | --- |
| [verify-token.md](docs/verify-token.md) | How your app verifies a token offline. **Read this first** if you are deciding whether to trust Keyforge. |
| [api.md](docs/api.md) | Every HTTP route. `/v1/*` is what your app calls on customers' machines; `/admin/*` is what you call. Includes the full error-code table. |
| [cli.md](docs/cli.md) | `npm run license`, `npm run db`, `npm run admin:create`. |
| [configuration.md](docs/configuration.md) | `keyforge.config.json` and every environment variable. |
| [console.md](docs/console.md) | The admin console: first operator, roles, per-page reference. |
| [deploy.md](docs/deploy.md) | Per-host recipes, and bringing your own Postgres. |
| [backups.md](docs/backups.md) | Snapshots, `pg_dump`, standby mirrors, restoring. |

If tokens are being rejected in the field, start with
`npm run license -- keycheck --expect <your app's public key>`. It compares the
key this service signs with against the one your app verifies against — the one
mismatch that looks like success on the server and failure everywhere else.

## Contributing & security

See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for how we behave here. Report
vulnerabilities privately per [SECURITY.md](SECURITY.md) — never in a public
issue. Licensed [MIT](LICENSE).
