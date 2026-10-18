# Vercel deployment

KeyForge runs as a Node.js Vercel Function with PostgreSQL and private external backup storage. Use one Vercel project named `keyforge`: `main` is Production and `dev` is Preview. This installation's Render service is now suspended following production acceptance. Never give preview deployments production keys, databases or backup credentials.

## One project, two environments

| Configuration | Production | Preview |
| --- | --- | --- |
| Git branch | `main` | `dev` |
| URL | Your production domain or generated project URL | Generated permanent `dev` branch URL |
| PostgreSQL | Dedicated production resource | Dedicated staging resource |
| Verification database | Separate production verification database | Separate staging verification database |
| Signing, auth and encryption keys | Existing production keys during migration | Independent staging keys |
| Private backup store | Production only | Preview only |

Set the production branch to `main` under the project's Git settings. Scope Preview environment variables to **dev**, including database and storage credentials. Other branches and fork PRs must not inherit these credentials; use local/CI fixtures or deliberately provision isolated resources for additional previews.

The stable customer-facing Preview domain `keyforge-dev.1hubengineering.com` has a **Deployment Protection Exception** so public license requests, private request-status links, documentation and client APIs do not require a Vercel account. KeyForge still requires its own operator session or API credential for administrative routes. Keep Vercel Authentication enabled for other deployment URLs; do not put a bypass secret in a public link or browser bundle. Configure this domain-level exception in the project's Deployment Protection settings, not in application redirect code. Verify `/request-license` opens in a signed-out browser and `/admin/config` still returns HTTP 401 without credentials.

Vercel generates branch URLs such as `keyforge-git-dev-YOUR_SCOPE.vercel.app`; use the actual URL shown by your deployment. Arbitrary `dev-project.vercel.app` names are not ordinary custom domains you own. For a domain you control, add `dev.example.com` and assign its Git Branch to `dev`, then configure its DNS. No second Vercel project is needed. Usage limits are account/team-wide; consolidating projects does not halve database, storage or compute usage.

## Architecture

- `api/index.mjs` initializes the shared server lazily without listening on a port. Warm invocations reuse it. Persistent hosts keep using `dist/src/index.js`.
- PostgreSQL holds operators, sessions, licenses and all application records. Use a pooled connection URL and initially `LICENSE_DB_POOL_MAX=2` per pool. Vercel pool lifecycle hooks support suspended instances.
- A separate, differently named PostgreSQL database is used only to verify recovery. Initialize it with the same KeyForge release.
- Blob storage must be **private**. Only encrypted archives are uploaded; authenticated admin endpoints serve downloads. Local-only and custom upload-only destinations are disabled on Vercel. S3, R2 and UploadThing remain supported.
- Signing formats, installation authentication, seats, trials and financial records are unchanged.

## Connect isolated resources

Use the repository root with Node 24 and Vite+:

```sh
vercel link --yes --project keyforge --scope YOUR_TEAM
vercel integration add neon --name keyforge-staging --plan free_v3 --metadata region=iad1 --metadata auth=false --environment preview
vercel blob create-store keyforge-staging-backups --access private --region iad1 --yes --environment preview
vercel integration add neon --name keyforge-production --plan free_v3 --metadata region=iad1 --metadata auth=false --environment production
vercel blob create-store keyforge-production-backups --access private --region iad1 --yes --environment production
```

Accept provider terms yourself and confirm free-plan availability. Reuse existing resources instead of rerunning provisioning. Neon supplies `DATABASE_URL`; Blob supplies `BLOB_READ_WRITE_TOKEN` for the first encrypted database import. After deploying, test storage and verify an archive in Settings → Backups; remove the token environment variable and redeploy once both pass. Subsequent storage changes happen in Settings. Create separate databases such as `keyforge_staging_verify` and `keyforge_production_verify` on their respective resources; set their direct URLs as each environment's `LICENSE_BACKUP_VERIFY_DATABASE_URL`. Runtime verification does not require database-creation permission. After connecting Preview resources, scope their generated variables to `dev` too.

Set these **server-only** variables independently in each environment. The table describes Preview; Production uses its own values:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Dedicated staging PostgreSQL, preferably pooled. |
| `LICENSE_BACKUP_VERIFY_DATABASE_URL` | Separate initialized verification database, with a different name. |
| `BLOB_READ_WRITE_TOKEN` | Optional one-time import of private storage credentials; manage them in Settings → Backups afterward. |
| `LICENSE_SIGNING_KEY` | Independent staging Ed25519 private PEM. |
| `LICENSE_AUTH_SECRET` | Independent random session secret; at least 32 bytes recommended. |
| `LICENSE_DATA_KEYRING` | Staging JSON encryption ring. |
| `LICENSE_BACKUP_KEYRING` | Independent JSON archive-encryption ring. |
| `CRON_SECRET` | Random secret of at least 32 characters. |
| `LICENSE_SERVER_URL` | Stable staging HTTPS origin. |
| `LICENSE_DB_POOL_MAX` | Initially 2; account for both auth and ledger pools across instances. |
| `LICENSE_SEED_ADMIN_EMAIL` / `LICENSE_SEED_ADMIN_PASSWORD` | Initial staging operator, created during preparation. |
| `LICENSE_ADMIN_TOKEN` | Optional dedicated staging automation access. |

