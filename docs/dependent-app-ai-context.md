# Keyforge context for another app's coding assistant

Implement against [the TypeScript SDK](../packages/keyforge-client/README.md), [dependent app integration](dependent-app-integration.md), [client OpenAPI](client-openapi.json), [API](api.md), and [verification](verify-token.md). Use the [integration skill](../packages/keyforge-client/skill/keyforge-integrate/SKILL.md) when adapting an app. Treat these as the current contract.

- This is one self-hosting company's multi-product licensing server. Paid multi-vendor hosting is future work.
- Prefix device routes with /v1/products/:productId. Old unscoped routes are removed.
- Persist an installation ID and independent random 256-bit base64url credential. Registration pins its hash. Protect the credential in secure storage.
- Optional Node desktop recognition uses `@zdevzone/keyforge-client/device-signals` to choose Windows, Linux or macOS. Follow [device identity](device-identity.md); missing signals must not block installation-based licensing or trigger elevation. Other languages use the same REST/OpenAPI contract, but must implement secure storage and signed offline verification themselves until a native SDK exists.
- Persist UUID registration/support/message/meter event IDs and request bodies across retries; never generate a replacement ID after a network timeout.
- Device register/validate/activate/refresh/deactivate authenticate with the installation credential. Admin credentials never belong in a dependent app.
- Activation and refresh return license token v1. Registration may return trial token v1. Tokens have two base64url segments and an Ed25519 signature over the decoded UTF-8 JSON bytes, not JWT signing semantics.
- Pin trusted public keys. Verify signature, full shape, version, kid, issuer default, expected product, installation, subject kind/id, active status, issue time, expiry and offline deadline before trusting entitlements.
- An HTTP 200 refresh may carry a signed revoked/expired status. Stop authorization after verifying that negative grant.
- Enforce typed entitlement values explicitly. Plan names are labels. Entitlement defaults are suggestions, not grants. Unknown capabilities fail closed.
- Offline grants have bounded revocation latency. Never reset cumulative usage when tokens refresh. Client-local counters are not authoritative metering.
- Support routes use /installations/:installationId/support; public replies can be retrieved, internal notes cannot. UUID requestId equals Idempotency-Key when creating a case. Replies require requestId, revision and message.
- Metering routes /usage/summary and /usage/consume require product-scoped service credentials kept on a trusted backend. Consume uses positive integer units and stable UUID eventId.
- Do not expose signing keys, admin tokens, encryption rings, customer keys or metering credentials in client bundles/logs.
- Existing historical records survive migration into default. Old IDs without credentials require new identity registration. Old hashed keys cannot be recovered without secure re-entry.
- Test wrong-product tokens, invalid signatures, missing credentials, retries after timeout, expired/revoked refresh, seat races, quota races, and internal-note isolation.
