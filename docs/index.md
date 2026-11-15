# KeyForge documentation

Self-hosted license management for software products.

**New here?** Follow the [beginner guide](getting-started.md) to run the server and activate a license.

## Run a server

- [Project CLI](../packages/create-keyforge/README.md) — generate a deployment.
- [Configuration](configuration.md) — environment variables and defaults.
- [Deployment](deploy.md) — Docker, VPS, Render, Fly.io, Railway, Koyeb, Vercel and cPanel.
- [Vercel deployment](vercel.md) — hosted setup and backups.
- [cPanel deployment](cpanel-guide.md) — prebuilt releases and Passenger.
- [Backups and recovery](backups.md) — create, verify and restore archives.
- [Database maintenance](database.md) — manage SQLite or PostgreSQL.

## Operate KeyForge

- [Licenses and payments](license-sales.md) — plans, issuance, balances and payment records.
- [CLI reference](cli.md) — issue, revoke and inspect licenses.
- [API reference](api.md) — routes, access rules and errors.
- [Package releases](publishing.md) — publish the SDK and command-line tools.
- [Maintainer guide](maintaining.md) — contribute, deploy and recover.

## Connect an application

- [Integration guide](dependent-app-integration.md) — registration, activation and offline use.
- [Import licensing and recovery](import-licensing.md) — paid allowances and approved recovery.
- [TypeScript SDK](../packages/keyforge-client/README.md) — verify grants and call the API.
- [Device recognition](device-identity.md) — optional device signals and recovery.
- [Windows adapter](windows-device-identity.md) — Windows-specific identity details.
- [Studio Proof contract](studio-proof-contract.md) — the verified integration contract.
- [Token verification](verify-token.md) — the Ed25519 token contract.
- [Client OpenAPI](client-openapi.json) — download the API schema.
- [AI integration context](dependent-app-ai-context.md) — instructions for coding assistants.

## Reference

- [Architecture and limitations](integration-review.md) — current scope and boundaries.
- [Documentation maintenance](documentation-site.md) — update and publish these guides.

## Before you deploy

KeyForge is self-hosted for one company managing multiple products. It has no vendor-hosted multi-tenancy, public operator sign-up, email delivery or payment gateway. New activation requires internet; offline use continues only within a signed grant.

Read [architecture and limitations](integration-review.md) before making production or hosted-service commitments.
