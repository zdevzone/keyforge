# Frozen Studio Proof review package

This package documents runtime source commit `a75fb8db6485ea2bacbe8831537feeeb1d8f31ad`, verified on 2026-10-18. Read [the review](../../studio-proof-contract.md) before implementing its business rules. Use this directory from a specific Git commit, rather than assuming a moving branch is a deployment version.

- `manifest.json`: runtime version, scope, gaps and SHA-256 file digests.
- `client-openapi.json`: frozen client contract with the documentation corrections described in the review. This is not a privileged administration OpenAPI.
- `license-v4.schema.json` / `trial-v2.schema.json`: token payload shapes. Also verify signatures, context, subject-ID equality, clocks, deadlines and local product policy.
- `deployment.json`: dated public-key and product-policy snapshot. No customer records or credentials.
- `fixtures.json`: 24 signed offline vectors, a fixed test clock/context and a **test-only** public key. The private fixture key was generated temporarily and discarded, never saved. Do not trust these fixtures in a real installation.

Each fixture has decoded `payload`, encoded `token`, expected `verification` (`valid` or an SDK verifier error code), and, when verification succeeds, expected SDK `authorization` state. `licensed` says nothing about an application's remaining import quota. The time-only fixture's entitlement label is illustrative, not a configured production convention. Signed expired/revoked fixtures authenticate successfully but must deny protected operations.

Run the executable checks with `vp exec tsx --test test/integration-contract.test.ts test/client-sdk.test.ts`. They make no production requests. The first checks all frozen digests and portable token vectors; the second starts isolated temporary servers for lifecycle, replay, seats, privacy and transport tests. Run the whole repository suite before release.

No fixtures claim success for unsupported revision ordering, legacy grandfathering or protected-usage recovery. Those require a separately approved protocol. Application-local lifetime accounting and migration acceptance must also be tested by Studio Proof, including cross-process storage locking and corruption handling.

Keep this package immutable after its release. For a future runtime review, create a separately versioned snapshot, document compatibility changes, generate a fresh test-only signing pair if new signed vectors are required, discard its private half, and test the new vectors before publishing. Never generate review fixtures using a production key.
