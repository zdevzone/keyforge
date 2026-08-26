# Configuration

Keyforge splits its settings in two, on purpose:

- **Policy** — how licensing behaves — lives in a JSON file that belongs in
  version control.
- **Secrets and deployment wiring** live in environment variables, which never do.

Every variable is validated at boot (`src/env.ts`). A malformed value stops the
service with a message naming it, rather than silently falling back to a default
and leaving you to wonder why production behaves differently from your laptop.

## Policy: `keyforge.config.json`

Optional. Without it every setting takes a documented default, which is why a
fresh clone runs. Point elsewhere with `LICENSE_CONFIG`.

`keyforge.config.example.json` lists every knob with a comment: branding, key
format, offline grace, rate limits, plan presets (entitlements, duration,
seats), the install census and its user-info collection, and the audit and
backup features.

An invalid file **refuses to boot** rather than half-applying — a config that
parses but means something you did not intend is worse than one that fails.

## Secrets: environment variables

`.env.local` is loaded automatically by the package scripts; `.env.example` is
the template. On a hosting platform, set the same names in its dashboard instead.

| Variable | Required | Purpose |
| --- | --- | --- |
| `LICENSE_SIGNING_KEY` / `LICENSE_SIGNING_KEY_FILE` | **yes** | Ed25519 private key (PEM inline, or a path). `npm run license keygen` writes to the `_FILE` path. The service refuses to start without it. |
| `LICENSE_ADMIN_TOKEN` | no | Bearer token for the CLI. Absent → CLI admin access disabled (503). |
| `LICENSE_AUTH_SECRET` | no | Session-cookie secret for the web console. Absent → console login disabled (503). |
| `LICENSE_PORT` / `LICENSE_HOST` | no | Defaults `4100` / `0.0.0.0`. When `LICENSE_PORT` is unset, a platform-assigned `PORT` is used — that is how Fly, Railway and Koyeb hand out ports. |
| `DATABASE_URL` | no | `postgres://…` runs the ledger on Postgres (operators too). Unset = SQLite. Any provider works — Neon, Supabase, Render, your own. |
| `LICENSE_DB_POOL_MAX` | no | Connections per Postgres pool. Default `5`; the process opens two (ledger, operators). |
| `LICENSE_DB_PATH` | no | SQLite ledger location. Default `licenses.sqlite`. Ignored on Postgres. |
| `LICENSE_AUTH_DB_PATH` | no | Console users and sessions. Default `auth.sqlite`, beside the ledger. |
| `LICENSE_SEED_ADMIN_EMAIL` / `LICENSE_SEED_ADMIN_PASSWORD` | no | Seed this operator at boot if missing. Idempotent — an existing user's password is never changed. |
| `LICENSE_CONFIG` | no | Path to the policy JSON. Default `./keyforge.config.json`. |
| `LICENSE_SERVER_URL` | no | Public origin. Used by the CLI as its target, and by the console for cookie origin checks. |

## Both admin surfaces fail closed

An unset secret **disables** that surface rather than leaving it open. No
`LICENSE_ADMIN_TOKEN` means the admin API answers 503; no
`LICENSE_AUTH_SECRET` means there is no console to log in to. Misconfiguration
costs you access, never your customers' data.

A short secret is worse than none, because it looks like security — so both
have a 16-character floor and boot fails below it.

## Related

- [deploy.md](deploy.md) — per-host recipes and which variables each platform needs
- [console.md](console.md) — provisioning the first operator, roles, `auth.admin`
- [cli.md](cli.md) — the commands these variables point at
