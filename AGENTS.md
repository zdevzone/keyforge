# AGENTS.md

## Purpose

Instructions for AI coding agents working in this repository.

## Quick Start

- Install dependencies: `vp install`
- Typecheck: `vp run typecheck`
- Test: `vp run test`
- Build: `vp run build`
- Start compiled server: `vp run start`
- License admin CLI: `vp run license <command>`

## Project Layout

- `src/index.ts`: process entrypoint and environment wiring
- `src/server.ts`: shared server initialization; `api/index.mjs`: Vercel handler
- `src/config.ts`: zod schema + loader for keyforge.config.json (deployment policy)
- `src/app.ts`: HTTP/auth wiring; `src/platform.ts`: product-scoped domain routes
- `src/platform-store.ts`: scoped records, serialized writes and encryption
- `src/backups.ts`: encrypted jobs, schedules, downloads and verification
- `src/postgres-archive.ts`: bounded portable application-data archives for serverless hosts
- `src/token-contract.ts`: license v4 and trial v2 schemas
- `src/db.ts`: dual-engine historical ledger repository and migrations
- `src/sign.ts`: Ed25519 signing and token helpers
- `src/auth.ts`: Better Auth setup for the console (admin plugin, role backfill)
- `src/permissions.ts`: operator roles (admin/support) and auth.admin feature scope
- `scripts/license-tool.mjs`: admin and keygen CLI
- `scripts/db-tool.mjs`: copies a ledger between databases (`vp run db`);
  the engine is `src/replica.ts`
- `scripts/create-admin.mjs`: creates admin console operators
- `scripts/deploy-production.mjs`: CI-gated Vercel Preview and manually approved Production deployments; server credentials stay in Vercel
- `ui/`: React admin console (Vite), built into `dist/public`
- `ui/src/components/ui/`: shadcn/ui primitives, **generated** by
  `vp dlx shadcn@latest add <name>` from `ui/components.json`. Replaced wholesale
  on upgrade, so do not hand-edit them; they are excluded from lint (root
  `vite.config.ts`) and their `cn` helper lives in `ui/src/lib/utils.ts`
- `ui/src/components.tsx`: the console's own hand-written components. Older
  than the shadcn ones and still what most pages use
- `packages/create-keyforge/`: the `vp create keyforge` scaffolder (plain ESM,
  no build step; its generators are tested against `src/config.ts`'s schema)
- `packages/create-keyforge/src/platforms.mjs`: deployment targets and the
  manifests each one writes (`docs/deploy.md` documents them)

## Runtime Facts To Preserve

- Build output is `dist/` from TypeScript `src/` sources; the UI builds into `dist/public`.
  This public repository does not track generated output. Run `vp run build`
  before scripts importing compiled modules, or `vp run build:all` for deployment.
- The console imports shadcn components through the `@/` alias, which is
  declared **twice** — `ui/tsconfig.json` for the typechecker and
  `ui/vite.config.ts` for the bundler. Adding one without the other passes one
  check and fails the other.
- Polaris semantic colour tokens (`--background`, `--sidebar`, ...) and their
  light/dark mappings are defined in `ui/src/index.css`; `ui/DESIGN.md` records
  the visual system. Legacy `slate-*` utilities are compatibility aliases to
  those semantic roles, not a separate palette.
- Service startup requires signing key via `LICENSE_SIGNING_KEY` or `LICENSE_SIGNING_KEY_FILE`.
- `LICENSE_ADMIN_TOKEN` is optional; when absent, CLI bearer access is intentionally disabled.
- `LICENSE_AUTH_SECRET` is optional; when absent, the web admin console is intentionally disabled.
- SQLite uses one `licenses.sqlite` (or `LICENSE_DB_PATH`) for auth and licensing. There is no split-file importer. Demo data can be reset and seeded using `docs/database.md`.
- Listen port is `LICENSE_PORT`, else the platform-assigned `PORT`, else 4100 (`resolveListenPort`). The Dockerfile deliberately leaves `LICENSE_PORT` unset so hosts can assign one.
- Every Postgres pool comes from `createPostgresPool` (`src/database.ts`): it attaches an `error` listener (an unhandled one crashes the process when a managed database drops an idle client), resolves TLS explicitly instead of inheriting pg's version-dependent `sslmode` handling, and bounds size via `LICENSE_DB_POOL_MAX`. Never construct `new pg.Pool` directly.
- Boot migrations on Postgres run inside a transaction holding `pg_advisory_xact_lock`, so concurrent instances serialize; transaction-scoped because session-level locks do not survive a transaction pooler.
- Vercel uses one project: `main` Production and `dev` Preview, each with isolated PostgreSQL, data/archive/session/signing secrets, private external backup storage and a differently named verification database. Preserve existing production keys during host migration; never copy them into Preview. Run `scripts/vercel-prepare.mjs` with the selected environment's actual credentials before deploying; cold starts intentionally skip Better Auth DDL and seeding. The Vercel CDN serves static assets; do not eagerly import `@fastify/static` into the serverless path. Hosted backup work uses `waitUntil` and an authenticated cron endpoint, never a background interval or durable local files. Vercel cron runs only in Production; Preview backups are manual. See `docs/vercel.md`.

## Safe Change Rules

- Keep the trust boundary intact: never log or hardcode private signing key material.
- Do not change token signing format without coordinating client verification changes.
- Preserve fail-closed behavior when signing key is missing.
- Token payload changes require a version bump (`v`) and a compat story.
- Run `vp run typecheck` and `vp run test` after code changes before proposing completion.
- Config schema changes must keep `packages/create-keyforge` generating valid
  output; `test/create-keyforge.test.ts` is what catches it.

## Deployment Configuration

- For `.cpanel.yml` authoring rules, read `.agents/skills/cpanel/SKILL.md`.
  The short version: cPanel must never build, so `dist/` is built elsewhere
  and copied in, and Passenger reloads on `touch tmp/restart.txt`.
- `docs/deploy.md` is the operator-facing version of the same material and
  covers the other six targets.

## Vite+ workflow

Use vp install at the root for all workspaces. One pnpm-lock.yaml is authoritative.
Use vp run test for Node tests, vp run check for lint/format/types, and vp run build:all for deployment.
The generated cn alias and @ alias both live in the UI TypeScript and Vite configs.
Build emits dist/runtime-package.json for standalone production installs; never deploy the workspace catalog manifest alone.
