# Backups

The license ledger is the record of everything you have sold. Back it up, and
treat the backups as secrets — they contain the ledger, and the auth database
contains operator password hashes.

## SQLite deployments

The console's **Settings → Backups** page (and
`GET /admin/backup/licenses`, `GET /admin/backup/auth`) downloads a
consistent snapshot taken with SQLite's online backup API. That is safe while
the service is running and writing; copying the `.sqlite` file yourself is
not, because WAL data may not be in it.

Scripted, using the CLI's admin token:

```bash
curl -fsS -H "Authorization: Bearer $LICENSE_ADMIN_TOKEN" \
  "$LICENSE_SERVER_URL/admin/backup/licenses" \
  -o "licenses-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
```

Run that from cron or a scheduled job and copy the result off the machine.
Every download is recorded in the audit log.

## Postgres deployments

`GET /admin/backup/licenses` answers **501** on Postgres, deliberately: a
half-hearted snapshot of a database the service does not exclusively own would
be worse than an honest refusal. Use Postgres' own tooling, which is better
than anything this service could offer:

```bash
pg_dump --format=custom "$DATABASE_URL" > keyforge-$(date -u +%Y%m%d).dump

# restore
pg_restore --clean --if-exists --dbname "$DATABASE_URL" keyforge-20260101.dump
```

Managed providers (Render, Neon, Supabase, RDS) also take automatic backups —
check the retention window, and test a restore before you need one.

Note that with Postgres, operator accounts live in the **same database** as the
ledger, so one dump covers both. On SQLite they are two files
(`licenses.sqlite` and `auth.sqlite`) and both are worth keeping.

## A second database

`npm run db` copies a whole ledger between databases — either direction, either
engine. That covers the two things `pg_dump` and a `.sqlite` download do not:
moving a live SQLite ledger onto managed Postgres without losing it, and
keeping a standby somewhere you control.

```bash
npm run build                                   # this tool uses the compiled server

npm run db -- copy   --from ./licenses.sqlite --to "$DATABASE_URL"
npm run db -- mirror --to ./standby/licenses.sqlite
npm run db -- verify --to ./standby/licenses.sqlite
```

`copy` is one shot and refuses a destination that already holds rows unless you
pass `--replace`. `mirror` is the same copy aimed at a standby: `--from`
defaults to this deployment's own database, `--replace` is implied, and it is
safe to run on a schedule. `verify` compares row counts and a content checksum
per table and **exits 1** on a mismatch, so cron tells you when the mirror
stopped working. Nothing prints a password.

Run these against a standby, or against a ledger nothing is serving. Unlike
`npm run license`, which goes through the running service's admin API, this
tool works on databases at rest.

### What a mirror is not

**It is a backup, not a replica.** It is exactly as old as the last run, and
the service never writes to it. Licenses issued between two runs exist only in
the live database.

That is a deliberate choice, not a missing feature. Two writable ledgers with
automatic failover would eventually issue one product key twice and count one
seat twice — a gap you can see is better than a ledger you cannot trust.

Only the four ledger tables travel: licenses, activations, installations and
the audit log. **Operator accounts do not** — those belong to Better Auth,
whose tables this tool does not own. Sessions do not travel either.

### Scheduling it

```bash
# crontab: hourly, and shout if the copy stopped matching
17 * * * * cd /srv/keyforge && npm run db -- mirror --to /backups/licenses.sqlite \
             && npm run db -- verify --to /backups/licenses.sqlite
```

On Render, the same two commands as a **Cron Job** service pointed at the same
repository; on Fly, `fly machine run` on a schedule; on any host, a scheduled
job that can reach both databases. The mirror needs `DATABASE_URL` (or
`LICENSE_DB_PATH`) exactly as the service does.

A standby on a different provider than the live database is worth the trouble:
a mirror in the same account as the thing it mirrors survives a disk failure,
not a suspended account.

### Promoting the standby

Manual, on purpose — nothing fails over on its own.

1. **Stop the service**, or at least stop selling. Anything the live database
   accepts from here is not in the standby.
2. `npm run db -- verify --from <live> --to <standby>` if the live database still
   answers, so you know exactly how far behind you are starting.
3. Point `DATABASE_URL` (or `LICENSE_DB_PATH`) at the standby and restart.
   Migrations run at boot, so an older snapshot is brought up to schema.
4. **Re-seed the operator.** Set `LICENSE_SEED_ADMIN_EMAIL` and
   `LICENSE_SEED_ADMIN_PASSWORD` and restart, or run `npm run admin:create`.
   Operator accounts were not in the mirror; everyone signs in again.
5. Mirror *from* the promoted database onwards, so the standby is no longer
   also the thing you are mirroring to.

Licenses issued after the last mirror are gone. Customers holding those keys
fail activation with `unknown_key` — reissue them from your own sales records,
which is the argument for mirroring often and keeping the audit log.

## Restoring

Restoring is a file copy (SQLite) or `pg_restore` (Postgres). The service runs
its migrations at boot, so an older snapshot is brought up to the current
schema automatically the first time it starts against the restored data.

Signing keys are **not** in any backup — they live in the environment. Losing
`LICENSE_SIGNING_KEY` invalidates every token you have ever issued, so store it
somewhere durable and separate from these dumps.
