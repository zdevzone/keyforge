# Deploy Keyforge

Use Node 24 LTS, Vite+ 1.1.0, persistent storage and HTTPS. Current pinned development/deployment versions are Node 24.21.0 and pnpm 12.11.2, selected through Vite+. Install Vite+ using its [official installer](https://viteplus.dev/guide/install).

## Prepare

```sh
vp install --frozen-lockfile
vp run check
vp run test
vp run build:all
```

Configure exactly one valid Ed25519 private key source, the public LICENSE_SERVER_URL (or Render's automatic RENDER_EXTERNAL_URL), console LICENSE_AUTH_SECRET and data/backup ring files. Provision secrets on the host; never put them in manifests. LICENSE_ADMIN_TOKEN is optional automation access. See [configuration](configuration.md) for the full variable table, database precedence and ring recovery.

The entry is dist/src/index.js; the UI is dist/public. The build also writes dist/runtime-package.json containing resolved production dependency versions and ESM metadata for standalone deployments. The signing key is required at startup. In production, console auth also requires the public origin. Health is GET /healthz.

LICENSE_PORT overrides the host's PORT; otherwise 4100. Leave LICENSE_PORT unset on hosts that assign PORT. Seed the first admin with LICENSE_SEED_ADMIN_EMAIL/PASSWORD, or run vp run admin:create on a shell-enabled host. Boot seeding never resets existing operators.

## Vercel

See [Vercel deployment](vercel.md) for a single project with `main` production and `dev` preview, isolated PostgreSQL databases, private external archives, recovery verification and hosted cron. Keep an existing production host running until Vercel acceptance is complete.

## Docker

The Dockerfile builds with Vite+, installs only production dependencies into the runtime, includes compatible Postgres dump/restore tools, and starts the compiled Node server. Keep secrets outside the image. Build via docker build -t keyforge . or use docker compose up --build. Ports, volumes and secret mounts are infrastructure commands, not package-manager commands.

The repository compose file and new scaffolds use Postgres 18 with a volume mounted at `/var/lib/postgresql`. The repository uses a new `keyforge-pgdata-v18` volume, leaving any old Postgres 16 volume untouched. To move data from an older volume, use `pg_upgrade` or dump/restore; changing the image alone does not migrate it.

For SQLite, mount the ledger/auth directory, secrets and backup directory persistently. For Postgres, provide DATABASE_URL and a durable external database; local database paths are ignored. Mount key-ring files persistently in either case. Backup providers can run concurrently; configure S3, R2 and UploadThing credentials through server secrets, and custom upload URLs in the console. Keep LICENSE_BACKUP_DIR persistent (shared across replicas for custom-endpoint downloads). Each provider has an independent daily UTC schedule; see [backups](backups.md).

## Local or VPS

Use the prepare commands above, vp run start and a process supervisor/reverse proxy. Persist database files, encryption rings, startup signing keys and local archives outside replacement release folders. Graceful shutdown closes database/auth handles. Size Postgres pools per process so total instances stay within the provider's limit.

## Render

Use the repository's `render.yaml` with a Blueprint, or update an existing service under **Settings → Build & Deploy**. An existing dashboard-managed service keeps its saved commands when the repository changes.

- **Root Directory:** repository root (leave blank).
- **Build Command:** copy the `buildCommand` value from `render.yaml`:

  ```sh
  set -o pipefail && curl -fsSL https://vite.plus | VP_HOME="$HOME/.vite-plus" VP_VERSION=1.1.0 VP_NODE_MANAGER=no bash && export PATH="$HOME/.vite-plus/bin:$PATH" && NODE_ENV=development vp install --frozen-lockfile && vp run build:all
  ```

- **Start Command:** `node dist/src/index.js`.
- **Node version:** use `.node-version`; remove an old `NODE_VERSION` override or set it to the same version.
- **Health Check Path:** `/healthz`.

Render supplies `RENDER_EXTERNAL_URL` automatically. KeyForge uses that URL for console authentication when `LICENSE_SERVER_URL` is unset or empty. To use a custom domain, set `LICENSE_SERVER_URL` to its HTTPS origin; the explicit value always wins. This fallback uses platform environment configuration, never request headers. Other production hosts still need an explicit URL when the console is enabled.

The build installs the pinned Vite+ CLI into a user-writable directory, adds it to this build's PATH, installs all workspaces from the lockfile (including build dependencies even when `NODE_ENV=production`), and compiles both server and console. Startup calls Node directly and does not depend on the build shell's PATH. The `packageManager` field correctly names pnpm, which Vite+ manages; do not switch it to Yarn to match an outdated dashboard command. After replacing the old build command, use **Manual Deploy → Clear build cache & deploy** once to discard the old package-manager cache.

New Vite+ scaffolds bootstrap the same toolchain but allow generating a lockfile on their first build. Commit the generated lockfile and switch to `--frozen-lockfile` for subsequent deployments.

Select Postgres or attach a persistent disk for SQLite. Ephemeral/free instances cannot retain a local ledger, generated signing keys or encryption rings. Store all required keys in provider secrets or durable mounts. Leave `LICENSE_PORT` unset to use Render's assigned `PORT`.

## Fly.io

Use the generated fly.toml and Dockerfile. SQLite requires a persistent volume and a single active writer deployment model. Multi-instance deployments should use Postgres plus object-storage archives and a shared/persistent backup cache. Configure secrets through the provider and leave the platform port wiring intact.

## Railway

Use the generated railway.json/Dockerfile, set DATABASE_URL when attaching Postgres, and provide durable secrets. Do not rely on an ephemeral image filesystem for SQLite or encryption-ring persistence.

## Koyeb

Use the generated Koyeb deployment script and Dockerfile. Managed Postgres is appropriate for ephemeral instances. The script deploys infrastructure; review its project/region values before running it.

## cPanel

Read [the cPanel guide](cpanel-guide.md) and the repository cPanel skill before editing .cpanel.yml. cPanel's Git deployment is outside the application's Node environment: never install or build in that task.

Build locally or in CI. Deploy dist/ and copy dist/runtime-package.json to the application root as package.json. Provision production modules separately using the host's Node environment and vp install --prod, or its supported equivalent installation control. Do not deploy the workspace development manifest, node_modules, Git history, databases or secret rings. Passenger uses dist/src/index.js through the configured entry and reloads after touch tmp/restart.txt.

The deployment task only copies prebuilt artifacts and touches the restart file. Runtime install happens separately, not inside .cpanel.yml. If the host cannot provide a compatible Node/native SQLite build, use Postgres and a suitable supported runtime deployment.

## Backup and upgrade

Disable writers before database copies/restores. Verify archives on isolated targets. Restore matching signing/data rings before restarting. Do not treat /healthz alone as proof of operator login, licensing and quota enforcement. Review [limitations and future architecture](integration-review.md) before planning multi-vendor hosting.

For standalone Vite+/pnpm runtime installs, also deploy dist/runtime-pnpm-workspace.yaml as pnpm-workspace.yaml. It allows the required native SQLite build while omitting development workspace catalogs. Keep the runtime packageManager pin.
