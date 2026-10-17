# Vercel staging

KeyForge runs as a Node.js Vercel Function with PostgreSQL and private external backup storage. Keep Render production independent and running until staging acceptance. Never copy production credentials, databases or customer data into staging.

## Architecture

- `api/index.mjs` initializes the shared server lazily without listening on a port. Warm invocations reuse it. Persistent hosts keep using `dist/src/index.js`.
- PostgreSQL holds operators, sessions, licenses and all application records. Use a pooled connection URL and initially `LICENSE_DB_POOL_MAX=2` per pool. Vercel pool lifecycle hooks support suspended instances.
- A separate, differently named PostgreSQL database is used only to verify recovery. Initialize it with the same KeyForge release.
- Blob storage must be **private**. Only encrypted archives are uploaded; authenticated admin endpoints serve downloads. Local-only and custom upload-only destinations are disabled on Vercel. S3, R2 and UploadThing remain supported.
- Signing formats, installation authentication, seats, trials and financial records are unchanged.

## Create isolated staging resources

Use the repository root with Node 24 and Vite+:

```sh
vercel link --yes --project keyforge-staging --scope YOUR_TEAM
vercel integration add neon --name keyforge-staging --plan free_v3 --metadata region=iad1 --metadata auth=false --environment production --environment preview
vercel blob create-store keyforge-staging-backups --access private --region iad1 --yes --environment production --environment preview
```

Accept provider terms yourself and confirm free-plan availability. Neon supplies `DATABASE_URL`; Blob supplies `BLOB_READ_WRITE_TOKEN`. Create a separate database such as `keyforge_staging_verify` on the staging provider and set its direct URL as `LICENSE_BACKUP_VERIFY_DATABASE_URL`. Runtime verification does not require database-creation permission.

Set these **server-only** variables on the staging project:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Dedicated staging PostgreSQL, preferably pooled. |
| `LICENSE_BACKUP_VERIFY_DATABASE_URL` | Separate initialized verification database, with a different name. |
| `BLOB_READ_WRITE_TOKEN` | Private staging archive store with upload/read/delete access. |
| `LICENSE_SIGNING_KEY` | Independent staging Ed25519 private PEM. |
| `LICENSE_AUTH_SECRET` | Independent random session secret; at least 32 bytes recommended. |
| `LICENSE_DATA_KEYRING` | Staging JSON encryption ring. |
| `LICENSE_BACKUP_KEYRING` | Independent JSON archive-encryption ring. |
| `CRON_SECRET` | Random secret of at least 32 characters. |
| `LICENSE_SERVER_URL` | Stable staging HTTPS origin. |
| `LICENSE_DB_POOL_MAX` | Initially 2; account for both auth and ledger pools across instances. |
| `LICENSE_SEED_ADMIN_EMAIL` / `LICENSE_SEED_ADMIN_PASSWORD` | Initial staging operator, created during preparation. |
| `LICENSE_ADMIN_TOKEN` | Optional dedicated staging automation access. |

See [configuration and secrets](configuration.md). Keep recovery copies outside the app. Never reuse production keys. Explicit `LICENSE_SERVER_URL` wins over the platform URL. Otherwise `VERCEL_URL` supplies the deployment origin, without trusting request headers. A stable origin is preferable for console sessions and customer status links.

**Production** in this separate Vercel project's interface means the stable **staging** alias, not the Render production service. Both use production runtime settings, but isolated data and secrets.

## Prepare and deploy

These commands work in Bash and PowerShell:

```sh
vercel env pull .env.vercel-staging.local --environment=production --yes
vp install --frozen-lockfile
vp run check
vp run test
vp run build:all
node --env-file=.env.vercel-staging.local scripts/vercel-prepare.mjs
vp run test:packages
vp run test:console
vp run test:issuance
vp run test:docs
vercel deploy --prod
```

Preparation migrates the explicitly selected staging database, seeds the initial operator idempotently, and initializes the verification schema. Subsequent function cold starts do not run Better Auth schema migrations or recreate operators. Prepare each release before deploying, after checking schema compatibility with the previous release.

Vercel does not export sensitive production values: an environment pull may write `[SENSITIVE]` placeholders. Replace those locally using your secure recovery copies before preparation; never commit the file. The staging installer keeps independently generated values in the ignored `secrets/` directory for this purpose. Prefer an organization password manager for ongoing operations.

The checked-in configuration builds through Vite+, sets a 300-second function limit and disables automatic Git deployments. Keep deployment gated on successful CI and the exact tested commit. Never connect staging to production data. Production promotion and changing domains remain separate operations.

## Backups and scheduling

Manual admin jobs use `waitUntil` to keep the invocation alive after the response. Progress, queued jobs and worker leases are stored in PostgreSQL. Interrupted jobs become failed after lease expiry on a later invocation; they are not reported as completed. Queued work can be processed on a later tick.

The Hobby-compatible cron invokes `/api/internal/backups/tick` daily at **05:00 UTC** (08:00 in Addis Ababa/Nairobi). Vercel sends the configured `CRON_SECRET` as a bearer credential; unauthenticated calls fail. Hobby timing is approximate. Settings times are earliest-run thresholds checked at the next invocation, rather than exact execution times. Manual jobs start immediately. Cron runs on the project's Production target: the separate staging alias here. Check plan limits before configuring more frequent cron.

Portable PostgreSQL archives use envelope version 2 containing `database.json`. They capture owned application tables, credentials, sessions, migration versions and the bootstrap-admin reference in a consistent read-only transaction. They exclude arbitrary database objects, roles, extensions and executable schema SQL. Dedicated KeyForge databases are required. Capture is bounded to 96 MiB of raw row data and 128 MiB of serialized snapshot data; function time limits still apply. Larger installations need provider-native or external streaming backups.

**Verify** decrypts the archive, restores into the independent initialized verification database inside a transaction, compares recovered contents and rolls back. Reset with backup uploads and verifies the remote archive before clearing any data. Failed upload or verification aborts reset. The first seeded administrator is preserved.

Existing version 1 SQLite/native PostgreSQL archives and persistent-host backup behavior remain supported. Native PostgreSQL archives still require compatible `pg_dump`/`pg_restore` tools there. Store backup and data keys independently from archives.

## Acceptance and recovery

Before production migration, verify health, welcome/docs, login, profile upload, plan issuance, payments and reports, customer delivery, SDK activation/refresh, trial and seat limits, support/notifications, backup/download/verification and reset in **staging only**. Inspect mobile and desktop in both themes.

Vercel application rollback does not reverse database migrations or restore data. Test archive recovery into an independent target first, initialized using the exact matching release and its authentication schema:

```sh
node --env-file=.env.recovery.local scripts/vercel-prepare.mjs
vp run backup:restore --file ./JOB_UUID.kfbackup --job JOB_UUID --maintenance --database "POSTGRES_RECOVERY_URL" --replace
```

Use dedicated recovery environment URLs and matching backup/data keys. Stop all target writers before committing a restore. Portable restoration checks schema and migration versions, restores IDs and sessions, repairs sequences transactionally and never executes SQL from the archive. Verify application behavior afterward.

Do not switch domains, disable Render or change production data during staging setup. Plan a separate cutover, backup and rollback window after acceptance.
