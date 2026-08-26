# Deploying Keyforge

One Node process, a database, and four secrets. Anywhere that runs a container
or a Node app will run this; what actually differs between hosts is **what they
keep** and **what they cost**.

Scaffolding a project picks a target and writes only that host's manifest:

```bash
npm create keyforge@latest my-license-server -- --deploy render
```

`--deploy` takes `local` (the default), `docker`, `render`, `fly`, `railway`,
`koyeb`, or `cpanel`. The manifest is written with *your* project's name, and
the other hosts' files are left out — a repository should describe one
deployment.

## Choosing

| Target | Cost | Keeps data? |
| --- | --- | --- |
| `local` | — | Yes, on your disk |
| `docker` | Whatever the box costs | Yes, named volumes |
| `render` | Free web service tier | **No** on free — no persistent disk |
| `fly` | Trial credit, then pay-as-you-go | Yes, with a volume |
| `railway` | Trial credit, then ~$5/mo | Only with a volume |
| `koyeb` | One free instance per org | **No** — no persistent volume |
| `cpanel` | Hosting you already pay for | Yes |

Two of these deserve the bold type. **On a host with no persistent disk, a
SQLite ledger is empty again after every deploy** — licenses, activations,
installations, the audit log, and your operator accounts. That is a fine trade
while you are trying Keyforge out, and a catastrophe the first time you sell
something. The fix is either a disk (usually paid) or `DATABASE_URL` pointing
at managed Postgres.

Free-tier terms move. Fly ended its permanent free allowance in 2024; Railway's
free plan is credit, not capacity; Render's free Postgres expires. Check the
host's current pricing page before you rely on any of it.

## Every target needs

| Variable | Why |
| --- | --- |
| `LICENSE_SIGNING_KEY` | The trust root. PEM text from `npm run license keygen`. Without it the service refuses to start. |
| `LICENSE_AUTH_SECRET` | Session cookies for the console. Unset = console disabled. |
| `LICENSE_ADMIN_TOKEN` | Bearer token for the CLI. Unset = CLI admin disabled. |
| `LICENSE_SEED_ADMIN_EMAIL` / `_PASSWORD` | Creates the first operator at boot. The only practical way in on a host with no shell. |

Set them in the host's dashboard or secret store. They are never written into a
manifest, and `.env.local` is gitignored precisely so they cannot be committed.

The console's login works on whatever hostname the platform assigns — Better
Auth trusts the requested host — but set `LICENSE_SERVER_URL` anyway so the
CLI has a target.

### Everything the service reads

Validated at boot, before a file is opened or a port is claimed. **Absence is
fine almost everywhere** — an unset variable means a documented default, not an
error. A variable that is *present but malformed* stops the boot and names
itself.

| Variable | Default when unset | Checked as |
| --- | --- | --- |
| `DATABASE_URL` | SQLite | must start `postgres://` or `postgresql://` |
| `LICENSE_DB_PATH` | `licenses.sqlite` | non-empty |
| `LICENSE_DB_POOL_MAX` | 5 | integer 1–100 |
| `LICENSE_SIGNING_KEY` / `_FILE` | — *(one is required)* | full Ed25519 check, see below |
| `LICENSE_ADMIN_TOKEN` | admin API answers 503 | at least 16 characters |
| `LICENSE_AUTH_SECRET` | console disabled | at least 16 characters |
| `LICENSE_AUTH_DB_PATH` | `auth.sqlite` beside the ledger | non-empty |
| `LICENSE_SEED_ADMIN_EMAIL` | no seeding | an email address |
| `LICENSE_SEED_ADMIN_PASSWORD` | no seeding | non-empty |
| `LICENSE_SERVER_URL` | `http://localhost:<port>` | a URL, with scheme |
| `LICENSE_HOST` | `0.0.0.0` | non-empty |
| `LICENSE_PORT` / `PORT` | 4100 | port number; `LICENSE_PORT` wins |
| `LICENSE_CONFIG` | `keyforge.config.json` | non-empty |

Two of these are worth explaining, because both used to fail quietly:

- **`DATABASE_URL` is the engine switch.** Anything not matching `postgres://`
  falls through to SQLite, so a typo'd scheme would have run the service on a
  local file while you believed your managed database was in use. It is now
  refused rather than ignored.
- **`LICENSE_DB_POOL_MAX=ten`** parsed to `NaN`, failed an internal guard, and
  left the deployment on the default pool size with no complaint. Wrong but
  plausible is worse than broken — nobody investigates a service that appears
  to work.

A variable cleared to an empty string in a dashboard counts as unset, which is
what clearing a field is meant to mean.

The signing key gets a check of its own beyond presence: it must parse, be
Ed25519, and survive a sign/verify round trip. `npm run license -- keycheck`
runs the same check offline, and prints the public half and its fingerprint.

## The targets

### local

No manifest. `npm run build:all && npm run start`, console on
`http://localhost:4100/`. Pick a real target later by scaffolding again, or
copy a manifest from below.

### docker

`docker compose up --build`. The generated compose file names its service and
volumes after your project; with `--db postgres` it runs Postgres alongside and
waits for its health check before starting the service. Secrets come from a
`.env` file beside the compose file.

The image builds the server and console and runs `dist/src/index.js`. It sets
no `LICENSE_PORT`, so a host that assigns `PORT` is obeyed and a local run
defaults to 4100.

### render

