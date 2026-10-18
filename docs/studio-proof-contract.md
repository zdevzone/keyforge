# Studio Proof integration contract

This document describes the clean **KeyForge v1** development contract. License, trial and separate recovery artifacts use only `v:1`. The SDK baseline is `@zdevzone/keyforge-client@0.2.0`. Website deployment is a separate action: check the target server's `/healthz` before using it; merging source or publishing npm packages does not deploy Production.

## Product and trust configuration

A fresh KeyForge setup creates product ID `default`, named using deployment branding, and issuer `default`. Provider-created product IDs are explicit configuration. The example `studio-proof` ID is not automatically created. Confirm the intended product and ownership before issuing keys. Keep Preview and Production URLs, databases and pinned public trust separate. Never supply administrator credentials, private signing keys or metering credentials to a desktop app.

## Workflow

1. Register an installation online with a client-generated random UUID, random secret and durable request UUID/body. Replays retain the same identity and body. Hardware hashes are optional recognition hints, never authentication or physical-device proof.
2. Explicitly activate a customer key or start a provider-permitted trial. Skipping onboarding grants no paid access. Initial authorization requires internet.
3. Verify and securely persist signed v1 authorization and local usage state atomically. Evaluate it at protected operations; refresh ahead of the signed offline deadline.
4. Preserve existing media when a term, grace period, quota or authorization expires. Offline use is bounded by the signed policy; a new key cannot be activated offline.

## Import accounting

One successful new photo/video asset costs one unit. Failed/cancelled work, existing duplicates, proxies/thumbnails/sidecars and retries of the same operation add none. Deletion never refunds usage; later new ingestion of a deleted asset costs a unit. Studio Proof owns this classification and commits the asset and usage receipt in one transaction.

Keep separate permanent trial, paid and lifetime counters. KeyForge signs cumulative `paidImportsGranted`; Studio Proof stores consumption locally. First paid activation gives the entire purchased allocation and permanently forfeits remaining trial. Trial imports never reduce paid allowance. Renewal adds purchased units exactly once and extends time from max(current expiry, now); top-up adds units only; extension adds time only. Unused units carry forward but imports still require a valid term and offline lease. Payment recording and key replacement never refill allowance. No raw media or local import history is sent to KeyForge.

## Recovery and storage

Use secure atomic compare-and-swap storage across processes and enlist usage with the media transaction. Persist stable operation IDs; never reset missing/corrupt usage to zero. Usage backups are customer-encrypted, off-device and separate from configuration export/credentials. Restoration requires independently verified administrator approval and a challenge-bound, expiring recovery artifact. Merge surviving counters/receipts conservatively; exact retries adopt once. Lost-history recovery consumes all prior paid allocation, forfeits trial and records lifetime history as unknown. Fresh allowance is a deliberate later purchase, never implicit recovery credit.

One import account has one active installation. Seat release retains ownership; transferring it requires approved recovery. Recognition matches never free or transfer a seat. Whole-state rollback on a hostile OS, physical attestation and exact reconstruction of completely lost local history remain unsupported.

## Studio Proof responsibilities and testing

The official SDK is JS/TS, with optional Windows/Linux/macOS collectors. There is no native Rust SDK; a Rust integration implements HTTPS, canonical Ed25519 verification, secure storage, receipt atomicity and recovery using the same public contract. Do not add Node just to call REST.

Test activation, offline restart/deadline, trial conversion, renewal replay, quota exhaustion, concurrent processes, negative grants, wrong product/installation/key, corruption, approved/rejected/expired recovery and interrupted persistence. Keep secrets and authorization/usage state out of ordinary configuration exports. Unsigned discovery/serverTime is not permission to extend authorization.

## Public references

- [Full import and recovery rules](import-licensing.md)
- [V1 token verification](verify-token.md)
- [Client OpenAPI](client-openapi.json)
- [Portable current test vectors](examples/client-contract/README.md)
- [Device recognition](device-identity.md)
- [SDK guide](../packages/keyforge-client/README.md)

An end-to-end acceptance run on an explicitly configured test product is required before any Production rollout. This contract includes no customer email/realtime transport, multi-device shared offline import budget, signing-secret distribution or automatic state conversion.
