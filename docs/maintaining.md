# Maintaining KeyForge

The public [zdevzone/keyforge repository](https://github.com/zdevzone/keyforge) is the source of truth. The earlier private repository is historical reference; do not copy changes over the public repository. This installation runs on Vercel. Its former Render web service is suspended.

## Everyday changes and contributions

`main` and `dev` are the persistent branches. Create short-lived feature branches from `dev`, open a PR into `dev`, and remove the feature branch after merging. Contributors outside the maintainer group use forks. Read access to this public repository does not grant write access.

Both persistent branches require a PR, **CI passed**, and resolved review conversations. Force pushes and branch deletion are prohibited. Keep the owner as the only administrator initially. Zero independent approvals are required while working alone; your own PR review does not count as an independent approval. When another maintainer joins, require one independent approval, dismiss stale approvals after new commits, and prevent self-approval of deployments and releases.

1. Run `vp install --frozen-lockfile`, `vp run check`, `vp run build:all`, and `vp run test` for a change. Relevant package and browser checks also run in CI.
2. Review the feature PR, wait for CI, then squash-merge it into `dev` and delete its branch.
3. After successful **push** CI on the current `dev` commit, **Deploy Vercel** automatically builds Preview. Test the changed workflows on the dev domain. PR and fork CI never receive deployment secrets.
4. Open a promotion PR from `dev` into `main`; wait for checks and use **Create a merge commit**, not squash, to preserve shared history.
5. After main push CI succeeds, run **Deploy Vercel** manually on `main` with target **production**, then approve the production environment request. The source contents must match a healthy dev Preview. A Preview deployment is never promoted directly into Production with its staging credentials.
6. Merge `main` back into `dev` through a synchronization PR using a merge commit. Keep both persistent branches. The resulting dev push is tested and deployed normally.

For an urgent production fix, start from `main`, use a PR and CI, then bring it into `dev` and test Preview before production deployment. npm publishing remains a separate manually approved workflow. No dependency update is automatically merged or published. Dependabot can create new short-lived PR branches after a cleanup; review them normally.

For a disposable PostgreSQL test database, set `TEST_DATABASE_URL` and run `vp run test:postgres`. The complete suite runs test files sequentially because Better Auth scans the database-wide catalog and concurrent fixture schema drops can invalidate introspection. Never use a production or shared Preview database as the test target.

## One Vercel project

Use the project `keyforge`, connected to this public repository, with `main` as the Production branch and `dev` as Preview. Keep databases, verification databases, signing/auth/encryption keys and private backup stores isolated between environments. Scope all Preview server variables to `dev`.

This installation has four configured project domains:

| Environment | Custom domain | Vercel domain |
| --- | --- | --- |
| Production (`main`) | `keyforge.1hubengineering.com` | `keyforge-abry101s-projects.vercel.app` |
| Preview (`dev`) | `keyforge-dev.1hubengineering.com` | `keyforge-dev.vercel.app` |

Each deployment also receives a unique generated URL. That is an immutable deployment address, not an extra project or permanent branch domain. Removing a Git branch does not necessarily remove its historical Vercel deployment card. Retain useful production rollback history.

Native automatic Git deployments remain disabled in `vercel.json`. The GitHub workflow requests the exact CI-tested commit through Vercel's Git API, with an explicit branch and SHA. Preview follows successful dev push CI; Production requires manual dispatch and environment approval. This prevents a push from independently bypassing CI or creating a second deployment path.

Vercel's build runs `vp run build:all` and then `scripts/vercel-prepare.mjs` using that environment's existing server secrets. Schema preparation and initial-admin seeding are idempotent. A new deployment never resets the database, rotates signing keys or imports another environment's data. Review schema changes and verify a backup before approving a release: a failed build can leave a forward schema migration applied even though the new app was not published.

## Deployment environments and credentials

Configure GitHub **Settings → Environments**:

- **production:** allow only `main`; require the owner's approval, permitting self-review while working solo.
- **preview:** allow the protected branches. The `workflow_run` trigger executes from the default branch, but the workflow validates that the completed run was a successful push to this repository's `dev`, checks out its exact SHA, and rechecks current dev CI before deploying. Fork/PR completion events do not qualify.

Set these in **each** GitHub deployment environment:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `VERCEL_TOKEN` | Expiring deployment token, scoped to the project if available; otherwise the intended Vercel team only |
| Secret | `VERCEL_AUTOMATION_BYPASS_SECRET` | Existing Vercel automation access for health checks on protected Preview/unique deployment URLs |
| Variable | `VERCEL_PROJECT_ID` | The one `prj_…` project identifier |
| Variable | `VERCEL_TEAM_ID` | Its `team_…` owner identifier |
| Variable | `VERCEL_PRODUCTION_URL` | Production HTTPS origin |
| Variable | `VERCEL_PREVIEW_URL` | Preview HTTPS origin |

Keep signing keys, database URLs, archive/data keyrings and application-admin credentials in Vercel, never in GitHub workflows or repository files. The deployment token can operate on its permitted Vercel resources; treat write access to protected branches and workflow files as privileged access. Prefer a 90-day token lifetime, rotate before expiry, and revoke superseded tokens after testing the replacement. A Vercel CLI OAuth sign-in is not a GitHub Actions credential.

## Running and verifying deployment

In GitHub **Actions → Deploy Vercel → Run workflow**, choose `dev` plus **preview** for a manual preview retry, or `main` plus **production** for an approved release. These commands work in Bash and PowerShell:

```sh
gh workflow run deploy-production.yml --repo zdevzone/keyforge --ref dev -f target=preview
gh workflow run deploy-production.yml --repo zdevzone/keyforge --ref main -f target=production
gh run list --repo zdevzone/keyforge --workflow deploy-production.yml --limit 5
```

The workflow validates repository/project/domain identities, successful push CI and its aggregate gate. Production also requires a ready, healthy dev deployment with the same Git tree. It builds Production with Production variables without assigning its domains, confirms Vercel built the requested SHA and branch, checks health, rechecks main, then assigns Production domains and checks the canonical URL. Preview domains remain attached to dev. Read the run summary for the actual deployment ID and URL.

A failed, blocked or timed-out deployment does not trigger a blind second build. Inspect its ID in Vercel before starting another run. If main/dev advanced, run the workflow for its latest tested commit. The API pins both branch and SHA instead of deploying a moving branch tip.

Production's daily backup cron does not execute in Preview; Preview backups are manual unless you explicitly configure another scheduler. See [Vercel deployment](vercel.md) for platform limits, secure bootstrap and recovery verification.

## Retirement, failures and rollback

The old Render service is suspended, rather than deleted, after Vercel production acceptance. Keep its recovery keys outside the host. Do not resume it or send clients to its old URL unless deliberately performing recovery; old Render records are not synchronized with new Vercel writes. Render templates remain supported for people self-hosting their own installation, but no current deployment workflow targets Render.

For application rollback, first assess database compatibility, then select a previous **Production** deployment in Vercel or use its rollback controls. Never select a dev Preview containing staging credentials. Follow up with a revert PR to keep source history aligned. Rolling back code does not reverse database migrations or restore data; database restoration is a separate maintenance operation with a verified archive and matching recovery keys. See [backups](backups.md).

## npm releases and security

See [publishing](publishing.md) for stable/beta channels, trusted publishers, package order and safe retries. Stable uses `main` and `latest`; beta uses `dev` and `beta`. Both require manual dispatch and approval. Keep personal accounts protected by two-factor authentication and save recovery codes. Review collaborators, environment tokens, trusted publishers, dependency alerts and workflow changes regularly. Report vulnerabilities privately through [SECURITY.md](https://github.com/zdevzone/keyforge/blob/main/SECURITY.md).

## Repository presentation

The repository About website points to the live production app. GitHub Deployments lists Production and dev Preview with their environment URLs. Historical GitHub Pages and npm entries are inactive. Package publishing keeps its `npm` environment approval and OIDC identity without creating app deployment records. Preview records explicitly use the deployed dev commit, since `workflow_run` itself runs in the default-branch context. Keep the `npm`, `preview` and `production` environment names stable because publisher trust and approval policies reference them.

Create an explicit GitHub source release only after the selected main commit passes CI. Source tags and downloadable source archives do not publish npm packages. Link the three npm packages in the README and release notes; GitHub’s Packages panel lists GitHub-hosted registries and does not import npm listings.
