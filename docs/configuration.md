# Configuration and environment

For a complete first setup, follow the [beginner guide](getting-started.md). Copy `.env.example` to `.env.local` before provisioning secrets, replace its placeholders, and never commit the resulting file. A placeholder that happens to pass length validation is not a secure secret.

## Database selection

`DATABASE_URL` selects Postgres for both the license ledger and Better Auth operator tables. When present, local database paths are ignored. There is no fallback to SQLite if the external database fails.

Without `DATABASE_URL`, licensing and operator identity/session data share `LICENSE_DB_PATH` (default `licenses.sqlite`). Backups capture both datasets together. The database is created directly from the current schema. See [Database setup and demo data](database.md) for fresh setup and demo resets. PostgreSQL continues using its shared database.

The CLI, server and admin seeding use the same selection rules. System settings shows the selected backend and warns when local paths are ignored. A ledger copy transfers licensing data only; it does not transfer operator accounts.

## Secrets with different purposes

| Setting | Purpose |
| --- | --- |
| `LICENSE_AUTH_SECRET` | Better Auth cryptographic secret for the web console. Missing disables console authentication. |
| `LICENSE_ADMIN_TOKEN` | Optional privileged bearer credential for automation and the admin CLI. Missing disables that access method. Keep it out of customer apps. |
| `LICENSE_SERVER_URL` | Public server origin, used for console authentication and as the CLI destination. Overrides Render's `RENDER_EXTERNAL_URL` when supplied. A valid explicit URL or Render fallback is required for the production console. |
| `RENDER_EXTERNAL_URL` | Render-provided public URL. Used automatically for console authentication when `LICENSE_SERVER_URL` is unset or empty. Configure `LICENSE_SERVER_URL` to use a custom domain. |
| `BETTER_AUTH_URL` | Better Auth's generic environment convention. Keyforge passes its own explicit base URL from `LICENSE_SERVER_URL`; configure that canonical setting. |
| `LICENSE_SIGNING_KEY` / `LICENSE_SIGNING_KEY_FILE` | Ed25519 private signing material. Exactly one source must be configured. Startup fails without a valid key. |
| `LICENSE_PUBLIC_KEY` | A dependent app convention for its trusted public verification key; Keyforge does not read this variable. Public keys are shared; private keys stay on the server. |
| `LICENSE_DATA_KEYRING` / `_FILE` | AES-256-GCM ring for product keys and generated per-product private keys. Required for issuance, additional products and encrypted key recovery. |
| `LICENSE_BACKUP_KEYRING` / `_FILE` | Separate archive encryption ring. Required for archive jobs and their restore/verification, not raw SQLite downloads. |

Use `vp run secrets:init` to generate independent data and backup ring files. A ring has `{"active":"id","keys":{"id":"<64 hexadecimal characters>"}}`. Keep old keys while records or retained archives still reference them. Changing the active ring ID affects new encryption; it does not re-encrypt existing records. Store rings outside backups and source control, with a separate recovery copy.

