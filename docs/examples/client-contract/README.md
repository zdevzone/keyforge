# KeyForge v1 portable test vectors

These reproducible Ed25519 vectors cover current license, trial and separate recovery artifacts. They contain **test-only keys and invented identities**, never deployment credentials or customer data. Never pin these keys in an application.

Generate with `vp exec tsx scripts/generate-client-fixtures.ts`; verify drift with `--check`. The manifest contains SHA-256 checksums. Signatures cover decoded UTF-8 JSON bytes without reserialization. The two segments use canonical base64url. A recovery artifact is never an application license.

Use these alongside the current [OpenAPI](../../client-openapi.json) and [import contract](../../import-licensing.md). Only v1 is accepted. Also test host storage atomicity, import receipts, negative grants, offline deadlines and approved recovery; a valid signature alone grants no feature access.
