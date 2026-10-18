# Dependent-app capabilities

The clean v1 baseline supports product-scoped registration, key validation/activation, refresh, deactivation, pinned Ed25519 authorization, bounded offline use, optional desktop recognition, plan issuance/manual ETB finance, trusted-backend metering, private preinstallation requests, in-app support/notifications and delivery.

Import-policy products additionally support cumulative purchased allocations, additive renewals/top-ups/extensions, separate local trial/paid usage and approved encrypted-backup recovery. SDK 0.2.0 uses current v1 tokens and mandatory atomic secure storage. Missing state never silently becomes a replacement identity or free quota.

Only the current schema is supported. Development databases, SDK state and test fixtures are fresh v1 records; there are no conversion endpoints or alternate signing formats. Existing signing key files and external encryption keys do not need replacement.

Dependent apps own feature enforcement, media transaction integration, duplicate classification, secure persistence and recovery UX. Hardware hints are not attestation; local-only enforcement cannot defeat a hostile OS rolling back all state. Rust/other languages implement the documented public contract; only JS/TS has an official SDK.

See [integration](dependent-app-integration.md), [Studio Proof contract](studio-proof-contract.md), [imports](import-licensing.md), [verification](verify-token.md), [OpenAPI](client-openapi.json) and [portable vectors](examples/client-contract/README.md).

## Fresh-baseline release

SDK `@zdevzone/keyforge-client@0.2.0` starts the current v1 protocol. This is deliberately breaking: old development grants, SDK state and database schemas are rejected, not upgraded. Preserve existing Ed25519 signing keys and external encryption keyrings. A new empty database and new client installation state are required when switching a development deployment to this release. Old installed-app identities cannot claim fresh seats or usage silently; use normal activation and explicit operator-approved recovery where current v1 history exists.

The protocol version is distinct from npm versions and the `/v1` HTTP route prefix. Recovery grants remain separate from license/trial grants and cannot unlock application features. Production rollout is a separate, explicit operation; publishing the SDK does not deploy the server.
