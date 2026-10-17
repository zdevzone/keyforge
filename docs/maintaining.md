# Maintaining KeyForge

The public [zdevzone/keyforge repository](https://github.com/zdevzone/keyforge) is the source of truth. The earlier private repository is historical reference; do not continue exporting or synchronizing it over public changes.

## Everyday changes and contributions

Use short-lived feature branches and pull requests into `dev`. People outside the maintainer group contribute through forks; they need no write access. Only the owner has administrative access initially. All branches of this public project are readable by everyone.

`main` and `dev` require pull requests, the **CI passed** check, and resolved review conversations. Force pushes and branch deletion are prohibited. There is no mandatory second reviewer while the owner works alone. This is deliberately not independent review: the PR provides a reviewable diff and CI history. When a real second maintainer joins, grant write access, require one independent approval, dismiss stale approvals, and prevent self-approval for releases/deployments. Keep administrative access limited.

1. Branch from updated `dev`, make a focused change, and open a PR targeting `dev`.
2. Run `vp install --frozen-lockfile`, `vp run check`, `vp run build:all`, and `vp run test`. Relevant package/browser workflows run in CI too.
3. Inspect the diff and CI results, then squash-merge the feature PR. Delete its feature branch.
4. Deploy `dev` to Preview in the single Vercel `keyforge` project after checks pass, and test the changed workflows there. Preview has its own database, keys and private backup store; see [Vercel deployment](vercel.md).
5. Open a promotion PR from `dev` into `main` and use **Create a merge commit**, not squash. This preserves shared history between the persistent branches.
6. Open a synchronization PR from `main` back into `dev` and merge it with **Create a merge commit**. This carries the promotion commit back into dev so the next promotion satisfies the up-to-date branch requirement. Keep both persistent branches; never delete dev after merging.
7. After main CI passes, manually build/deploy Production using its own environment variables and/or release packages as needed. Merging alone does not authorize a production deployment or npm publication. Never promote a dev deployment containing Preview credentials to Production.

For urgent fixes, branch from `main`, use a PR and CI, then merge `main` back into `dev` through a PR. Production deployment still requires the same source contents to have passed staging. Do not bypass testing by enabling auto-deploy.

For a disposable PostgreSQL test database, set `TEST_DATABASE_URL` and run `vp run test:postgres`. It executes the complete suite with test files in sequence: Better Auth scans the database-wide catalog, so concurrently dropping other fixtures' schemas can invalidate introspection. Never use a production or shared Preview database as the test target.

Dependabot targets `dev`. Review grouped minor/patch changes and individual major updates normally; there is no blanket dependency auto-merge. Report vulnerabilities privately using [SECURITY.md](https://github.com/zdevzone/keyforge/blob/main/SECURITY.md).

## Vercel production and testing

Use one project, `keyforge`, connected to this repository: `main` is Production and `dev` is Preview. The environments need separate database resources, verification databases, backup stores and credentials. Scope Preview secrets to `dev`; untrusted feature branches/forks must not inherit them. Use Vercel's generated branch URL or a domain you own assigned to `dev`.

Follow [Vercel deployment](vercel.md) for preparation, CI-checked manual deployment, cron limitations, production key preservation and cutover. Automatic Git deployments remain disabled. Production's daily backup cron does not run for Preview. Keep the existing Render service running until the Vercel production checks pass; retiring it is a separate owner decision.

## Alternative: separate Render testing service

Creating infrastructure can incur charges. Choose plans in Render yourself; no workflow provisions services or databases.

1. Create a dedicated **persistent PostgreSQL database** for staging. Do not copy production credentials or customer data. An expiring free database is suitable only for disposable experiments, not durable staging.
2. Create a separate web service named `keyforge-staging` connected to this repository's `dev` branch. Alternatively create a Blueprint using **render.staging.yaml**; its database is deliberately supplied separately.
3. Copy its build/start commands from that file and select automatic deployment **After CI checks pass**. Keep `NODE_ENV=production`; staging uses the compiled app and secure cookies, not a public development server.
4. Generate a new signing key, auth secret, optional admin token, data keyring and backup keyring using the [beginner guide](getting-started.md). Set their inline environment values in Render or mount persistent secret files. Never commit them. The staging `DATABASE_URL`, administrator, and keys must differ from production.
5. Configure a separate private backup bucket/prefix and credentials using [backups](backups.md). Keep encryption-key recovery copies outside Render. A local backup directory on ephemeral hosting is not durable storage. Configure a separate verification database if PostgreSQL backup verification is enabled.
6. Let Render supply its public URL automatically; use `LICENSE_SERVER_URL` only for an explicit custom domain. Use staging's URL and public signing keys in test clients.
7. Confirm `/healthz`, sign-in, license issuance, activation, payments, backup download/verification, and that production data remains unchanged. Seed demo data only against staging, explicitly checking its URL/database before maintenance commands.

If production still follows the earlier private repository, keep that service running during setup. First turn Auto-Deploy off, then change the existing service’s repository to `zdevzone/keyforge` and its branch to `main` in Render Settings. Preserve its database, keys, domain, and backup configuration. Do not create a replacement production database just to switch repositories.

Existing production settings are not automatically replaced by the Blueprint. In the production service dashboard, select branch `main` and set **Auto-Deploy: Off**, preserving its database, domain and keys. Review Blueprint diffs before applying them to an existing service. The root template's SQLite path needs persistent storage if used in a real deployment; changing to PostgreSQL requires a separately planned full-data migration.

## Legacy Render production deployment

This workflow is retained for installations still hosted on Render. It does not deploy Vercel. For the current one-project Vercel setup, follow the manual Production steps in [Vercel deployment](vercel.md).

In GitHub **Settings → Environments → production**, configure:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `RENDER_API_KEY` | Render API key with access to the two intended services |
| Variable | `RENDER_STAGING_SERVICE_ID` | Staging `srv-…` identifier |
| Variable | `RENDER_PRODUCTION_SERVICE_ID` | Production `srv-…` identifier |

Use only `main` as the allowed deployment branch. Require the owner's approval with self-review allowed while working solo. Never store a deploy hook or Render API key in repository files, logs, PRs, or npm packages.

Run **Actions → Deploy Render production (legacy) → Run workflow → main**, then approve the environment request. The workflow checks current main CI, service identities/branches, disabled production auto-deploy, and a live staging deployment with the same Git tree. Promotion merge commits can have different commit IDs but identical contents. It deploys the exact main commit, waits for Render to report it live, and verifies `/healthz`. A moving main branch, unavailable credentials, or missing staging evidence stops deployment.

Bash and PowerShell both support:

```sh
gh workflow run deploy-production.yml --repo zdevzone/keyforge --ref main
gh run list --repo zdevzone/keyforge --workflow deploy-production.yml --limit 5
```

### Failure and rollback

Inspect the failed run and Render deployment before retrying; a timeout does not prove Render stopped working. Avoid starting a duplicate deployment while the first is still active. Render normally retains the previous successful deployment when a new deployment fails.

Before a schema-affecting release, create and verify an encrypted backup and save the recovery keys. To undo an application release, first assess database compatibility, then use Render's rollback controls to select the prior successful deployment. Keep auto-deploy off and follow up with a revert PR so Git matches the intended release. Rolling back application code does not reverse database migrations. Restore a database only as a separate, explicitly reviewed recovery action following the backup guide.

## npm releases

See [publishing](publishing.md) for stable/beta channels, trusted publisher configuration, package order, retries, and Bash/PowerShell commands. Stable releases use `main` and `latest`; beta releases use `dev` and `beta`. Both require manual dispatch and environment approval. Never move `latest` to a beta version.

## Security and access maintenance

Keep personal GitHub/npm accounts protected by two-factor authentication and save recovery codes securely. Periodically review collaborators, trusted publishers, environment secrets and security alerts. Fork PR jobs receive no deployment secrets or npm publishing identity. Review workflow modifications carefully; dependencies and Actions use the same PR/check requirements as other changes.
