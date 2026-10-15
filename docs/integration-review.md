# Implementation review and future architecture

## Implemented model

The core is a single-company, self-hosted workspace with multiple independent products. Product-scoped catalogs, signing keys, licenses, credentials, support and usage records avoid coupling the server to one application. A subject can be an installation or a service instance; enforcement is still based on a registered identity and seat binding. Typed entitlements describe capabilities; application code interprets them.

MIT self-hosting remains independent of a hosted paid service. Better Auth handles console identity, not customer subscription billing. The current code contains no multi-vendor hosting, payment collection, vendor onboarding or SaaS billing.

The former read-only catalog now has definition/preset management, usage and previewed import/export. Support has assignment, lifecycle actions and public/internal messages for admins and support operators. Profile/session/password controls and an account dropdown are available. Key reveal requires admin access, password verification for sessions, encryption and auditing. Backups have direct download, encrypted jobs, verification and history, with independent daily UTC schedules and retention for local storage, AWS S3, Cloudflare R2, UploadThing and custom upload URLs. Custom endpoints may be anonymous; retained local copies provide downloads even after an upload fails.

## Resolved flaws

- Unauthenticated installation ID possession no longer authorizes device operations; a separate credential is required.
- Product namespaces isolate catalogs and device operations.
- Atomic database decisions prevent seat and quota races across processes.
- Per-request/event idempotency survives network retries; refresh does not reset consumption.
- Runtime, CLI and operator seeding share database precedence. Auth handles and Postgres pools close cleanly.
- Token diagnostics separates untrusted decoding, signature, schema and current authorization.
- Signing/encryption sources are validated and ambiguous dual sources fail startup.
- UI dialogs have focus containment and keyboard dismissal; the account menu exposes profile and account security.
- Vite+ manages one workspace lockfile; deployed runtime metadata pins resolved production dependency versions.

## Current limitations

Product/domain data is JSON in a scoped record table. Lists load records and filter in memory, and one workspace write lock serializes mutations. This is a correctness-first implementation for modest self-hosted deployments, not a benchmarked high-volume multi-vendor system. Introduce indexed normalized domain tables and narrower locks before scaling.

All operators belong to the same workspace. There is no vendor/organization isolation, product-specific staff membership, customer account portal login, payment gateway, automated usage pricing, webhooks, public SDK release, HA failover automation or realtime support notifications. A TypeScript client SDK, offline authorization evaluator, Node reference integration, client OpenAPI contract and AI integration skill are provided in the repository. SDK publication is a separate release step. Customer replies require polling. Emails and attachments are absent. Audit events are written after domain transactions, so an audit write failure can leave a successful mutation without a corresponding event.

Offline signed grants cannot be revoked immediately. Hardware hashes and client-local trial counters are forgeable on a compromised device. Secure backend metering gives authoritative quotas, but it cannot make an end-user binary tamper proof.

Key-ring rotation retains old keys but does not bulk re-encrypt stored data. Historical hash-only product keys cannot be reversed. Installation credential recovery/rotation is not yet provided. Backup jobs buffer data; Postgres archives have a size cap. SQLite auth and licensing share one database, so snapshots cover both. Database mirrors are snapshots, not replication. The current container retains root execution for existing volume ownership compatibility; a non-root deployment needs an explicit ownership migration.

The fresh device contract intentionally breaks old app integrations. Ledger migrations preserve history, but client upgrades and re-registration are required.

## Hosted paid edition proposal

1. Add workspace/vendor IDs enforced in every database query and foreign key; scope locks, credentials, key providers and storage prefixes. Provide tenant isolation tests, membership roles and product permissions.
2. Add vendor onboarding, organization ownership transfer, invitation/session controls, resource quotas and plan-based hosted billing. Keep license data and self-hosted APIs usable without the billing package.
3. Replace broad JSON scans with indexed tables and transactional audit/outbox events. Publish versioned client SDKs and webhook delivery with stable event IDs, retries and signing.
4. Add provider interfaces for KMS/HSM signing and envelope encryption, streaming backups, external durable job workers, least-privilege deployment with tested volume ownership migration, observability and recovery drills.
5. Offer shared hosted tenancy first with measured isolation/performance; optionally offer dedicated databases/regions for customers requiring stronger boundaries.

Keep commercial orchestration in separate modules around the MIT core. Define explicit API version policy and migration tooling before committing to long-lived client compatibility. Do not advertise multi-vendor isolation until those boundaries and restore paths are verified.
