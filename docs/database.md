# Database setup and demo data

## Fresh v1 baseline

The development baseline uses only product-scoped v1 records and a fresh schema. Previous databases, tokens and client state are not converted or accepted. Stop the development server and use the explicit offline reset below, or create a new empty database. Retain signing keys and encryption keyrings; no key rotation is needed. Never point the reset at a deployed database without a separate deliberate maintenance operation. See [client integration](dependent-app-integration.md) and [token verification](verify-token.md).

## Reset from Settings

Administrators can use **Settings → System → Reset application data**. The dialog identifies the retained first seeded administrator and requires typing `DELETE ALL`. The backup checkbox is selected initially. When selected, reset proceeds only after an encrypted full database backup passes verification; the new archive is available in **Settings → Backups** after reset. An unconfigured/failed backup does not silently fall back to deleting without one. Keep the backup encryption ring to restore the archive.

This online reset deletes licensing, sales/payments, conversations, notifications, product settings and other operators in one transaction. It preserves the first seeded administrator's ID, current credentials/profile and non-impersonated sessions, plus schema state and minimal replay metadata. Other operators lose their sessions. Deployment defaults recreate the default product/plans; signing keys, external configuration and archive files remain. Existing offline tokens may continue working until they expire.

The bootstrap user ID is recorded once when `seedOperator` successfully creates or recognizes an admin, and later seed emails cannot replace it. Existing installations establish that marker on their next configured seed run; credentials are not overwritten. If the original seeded administrator is unknown, missing, banned, lacks password credentials or is no longer an admin, the online reset is unavailable. Configure the original `LICENSE_SEED_ADMIN_EMAIL` and `LICENSE_SEED_ADMIN_PASSWORD` and restart to recognize an existing account. The system never guesses that the oldest user or the current operator is the original seeded administrator.

SQLite backups use a committed WAL reader while the reset holds the writer lock. PostgreSQL locks owned application tables and verifies archives by restoring into a temporary database using the existing backup tools; configure `LICENSE_BACKUP_VERIFY_DATABASE_URL` separately. Unrelated SQLite tables or external Postgres foreign-key dependencies block the operation. Schedule a maintenance window for multi-instance deployments; requests already accepted by another instance may finish after locks are released.

The existing offline commands below retain their original behavior: they can remove every operator and seed a new dataset, so they are distinct from the account-preserving console action.

## Offline demo maintenance

SQLite uses `LICENSE_DB_PATH` (default `licenses.sqlite`) for licensing, operators, credentials, sessions and related records. Auth tables use the `keyforge_auth_` namespace. Startup creates missing schemas directly; it does not import `auth.sqlite` or use `LICENSE_AUTH_DB_PATH`. PostgreSQL continues using `DATABASE_URL` with its existing table names and migrations.

The development data is disposable. After building the administrative modules, stop all server processes and preview the reset:

```sh
vp run build
vp run demo:reset
vp run demo:reset --apply --maintenance --scope database
```

The reset removes demo users, sessions and application records, recreates the schemas, and seeds a new demo dataset. Previous session cookies stop working; sign in with the configured bootstrap administrator or the newly seeded demo operator. Signing keys, encryption rings and provider credentials are preserved. The command refuses unrelated database tables or paths outside the repository.

The demo seeder requires signing keys, `LICENSE_AUTH_SECRET` and the data encryption ring. It writes credentials and fixture IDs to `.artifacts/demo/manifest.json`; keep this private. Repeating `vp run demo:seed --maintenance` reuses the current dataset. A reset creates a new one. `--clean-local` removes recognized obsolete app databases and demo backup archives; unrelated files are retained.

Only current v1 databases and archives are supported. Use a fresh development database rather than importing a pre-baseline dataset. Production backups still use the regular [backup and restore workflow](backups.md), with one SQLite snapshot containing both authentication and licensing.

Application-level Settings reset retains encrypted backup storage configurations, their historical credential versions and the default destination, alongside the original seeded administrator. A full schema/database drop remains a different administrative operation and removes database-managed configuration too. Retain independent provider-credential recovery copies before a full drop.
