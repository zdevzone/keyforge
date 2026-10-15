# Administrative CLI

All project commands use Vite+. Script arguments pass directly through `vp run`. Build the server first with `vp run build`. Scripts use compiled modules from dist/src.

Set `LICENSE_SERVER_URL` and `LICENSE_ADMIN_TOKEN` for API commands. Use `--product <id>` to select a product (default default). Do not give this token to dependent apps.

| Command | Purpose |
| --- | --- |
| `vp run license keygen` | Generate startup Ed25519 keys; private path follows LICENSE_SIGNING_KEY_FILE. --force overwrites and can invalidate client trust. |
| `vp run license keycheck` | Check configured private key, public fingerprint; --expect PEM/file, --token token, --server compare deployment. |
| `vp run license issue` | Issue from --plan ID with --to name, optional --installation ID or --subject installation/service, and a stable --request-id UUID. Add --paid --method METHOD --reference ID to record full payment. Terms come from the saved plan. |
| `vp run license list` | First page of selected product licenses. |
| `vp run license inspect` | Decode a token/payload only; does not verify trust. |
| `vp run license revoke` | Revoke the following license ID. |
| `vp run license activations` | List bindings for the following license ID. |
| `vp run license deactivate` | Release a license ID with --installation ID. |
| `vp run license machines` | Search --q reference/id and --limit count. |
| `vp run license clear` | Clear the following machine ID for one further trial registration. |
| `vp run db copy` | Copy a ledger with --from file/URL --to file/URL; --replace explicitly replaces existing destination data. |
| `vp run db mirror` | Copy the configured active ledger to --to file/URL. |
| `vp run db verify` | Compare --from and --to engine-neutral row contents. |
| `vp run admin:create` | Create an operator with --email and --password; --name and --role admin/support are optional. |
| `vp run secrets:init` | Generate independent data and backup encryption rings without overwriting existing files. |
| `vp run backup:restore` | Explicit maintenance-only restore of an encrypted archive; see backups guide. |

```sh
vp run license issue --product photos --plan pro --to "Acme" --request-id 550e8400-e29b-41d4-a716-446655440000
vp run license deactivate LICENSE_ID --product photos --installation INSTALLATION_ID
vp run db copy --from ./db/licenses.sqlite --to ./standby/licenses.sqlite
vp run db verify --from ./db/licenses.sqlite --to ./standby/licenses.sqlite
```

Definitions and an active plan must exist before issuance; create them in the console. Keys are retained encrypted when a data ring is configured. Existing hash-only records require secure original-key re-entry for recovery.

Generate a fresh UUID for each new issuance; reuse it and the same arguments only when retrying that issuance. The example UUID is illustrative. The issue dialog shows the selected plan's terms and price without allowing overrides. Separate existing-license edits display UTC expiry dates: editing a customer without changing the date preserves the existing timestamp; choosing another expiry date uses the end of that UTC day. Plan and definition edits affect future issuance, while existing licenses retain their snapshots.

Database copy is an offline ledger operation, not live replication. It carries historical and product-scoped licensing records, support, meters and backup history; operator accounts and external encryption/signing keys are excluded. Stop all writers for a consistent source and back up the destination before replacement. Do not run the production server against two mirrored copies.

## Reset, cleanup and demo data

Build once with `vp run build`. Reset and cleanup default to a preview. Stop every Keyforge process before applying a change; commands refuse a listening local server and require --maintenance. Signing keys, encryption rings, provider credentials and remote bucket contents are preserved.

```sh
vp run db:reset
vp run db:reset --apply --maintenance
vp run db:reset --scope database --apply --maintenance
vp run data:clean
vp run data:clean --apply --maintenance
vp run demo:seed --maintenance
vp run demo:reset --apply --maintenance --scope database
vp run storage:init
```

The default app reset drops and recreates Keyforge ledger and operator tables, then recreates the configured bootstrap admin. SQLite database mode removes and recreates the single selected unified database file. SQLite resets refuse unrelated tables and paths outside the project. data:clean removes obsolete Keyforge SQLite files under db/database and UUID .kfbackup files in the configured backup directory; it retains active databases, unrelated databases and key files. It leaves remote uploads and backup history intact, so standalone cleanup can remove local-only download copies. demo:reset combines reset, local cleanup and seed. These offline commands differ from the account-preserving **Settings → System** reset; see [database maintenance](database.md).

Demo seed creates fictional products, active/expired/revoked licenses, registered and trial machines, support conversations, metered usage and admin/support operators. Random demo login credentials and client fixture IDs are written to the private, ignored .artifacts/demo/manifest.json file. The stored seed manifest is encrypted using the data ring. Completed seeds are idempotent; interrupted seeds require a reset before retrying. Existing configured bootstrap credentials are retained separately in .env.local. Demo sign-up is enabled only inside the unserved seeding process; the running app still disables public sign-up.

Postgres app mode preserves unrelated tables and fails if external dependencies prevent dropping app tables. For a dedicated app schema, use `vp run db:reset --scope schema --confirm SCHEMA_NAME --apply --maintenance`; unrelated objects or cross-schema foreign keys/views prevent a schema reset. Schema mode recreates the owner but not custom grants, which must be reapplied.

For a whole Postgres database, set LICENSE_DATABASE_ADMIN_URL to a privileged connection to a different database on the same server, then run `vp run db:reset --scope database --confirm DATABASE_NAME --apply --maintenance`. This mode terminates connections and deletes everything in that explicitly named database. System databases are refused. Ownership, encoding and locale are retained; database grants/extensions/settings must be reapplied. Use the admin connection directly rather than a transaction pooler when the host requires it.

Reset removes online licensing records, operators, sessions and trial history. It does not rotate signing keys or invalidate already-issued offline tokens cryptographically; client expiry and online refresh still determine their remaining validity.

storage:init creates a uniquely named private AWS S3 and/or R2 bucket when a configured provider lacks a bucket, then writes its canonical setting to .env.local. Existing configured buckets are verified instead of recreated. Use --provider s3/r2/all, --name keyforge-storage-YOUR_UNIQUE_SUFFIX or --env-file PATH as needed. Setup needs bucket-creation permission in addition to normal backup permissions. S3 Block Public Access stays enabled. Provider request/storage charges apply to real uploads; configure independent schedules in Backups.

## Database setup and demo reset

Build the administrative modules with `vp run build`. Run `vp run demo:reset` to preview, then stop the server and use `vp run demo:reset --apply --maintenance --scope database` to recreate the demo database. `vp run demo:seed --maintenance` seeds without resetting. See [Database setup and demo data](database.md).

Restore current archives using `vp run backup:restore --file <archive> --job <UUID> --maintenance --sqlite <file> --replace`.

## Plan-based issuance

`vp run license issue --plan standard --to "Customer" --request-id UUID` copies saved plan terms and creates an unpaid ETB sale atomically. Configure the plan price first. Reuse the UUID when retrying. Overrides such as `--expires`, `--activations`, `--entitlements` and `--allowance` are rejected; edit the plan instead. Add `--installation ID` for authenticated dependent-app delivery, or share the returned key manually. Add `--paid --method "Bank transfer" --reference BANK_ID` to record full payment on today's UTC date. Existing records and signing/validation are unchanged. See [License requests and sales](license-sales.md).
