# Configuration and environment

For a complete first setup, follow the [beginner guide](getting-started.md). Copy `.env.example` to `.env.local` before provisioning secrets, replace its placeholders, and never commit the resulting file. A placeholder that happens to pass length validation is not a secure secret.

## Database selection

`DATABASE_URL` selects Postgres for both the license ledger and Better Auth operator tables. When present, local database paths are ignored. There is no fallback to SQLite if the external database fails.

Without `DATABASE_URL`, licensing and operator identity/session data share `LICENSE_DB_PATH` (default `licenses.sqlite`). Backups capture both datasets together. There is no legacy split-file import. See [Database setup and demo data](database.md) for fresh setup and demo resets. PostgreSQL continues using its shared database.

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

Postgres pools use the shared pool factory, bounded connections, explicit TLS handling and error listeners. Ledger migrations serialize using a transaction-scoped advisory lock. Better Auth schema migration should run through one initial instance before expanding an operator-enabled deployment. For Postgres databases that ran Better Auth 1.7.0–1.7.2, startup automatically relaxes the obsolete required account.issuer column and removes its legacy index while preserving account values and password hashes. Duplicate provider/account identities are refused before that compatibility change. See the [upstream upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide#account-identity-keeps-the-provider-key).

All backup providers can be configured simultaneously. Each owns an independent daily UTC schedule in the database. Custom URLs are managed through the console. See [backups and recovery](backups.md) for credential aliases, upload formats, local cache and retention behavior.

## The root JSON file and the GUI

`keyforge.config.json` is deployment policy, validated at startup: branding, key formatting, rate limits, registry privacy, audit/backups switches and operator administration scope. Its plan presets, grace window and retired public keys seed the default product once. Once imported, the database catalog is authoritative. Editing JSON does not overwrite later GUI changes.

Manage products, trial policy, signing rotation, definitions, plans and meters in the console. Plan values are defaults copied into a newly issued license, not live references. Editing a plan leaves existing license entitlements, seats and expiry unchanged. Definitions constrain explicit grants; a definition's default is an editor suggestion, not a grant to every license. Archived plans/definitions cannot be used for new grants.

Catalog export/import transfers definitions and plan presets only. Preview returns a fingerprint; apply requires that fingerprint and fails if the catalog changed. Secrets and live licenses are excluded.

`registry.enabled=false` hides census surfaces; credential identity and trial enforcement still require minimal server records. `collectUserInfo=false` prevents customer name/email storage. Do not send unnecessary personal information.

## Local development and demo maintenance

A local plaintext HTTP server needs an http://localhost:PORT LICENSE_SERVER_URL; an HTTPS base URL causes secure console cookies to be unavailable over HTTP. The active local database is LICENSE_DB_PATH; BETTER_AUTH_URL and legacy UploadThing secret variables are unnecessary for this setup. Dedicated backup provider settings avoid mixing AWS and R2 credentials.

Use the reset, cleanup, demo seed and bucket setup commands in the [CLI guide](cli.md#reset-cleanup-and-demo-data). They select the same active database as the server. Demo seeding is explicit; normal startup never adds fictional customer records.
