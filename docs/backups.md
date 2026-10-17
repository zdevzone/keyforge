# Backups and recovery

Admins use **Settings → Backups** to configure destinations, enable independent daily UTC schedules, run **Back up now**, download archives, inspect upload results and verify recovery. All features are available in the self-hosted open-source server. The backup API and console require admin access.

On Vercel, follow [the serverless deployment and recovery guide](vercel.md). That mode requires durable remote archives, supports private Vercel Blob through `BLOB_READ_WRITE_TOKEN`, uses portable PostgreSQL archives, and replaces the continuous worker with authenticated hosted invocations. Local-only/custom upload-only destinations are disabled. Native-tool and persistent-directory instructions below describe persistent-server mode.

## Destinations and credential detection

| Destination | Server configuration |
| --- | --- |
| Local storage | Persistent `LICENSE_BACKUP_DIR` (default ./backups). |
| AWS S3 | `LICENSE_BACKUP_S3_BUCKET`, optional `LICENSE_BACKUP_S3_REGION` (default us-east-1), optional `LICENSE_BACKUP_S3_ENDPOINT`. Dedicated `LICENSE_BACKUP_S3_ACCESS_KEY_ID` / `LICENSE_BACKUP_S3_SECRET_ACCESS_KEY` / optional `LICENSE_BACKUP_S3_SESSION_TOKEN`; otherwise the AWS SDK credential chain, including AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN or an instance/task role. |
| Cloudflare R2 | `LICENSE_BACKUP_R2_BUCKET`, `LICENSE_BACKUP_R2_ACCOUNT_ID` or explicit `LICENSE_BACKUP_R2_ENDPOINT`, `LICENSE_BACKUP_R2_ACCESS_KEY_ID` / `LICENSE_BACKUP_R2_SECRET_ACCESS_KEY` / optional `LICENSE_BACKUP_R2_SESSION_TOKEN`. Uses the S3 API with region auto. |
| UploadThing | `LICENSE_BACKUP_UPLOADTHING_TOKEN` or `UPLOADTHING_TOKEN`: the current app token from UploadThing, not a legacy secret key. |
| Custom upload endpoint | Add a name and HTTP(S) URL in the console. Choose POST or PUT and multipart form (default field file) or a raw file body. Anonymous endpoints need no authorization settings. |

R2 also accepts R2_BUCKET_NAME, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_SESSION_TOKEN. Canonical LICENSE_BACKUP_ settings take precedence. AWS_REGION supplies the S3 region when the canonical setting is absent. Configure any or all providers together and restart the server after changing environment variables. “Configured” means credentials/settings were detected, not that permissions were tested. Access is checked during each operation, and failures appear in history.

For custom endpoints that require one authorization/API-key header, enter the header name and a dedicated environment variable name beginning LICENSE_BACKUP_CUSTOM_ in the console. Set the complete value on the server, for example `LICENSE_BACKUP_CUSTOM_BOX_TOKEN=Bearer ...`, then restart. The console stores the reference, never the header value. No header is sent for anonymous destinations. URLs may target local storage services or public upload servers; the endpoint owner manages storage and authentication.

The endpoint must accept the selected request format and return HTTP 2xx after persisting the file. Raw bodies use application/octet-stream and an attachment filename; multipart bodies include a UUID.kfbackup file. Redirects are not followed. A generic URL cannot automatically adapt to every provider's protocol; OAuth workflows, special multipart signing and multi-step uploads need an adapter. HTTP is supported for local services; HTTPS protects remote transport. Only admins may configure outbound destinations.

## Manual uploads and downloads

**Back up now** creates an encrypted archive for the chosen destination. The worker captures the database, retains an encrypted local copy, then uploads to that provider. Each provider has a separate action. History shows queued, creating snapshot, uploading, completed or failed, with a safe error message. Upload response bodies and credential values are not exposed.

A failed remote upload still allows **Download** and **Verify** if snapshot creation succeeded. Retry by creating a new job. There is no automatic retry after a worker lease expires or an ambiguous upload failure.

SQLite offers an immediate unified database download without an archive key. This sensitive file contains licensing, operators and sessions in one consistent snapshot. Postgres's **Download backup now** creates a local encrypted archive and downloads it when complete. Downloads of encrypted jobs are available for every destination through the same history controls.