Push to GitHub, then **New > Blueprint** in the dashboard; Render reads
`render.yaml`. The blueprint declares the build, the `/healthz` check, and every
secret as `sync: false` so the dashboard prompts for it.

With `--db postgres` the blueprint also provisions a free Postgres and wires
`DATABASE_URL` through `fromDatabase` — the combination worth choosing, since
free web services have no disk. Free services also sleep when idle; the first
request after a sleep is slow, which is harmless for license checks and
surprising in a demo.

### fly

```bash
fly launch --no-deploy --copy-config
fly volumes create <project>_data --size 1     # SQLite only
fly secrets set LICENSE_SIGNING_KEY=… LICENSE_ADMIN_TOKEN=… LICENSE_AUTH_SECRET=…
fly deploy
```

`fly.toml` builds from the Dockerfile, serves on 8080, health-checks `/healthz`,
and mounts a volume at `/data` when the ledger is SQLite. A Fly volume belongs
to a single machine: on SQLite, keep this app at one machine, or move to
Postgres and scale freely.

### railway

`railway.json` selects the Dockerfile builder and the `/healthz` check.
Railway injects `PORT`, which this service reads when `LICENSE_PORT` is unset.
Add a volume for a SQLite ledger, or `railway add --database postgres` and let
`DATABASE_URL` arrive on its own.

### koyeb

Koyeb has no repository manifest — services are declared with CLI flags — so
the scaffolder writes `deploy/koyeb.sh` holding the real `koyeb service create`
command: free instance, port 8000, `/healthz` check, and every secret
referenced as `{{secret.NAME}}`. Create the secrets once with `koyeb secrets
create`, edit the repository URL at the top of the script, and run it. Keep the
script in version control and edit it rather than clicking through the
dashboard.

### cpanel

Shared hosting with Passenger. cPanel should never build: run `npm run
build:all` locally or in CI, commit `dist/`, then pull from cPanel's Git Version
Control page. `.cpanel.yml` copies `dist/`, `scripts/`, `package.json` and the
config into the app directory, creates the SQLite file only when it is absent —
never overwriting a live ledger — and touches `tmp/restart.txt` to restart
Passenger.

## Bring your own Postgres

`DATABASE_URL` is the whole switch. Set it to any Postgres and the ledger *and*
the operator accounts live there; leave it unset and the service uses SQLite,
which stays the default. Migrations run at boot on either engine, so moving
from one to the other is a config change rather than a code change.

```
DATABASE_URL=postgres://user:password@host/dbname?sslmode=verify-full
```

**Say `sslmode` out loud.** A URL with no `sslmode` against a remote host gets
verified TLS here anyway, and `sslmode=require` — what most providers hand you
— is also treated as verified rather than left to the driver's default, which
has changed meaning between versions. `sslmode=no-verify` (or `disable` on a
private network) is honoured if you mean it. This database holds operator
password hashes, so the default leans strict.

`LICENSE_DB_POOL_MAX` bounds each pool (default 5). The process opens two —
one for the ledger, one for operator accounts — so a value of 5 means at most
10 connections per instance.

Switching an existing deployment is not a data loss event: `npm run db -- copy
--from ./licenses.sqlite --to "$DATABASE_URL"` moves the whole ledger across,
and the same tool keeps a standby in step afterwards. See
[backups.md](backups.md).

### Neon

Neon's free plan is a real free tier, with one property that matters here:
**the compute suspends after 5 minutes of inactivity and that is not
configurable on Free**. A licensing service is idle most of the time, so this
is the normal case, not an edge case:

- Suspending closes idle connections. The pool logs the drop and opens a fresh
  connection on the next query. (Before this was handled, an unhandled pool
  error would have taken the process down — on a quiet night, unprompted.)
- The first request after a suspend pays the wake-up, a few hundred
  milliseconds. Harmless for license checks; noticeable in a demo.

Neon gives two hostnames for the same database:

| Endpoint | Hostname | Use it for |
| --- | --- | --- |
| Pooled | `ep-name-pooler.region.aws.neon.tech` (note the `-pooler`) | The service. PgBouncer in transaction mode, thousands of client connections. |
| Direct | `ep-name.region.aws.neon.tech` | `pg_dump`, and anything else that needs session state. |

The pooled endpoint does not support session-level advisory locks, `SET`, or
`LISTEN`/`NOTIFY`. This service's boot migrations take a **transaction-scoped**
advisory lock (`pg_advisory_xact_lock`) precisely so they stay correct through
a transaction pooler — two instances starting together serialize instead of
both trying to create the same tables. Backups are the exception: `pg_dump`
relies on `SET`, so point it at the direct endpoint.

Storage on Free is 0.5 GB per project, which a license ledger will not trouble.

Neon's console appends `channel_binding=require` to the connection strings it
hands out. node-postgres does not implement SCRAM channel binding, so that
parameter has no effect here — the connection is still TLS-verified, but do not
read it as a guarantee the driver is enforcing.

Set the URL where that host keeps secrets — Render's dashboard, `fly secrets
set`, `railway variables`, `koyeb secrets` — never in a manifest.

### Other providers

Supabase, Render Postgres, and any self-managed Postgres work the same way:
one `DATABASE_URL`. Render's own free Postgres expires after a while, so check
the current term before relying on it; a Neon or Supabase free database
outlives it.

## Backups

Different by engine, not by host: SQLite deployments download consistent
snapshots from the console's Settings page; Postgres uses `pg_dump`. See
[backups.md](backups.md).
