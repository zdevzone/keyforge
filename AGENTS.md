# AGENTS.md

## Purpose

Instructions for AI coding agents working in this repository.

## Quick Start

- Install dependencies: `npm install`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Build: `npm run build`
- Start compiled server: `npm run start`
- License admin CLI: `npm run license -- <command>`

## Project Layout

- `src/index.ts`: process entrypoint and environment wiring
- `src/config.ts`: zod schema + loader for keyforge.config.json (deployment policy)
- `src/app.ts`: Fastify routes and license workflow
- `src/db.ts`: SQLite schema and repository operations
- `src/sign.ts`: Ed25519 signing and token helpers
- `src/auth.ts`: Better Auth setup for the console (admin plugin, role backfill)
- `src/permissions.ts`: operator roles (admin/support) and auth.admin feature scope
- `scripts/license-tool.mjs`: admin and keygen CLI
- `scripts/db-tool.mjs`: copies a ledger between databases (`npm run db`);
  the engine is `src/replica.ts`
- `scripts/create-admin.mjs`: creates admin console operators
- `ui/`: React admin console (Vite), built into `dist/public`
- `packages/create-keyforge/`: the `npm create keyforge` scaffolder (plain ESM,
  no build step; its generators are tested against `src/config.ts`'s schema)
- `packages/create-keyforge/src/platforms.mjs`: deployment targets and the
  manifests each one writes (`docs/deploy.md` documents them)

## Runtime Facts To Preserve

- Build output is `dist/` from TypeScript `src/` sources; the UI builds into `dist/public`.
  `dist/` is generated, not tracked -- run `npm run build` before anything that
  imports from it (the three `scripts/*.mjs` CLIs all do).
- Service startup requires signing key via `LICENSE_SIGNING_KEY` or `LICENSE_SIGNING_KEY_FILE`.
- `LICENSE_ADMIN_TOKEN` is optional; when absent, CLI bearer access is intentionally disabled.
- `LICENSE_AUTH_SECRET` is optional; when absent, the web admin console is intentionally disabled.
- SQLite path defaults to `licenses.sqlite` unless `LICENSE_DB_PATH` is set; auth data lives in `auth.sqlite` beside it (`LICENSE_AUTH_DB_PATH` overrides).
- Listen port is `LICENSE_PORT`, else the platform-assigned `PORT`, else 4100 (`resolveListenPort`). The Dockerfile deliberately leaves `LICENSE_PORT` unset so hosts can assign one.
- Every Postgres pool comes from `createPostgresPool` (`src/database.ts`): it attaches an `error` listener (an unhandled one crashes the process when a managed database drops an idle client), resolves TLS explicitly instead of inheriting pg's version-dependent `sslmode` handling, and bounds size via `LICENSE_DB_POOL_MAX`. Never construct `new pg.Pool` directly.
- Boot migrations on Postgres run inside a transaction holding `pg_advisory_xact_lock`, so concurrent instances serialize; transaction-scoped because session-level locks do not survive a transaction pooler.

## Safe Change Rules

- Keep the trust boundary intact: never log or hardcode private signing key material.
- Do not change token signing format without coordinating client verification changes.
- Preserve fail-closed behavior when signing key is missing.
- Token payload changes require a version bump (`v`) and a compat story.
- Run `npm run typecheck` and `npm test` after code changes before proposing completion.
- Config schema changes must keep `packages/create-keyforge` generating valid
  output; `test/create-keyforge.test.ts` is what catches it.

## Deployment Configuration

- For `.cpanel.yml` authoring rules, read `.agents/skills/cpanel/SKILL.md`.
  The short version: cPanel must never build, so `dist/` is built elsewhere
  and copied in, and Passenger reloads on `touch tmp/restart.txt`.
- `docs/deploy.md` is the operator-facing version of the same material and
  covers the other six targets.