See [configuration and secrets](configuration.md). Keep recovery copies outside the app. Never reuse production keys in Preview. Explicit `LICENSE_SERVER_URL` wins over the platform URL. Otherwise `VERCEL_URL` supplies the deployment origin, without trusting request headers. Set a stable origin separately for Production and Preview for console sessions and customer status links.

Both hosted environments use production runtime settings and secure cookies. Vercel's Production target now serves the real production environment; the earlier staging-only setup used that target temporarily. Changing environment variables affects new deployments, not already-built ones. Never promote an old staging deployment to Production: rebuild from `main` with the Production variables instead.

## Prepare and deploy

These commands work in Bash and PowerShell:

Prepare `secrets/environments/staging/server.env` using the [portable environment guide](configuration.md#portable-environments-and-recovery-files). Generate independent keys once for a new installation; restore the existing keys for an existing one. Provider exports go under `secrets/providers/vercel/` for reference, separate from the canonical server configuration. They may contain masked values and must not overwrite your complete recovery settings.

```sh
git switch dev
node -e "require('node:fs').mkdirSync('secrets/providers/vercel', {recursive: true})"
vercel env pull secrets/providers/vercel/preview-export.env --environment=preview --git-branch=dev --yes
vp install --frozen-lockfile
vp run check
vp run test
vp run build:all
node --env-file=secrets/environments/staging/server.env scripts/vercel-prepare.mjs
vp run test:packages
vp run test:console
vp run test:issuance
vp run test:docs
vercel deploy
```

Preparation migrates the explicitly selected database, seeds the initial operator idempotently, and initializes its verification schema. Subsequent function cold starts do not run Better Auth schema migrations or recreate operators. The Vercel build command runs this preparation after compiling, with the selected environment's actual secrets. Local preparation remains available for initial setup and recovery. Review schema compatibility and verify a backup before each schema-changing release. Do not run preparation against Preview using Production credentials or the reverse.

Vercel does not export sensitive values: an environment pull may write `[SENSITIVE]` placeholders. Replace those locally using the selected environment's secure recovery copies before preparation; never commit the file. Local migration recovery files belong in the ignored `secrets/` directory. Prefer an organization password manager for ongoing operations. Never copy a development `.env` file and assume it contains the live production keys.

The checked-in configuration builds through Vite+, prepares the selected database, sets a 300-second function limit and disables native automatic Git deployments. The **Deploy Vercel** GitHub workflow automatically deploys the current `dev` commit after successful push CI. Production stays manual on `main`, with environment approval and a matching healthy dev Preview required. Both paths pin branch and SHA and verify the deployed source and health. See [maintaining KeyForge](maintaining.md) for environment credentials and Bash/PowerShell dispatch commands. Fork and PR checks never receive deployment secrets.

## Fresh production cutover from Render

This procedure intentionally does **not** migrate users, sessions, licenses, installations or sales. Previously issued token signatures can remain authentic with the same signing key, but server refresh, activation, revocation and support require records that will not exist in the fresh database. Existing customer request/status links and installation credentials do not transfer. Recreate products/plans and re-onboard clients deliberately; preserving a signing key does not preserve their server authorization records.

1. Export the actual Render environment and secret files privately. Preserve the signing key, signing key ID if configured, the complete data and backup encryption rings (including retired keys), authentication secret and optional admin token. Convert secret-file inputs to their inline environment equivalents on Vercel; Render file paths do not exist there. Compare the recovered signing public key with Render before deployment. Do not rotate keys as part of this move.
2. Connect a fresh Production PostgreSQL resource and private backup store. Initialize a separate verification database. Never point Production at Preview's database or the old Render database. Seed only the first admin using the intended credentials; do not run demo seeding or import Render records.
3. Test the current `dev` Preview, then promote `dev` into `main` through a merge PR and wait for main CI. Confirm the tested source tree matches main. Keep the existing Render service running and unchanged.
4. Select `main`, pull **Production** variables, replace sensitive placeholders locally, and prepare the fresh schemas. Then deploy Production without assigning domains yet:

```sh
git switch main
git pull --ff-only
vercel env pull secrets/providers/vercel/production-export.env --environment=production --yes
node --env-file=secrets/environments/production/server.env scripts/vercel-prepare.mjs
vercel deploy --prod --skip-domain
```

5. Verify the resulting Production deployment's health, public signing key, seeded admin sign-in, empty business records, private backup upload/download/recovery, protected routes and canonical origin. Deployment Protection may require Vercel authentication while testing the unique deployment URL. Do not weaken that protection to test it.
6. Assign the existing production domain only after verification, using `vercel promote PRODUCTION_DEPLOYMENT_URL`. Here this command assigns domains to a deployment **already built with Production variables**; it must not promote the dev Preview. Verify again on the canonical domain, including secure cookie login, profile upload and client calls. Keep Render available as the fallback until the owner retires it explicitly.

For future releases use **Deploy Vercel**, following the [maintainer guide](maintaining.md). The old Render deployment workflow has been replaced. The manual CLI procedure above is an operator recovery/bootstrap alternative, not a second automatic deployment path. npm release workflows remain independent.

## Backups and scheduling

Manual admin jobs use `waitUntil` to keep the invocation alive after the response. Progress, queued jobs and worker leases are stored in PostgreSQL. Interrupted jobs become failed after lease expiry on a later invocation; they are not reported as completed. Queued work can be processed on a later tick.

The Hobby-compatible cron invokes `/api/internal/backups/tick` daily at **05:00 UTC** (08:00 in Addis Ababa/Nairobi). Vercel sends the Production `CRON_SECRET` as a bearer credential; unauthenticated calls fail. Hobby timing is approximate. Settings times are earliest-run thresholds checked at the next invocation, rather than exact execution times. Manual jobs start immediately. Cron runs **only on Production**, not dev Preview. Preview backups are manual unless a separate authenticated scheduler is deliberately configured. Check plan limits before configuring more frequent cron.

Portable PostgreSQL archives use envelope version 2 containing `database.json`. They capture owned application tables, credentials, sessions, migration versions and the bootstrap-admin reference in a consistent read-only transaction. They exclude arbitrary database objects, roles, extensions and executable schema SQL. Dedicated KeyForge databases are required. Capture is bounded to 96 MiB of raw row data and 128 MiB of serialized snapshot data; function time limits still apply. Larger installations need provider-native or external streaming backups.

**Verify** decrypts the archive, restores into the independent initialized verification database inside a transaction, compares recovered contents and rolls back. Reset with backup uploads and verifies the remote archive before clearing any data. Failed upload or verification aborts reset. The first seeded administrator is preserved.

Existing version 1 SQLite/native PostgreSQL archives and persistent-host backup behavior remain supported. Native PostgreSQL archives still require compatible `pg_dump`/`pg_restore` tools there. Store backup and data keys independently from archives.

## Acceptance and recovery

Authenticated archive downloads stream in chunks to avoid the platform's buffered response limit. Capture, checksum verification and encryption are still buffered and bounded; this is not unlimited-size backup support. Uploads remain subject to Vercel's request size limit and KeyForge's existing avatar validation.

Before production migration, verify health, welcome/docs, login, profile upload, plan issuance, payments and reports, customer delivery, SDK activation/refresh, trial and seat limits, support/notifications, backup/download/verification and reset in **staging only**. Inspect mobile and desktop in both themes.

Vercel application rollback does not reverse database migrations or restore data. Test archive recovery into an independent target first, initialized using the exact matching release and its authentication schema:

```sh
node --env-file=secrets/environments/recovery/server.env scripts/vercel-prepare.mjs
vp run backup:restore --file ./JOB_UUID.kfbackup --job JOB_UUID --maintenance --database "POSTGRES_RECOVERY_URL" --replace
```

Use dedicated recovery environment URLs and matching backup/data keys. Stop all target writers before committing a restore. Portable restoration checks schema and migration versions, restores IDs and sessions, repairs sequences transactionally and never executes SQL from the archive. Verify application behavior afterward.

An application rollback does not undo a fresh-data cutover. Keep Render and its keys/data available during acceptance; old Render data is not synchronized with new Vercel writes. Repointing a custom domain back to Render also requires restoring its canonical URL, DNS and secure-cookie configuration. Handle data reconciliation explicitly if both hosts have accepted writes. Retire Render only after acceptance and explicit owner authorization.

## Web Analytics

Enable Web Analytics in the Vercel project dashboard. Set the non-secret build variable `VITE_KEYFORGE_ANALYTICS=production` in the Production environment only, after enabling Analytics. Leave it unset in Preview and local/self-hosted builds. Tracking is opt-in so cloning this repository does not load a Vercel-only script on an unconfigured host. No analytics API key is needed.

Only the public welcome, documentation and license-request form pages are counted. Documentation slugs are grouped as `/docs/:slug`. Console, sign-in and private customer status pages are excluded, including after client-side navigation. Page URLs omit query strings and fragments, custom events are rejected, and the HTML referrer policy exposes only the origin. Analytics does not receive license keys, customer request secrets or account information. Browser/ad-blocker settings may prevent events from appearing.
