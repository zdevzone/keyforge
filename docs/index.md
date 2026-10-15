# KeyForge documentation

Deploy your own license server, issue licenses from priced plans, and connect your software to signed online and bounded offline authorization.

**New to KeyForge? Start with the [beginner guide](getting-started.md).** It takes you from a source checkout to your first license activation and explains which secrets belong on the server and which configuration belongs in your app.

## Run a server

- [Setup and first license](getting-started.md): prerequisites, environment, generated secrets, first operator and verification.
- [Project CLI](../packages/create-keyforge/README.md): generate a deployment with your database, licensing model and host settings.
- [Configuration](configuration.md): environment variables, databases, deployment policy and defaults.
- [Deployment](deploy.md): Render, Docker, local/VPS, Fly.io, Railway, Koyeb and cPanel.
- [Backups and recovery](backups.md): encrypted archives, independent schedules, verification and restoration.
- [Database maintenance](database.md): SQLite/PostgreSQL selection, demo data and the admin-preserving reset.
- [Upgrade an existing installation](database.md#upgrade-existing-installations): backups, schema changes and older client compatibility.

## Operate KeyForge

- [Licenses, requests and payments](license-sales.md): plans, automatic ETB sales, unpaid balances, payment recording and delivery.
- [CLI reference](cli.md): key generation, diagnostics, issuance, revocation, seat release and maintenance commands.
- [API reference](api.md): authentication, permissions, routes, request bodies and errors.

## Connect an application

- [Integration guide](dependent-app-integration.md): registration, activation, offline authorization, support and trusted metering.
- [TypeScript SDK](../packages/keyforge-client/README.md): secure storage, retries, signed-token verification and client methods.
- [Device recognition](device-identity.md): optional Windows, Linux and macOS signals, diagnostics and recovery.
- [Token verification](verify-token.md): the exact Ed25519 license v4/trial v2 contract for any language.
- [Client OpenAPI](client-openapi.json): download the language-independent client API contract.
- [AI integration context](dependent-app-ai-context.md): concise instructions for your app's coding assistant.

## Understand the boundaries

KeyForge is MIT-licensed, self-hosted software for one company managing multiple products. It does not currently provide multi-tenant vendor hosting, public operator sign-up, email delivery or a payment gateway. Sales and payments are manually recorded in ETB. New activation and trial authorization require internet; offline use only continues within a previously signed grant.

See [current limitations and architecture](integration-review.md) before making production or hosted-service commitments.

## About these guides

This site bundles an explicit selection of the repository's Markdown with each UI build. It does not fetch GitHub on each visit. Update the files, run the checks and rebuild/redeploy to update this site's content. GitHub remains the source and download location; the documentation shown here describes the code shipped with this deployment.

Maintain the reader and its public file allowlist using the [documentation maintenance guide](documentation-site.md).