Generate signing material with `vp run license keygen`; it follows `LICENSE_SIGNING_KEY_FILE` and prints the public half. Generate each console/admin secret separately with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`, then save it privately in the appropriate environment setting. This command prints a real secret in the terminal. Do not reuse the signing key, data ring or backup ring as a console secret. `secrets:init` creates the two ring files; it does not populate `LICENSE_AUTH_SECRET` or `LICENSE_ADMIN_TOKEN`. The scaffolder can generate all of these independently for a new deployment.

## Deployment wiring

| Setting | Default / behavior |
| --- | --- |
| `LICENSE_PORT`, `PORT` | LICENSE_PORT wins, then platform PORT, then 4100. |
| `LICENSE_HOST` | 0.0.0.0 |
| `LICENSE_CONFIG` | keyforge.config.json |
| `LICENSE_DB_POOL_MAX` | 5, bounded 1–100 |
| `LICENSE_SIGNING_KID` | Derived from the startup key fingerprint |
| `LICENSE_SEED_ADMIN_EMAIL` / `_PASSWORD` | Optional idempotent first-operator creation; never resets an existing password. |
| `LICENSE_BACKUP_DIR` | ./backups |
| `LICENSE_BACKUP_S3_BUCKET`, `_REGION`, `_ENDPOINT` | Optional S3 destination; region defaults to AWS_REGION or us-east-1. |
| `LICENSE_BACKUP_S3_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_SESSION_TOKEN` | Dedicated S3 credentials; otherwise the AWS SDK provider chain. |
| `LICENSE_BACKUP_R2_BUCKET`, `_ACCOUNT_ID` / `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_SESSION_TOKEN` | Independent R2 S3 API settings; region auto. |
| `LICENSE_BACKUP_UPLOADTHING_TOKEN` / `UPLOADTHING_TOKEN` | UploadThing current app token. Canonical variable wins. |
| `LICENSE_BACKUP_CUSTOM_*` | Optional complete header values referenced by custom upload endpoints; no authentication required for public URLs. |
| `LICENSE_BACKUP_VERIFY_DATABASE_URL` | Separate scratch administrator connection with temporary database creation permission. |

Postgres pools use the shared pool factory, bounded connections, explicit TLS handling and error listeners. Ledger migrations serialize using a transaction-scoped advisory lock. Better Auth schema migration should run through one initial instance before expanding an operator-enabled deployment.

All backup providers can be configured simultaneously. Each owns an independent daily UTC schedule in the database. Custom URLs are managed through the console. See [backups and recovery](backups.md) for credential aliases, upload formats, local cache and retention behavior.

## The root JSON file and the GUI

`keyforge.config.json` is deployment policy, validated at startup: branding, key formatting, rate limits, registry privacy, audit/backups switches and operator administration scope. Its plan presets, grace window and retired public keys seed the default product once. Once imported, the database catalog is authoritative. Editing JSON does not overwrite later GUI changes.

The optional [example policy](examples/keyforge.config.example.json) lives in `docs/examples/` and is not loaded automatically. To try it on a fresh setup, copy it to the repository root as `keyforge.config.json`, review the illustrative values, then restart the server. Alternatively, point `LICENSE_CONFIG` to a customized copy. The application uses built-in defaults when no policy file exists. Keep private signing keys and other secrets out of this JSON; add only real retired **public** keys to `signingKeys.retired` when needed. Plan prices and current product policies are managed in the console.

This file is **not** the input for **Entitlements → Import or export catalog**. That workflow accepts a catalog exported from the console, containing definitions and plans. The configuration example is a server policy reference, not a license or customer-data import.

Manage products, trial policy, signing rotation, definitions, plans and meters in the console. Plan values are defaults copied into a newly issued license, not live references. Editing a plan leaves existing license entitlements, seats and expiry unchanged. Definitions constrain explicit grants; a definition's default is an editor suggestion, not a grant to every license. Archived plans/definitions cannot be used for new grants.

Catalog export/import transfers definitions and plan presets only. Preview returns a fingerprint; apply requires that fingerprint and fails if the catalog changed. Secrets and live licenses are excluded.

`registry.enabled=false` hides census surfaces; credential identity and trial enforcement still require minimal server records. `collectUserInfo=false` prevents customer name/email storage. Do not send unnecessary personal information.

## Local development and demo maintenance

A local plaintext HTTP server needs an http://localhost:PORT LICENSE_SERVER_URL; an HTTPS base URL causes secure console cookies to be unavailable over HTTP. The active local database is LICENSE_DB_PATH; BETTER_AUTH_URL and legacy UploadThing secret variables are unnecessary for this setup. Dedicated backup provider settings avoid mixing AWS and R2 credentials.

Use the reset, cleanup, demo seed and bucket setup commands in the [CLI guide](cli.md#reset-cleanup-and-demo-data). They select the same active database as the server. Demo seeding is explicit; normal startup never adds fictional customer records.

## Minimal environment and database-managed storage

Run `vp run secrets:init` to fill missing local secrets and file references in `.env.local`; existing setup requires confirmation. The default private key path is `secrets/license-signing.key`. Never configure both inline and file values for the same key.

## Portable environments and recovery files

Application credentials are independent of the hosting provider. Use one private environment directory for each deployment, and keep provider access tokens separate:

```text
.env.local                               # local development
secrets/license-signing.key               # existing local signing key
secrets/data.keyring.json                 # local stored-data encryption
secrets/backup.keyring.json               # local archive encryption
secrets/environments/staging/server.env   # staging server settings
secrets/environments/staging/keys/        # staging file-based keys, when used
secrets/environments/production/server.env
secrets/environments/production/keys/
secrets/providers/                        # provider administration tokens, not app configuration
secrets/recovery/                         # old host exports and migration recovery copies
```

All of `secrets/` and local environment files are ignored by Git. They are not public documentation, client configuration, a backup of the database itself, or files to include in a container image. Store a separate secure recovery copy outside this checkout. Unix file modes are restricted when writing new files; Windows users should also restrict the directory's access using their account permissions.

For a **new** staging installation, run the following from the project root (Bash or PowerShell):

```sh
vp run secrets:init --env-file secrets/environments/staging/server.env
```

This creates independent keys in that environment's `keys/` directory, then writes their project-root-relative paths plus new admin, session and cron secrets into its environment file. Use `--secrets-dir PATH` to choose a different private key directory. The same command works for `production` or another environment name. An explicitly selected environment ignores ambient server credentials, so a local development file or a production shell cannot silently supply the new environment's keys. Existing values and key files are retained; existing configuration requires confirmation (`--yes` for deliberate automation).

Set `LICENSE_SERVER_URL` to that deployment's public HTTPS origin, configure its own database and bootstrap operator, and set `NODE_ENV=production` for hosted operation. Leave `LICENSE_PORT` unset on platforms that assign `PORT`. Use persistent SQLite storage or PostgreSQL as appropriate. Keep staging and production databases, keyrings, signing keys and backup destinations independent. Configure backup storage credentials in **Settings → Backups**; provider-specific tokens are not universal server secrets.

For hosts whose secret manager accepts inline values, export a private deployment bundle:

```sh
vp run secrets:export --env-file secrets/environments/staging/server.env --output secrets/environments/staging/deploy.env
vp run license keycheck --env-file secrets/environments/staging/deploy.env
```

The exporter embeds the existing signing/data/backup files into their inline variables, removes the corresponding `_FILE` settings, and omits platform identity/build variables such as `VERCEL_*`, `NEON_*` and `TURBO_*`. It writes values only to the selected file, not the terminal, and does not rotate keys or change the source files. Replacing an existing export requires confirmation. Keep the complete bundle secret; install its individual variables through your host's secret manager. On a persistent server, file references work equally well if you securely mount the files at their configured paths. Always run relative file references from the project root.

Changing hosts is a **restore**, not fresh initialization: retain the original signing key, session secret, data and backup rings. Restore real values before exporting. A host export containing `[SENSITIVE]` is incomplete; setup/export refuse that placeholder rather than inventing replacement keys. Never substitute demo or staging keys. `vp run license keygen --env-file PATH` remains available for deliberate new keys, with `--force` required to overwrite an existing key; plan client trust and retired-key handling before rotation.

Only the server URL, stable product ID, approved public verification keys and public API contract belong in a dependent app. `default` is the automatically seeded product ID, not a universal ID for every application. Select the product actually owning the existing licenses; display names and the token issuer are not substitutes for a product ID. See [dependent-app integration](dependent-app-integration.md).

Manage backup-provider credentials in **Settings → Backups**, where they are encrypted with the external data keyring. Provider environment settings below are optional deployment defaults; they are not imported or migrated into database settings. Prefer Settings for versioned, editable credentials. Signing keys, authentication secrets, data/archive encryption rings, database URLs, cron authentication and deployment URLs remain server configuration. They cannot safely depend on an unavailable database during recovery.

For the Vercel deployment, only `DATABASE_URL` is read as the application database connection. The integration aliases `PG*`, `POSTGRES_*`, `DATABASE_URL_UNPOOLED` and `NEON_PROJECT_ID` are not needed by KeyForge. Do not remove an alias that another app sharing the project uses. Keep `LICENSE_BACKUP_VERIFY_DATABASE_URL` separate and retain seed credentials if build-time admin bootstrapping is still required. `VITE_KEYFORGE_ANALYTICS` remains a nonsecret, Production-only build preference. Platform-supplied Vercel variables are platform metadata rather than application configuration.