Custom endpoints are upload-only: the retained local archive supplies downloads. S3, R2 and UploadThing can also retrieve their recorded remote object if the local copy is missing and the original provider configuration remains available. Keep the archive directory persistent; multiple instances need a shared directory to reliably download custom-endpoint jobs. Changing an object endpoint/region requires restoring the original configuration for historical remote reads and cleanup.

## Archives, schedules and retention

A .kfbackup archive is an authenticated AES-256-GCM envelope bound to its job UUID. Its manifest includes engine, capture timestamps, filenames and SHA-256 checksums. It excludes signing and encryption key files; database records may contain encrypted secrets. Retain matching recovery keys separately. Preserve the UUID when renaming an archive; restore needs --job UUID.

Generate an independent backup ring with `vp run secrets:init` and set LICENSE_BACKUP_KEYRING_FILE (or LICENSE_BACKUP_KEYRING). Archive jobs require it; raw SQLite downloads do not.

Postgres uses pg_dump in custom format to capture the shared database. Use pg_dump/pg_restore tools matching the server major version, and an equally new or newer verification/restore server. A newer pg_restore can emit settings unsupported by an older target (for example transaction_timeout on Postgres 16). CI selects the matching client binaries explicitly. Archives are buffered in memory; Postgres dumps are limited to 128 MiB. SQLite archives are also buffered. Use external streaming/database-native backups for larger installations.

Each destination has its own enabled switch, UTC hour and minute, and retention days (1–3650). Save the schedule after changing it. The worker checks every 30 seconds while the server runs; an overdue schedule produces one catch-up job, then advances to the next daily time. Disabled schedules do not affect manual backups or other providers. Existing single-destination schedules migrate automatically.

Database locks serialize claims across instances. A ten-minute worker lease bounds abandoned jobs; expired jobs become failed. Queued providers drain sequentially per process to bound memory. This scheduler depends on a running server.

Retention removes local archives and remotely stored S3/R2/UploadThing objects, keeping history. Read/delete permissions are needed in addition to upload. Cleanup failures remain visible and are retried on later ticks. Custom endpoint retention removes only the local copy; remote retention belongs to the endpoint owner. Removing a custom destination disables its schedule and preserves job history and local downloads.

For production, use persistent storage and retain recoverable copies outside the server. Keep provider credentials and backup rings in server environment/secret storage; do not commit them.

## Verify

SQLite verification decrypts, checks checksums and runs integrity_check in isolated temporary files. Postgres verification creates a random temporary database using LICENSE_BACKUP_VERIFY_DATABASE_URL, restores into it, then drops it. The verification connection must differ from production and allow CREATE DATABASE. Verification never restores production, and does not prove every application workflow.

## Restore

Stop every server process and all other writers first. Keep a separate target backup. Build restore modules with vp run build before the outage. Restore requires the matching LICENSE_BACKUP_KEYRING or its file source, and the original job UUID.

```sh
vp run backup:restore --file ./JOB_UUID.kfbackup --job JOB_UUID --maintenance --sqlite ./db/licenses.sqlite --replace
vp run backup:restore --file ./JOB_UUID.kfbackup --job JOB_UUID --maintenance --database "postgres://user:password@host/keyforge" --replace
```

SQLite validates every snapshot before writing targets, refuses existing files without --replace and refuses live WAL/SHM sidecars. Existing targets are copied to timestamped .before-restore files. SQLite archives contain one `database.sqlite` snapshot, verified in temporary storage before one staged file replaces the target. Split-file archives are not supported. Retain rollback copies. Postgres restoration runs pg_restore --single-transaction with clean/if-exists and requires --replace. It does not delete objects absent from the archive.

For raw unified SQLite downloads, validate integrity and foreign keys, stop connections, preserve the old file and replace the target manually. For an offline ledger-only standby use vp run db copy/mirror/verify; those do not copy operator authentication.

Before restarting, restore matching data/signing keys from separate secure storage and verify the backend selection. Check health, operator login, products, licenses, bindings, support and metering. A restore can roll back revocation and quota consumption; reconcile those events with your application records.

See [Database setup and demo data](database.md) for the shared database and demo reset commands.
