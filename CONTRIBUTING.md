# Contributing to Keyforge

Thanks for considering a contribution. Keyforge aims to stay **small and
readable** — a license server you can audit in an afternoon. Features that
grow the core will be weighed against that goal; config-driven behavior and
documented recipes are preferred over new required machinery.

## Development setup

```bash
vp install
cp .env.example .env    # fill in secrets first
vp run build                # CLI imports compiled server modules
vp run license keygen        # local signing key
vp run secrets:init
vp run typecheck
vp run test
vp run build:all
vp run start
```

UI development: `vp -C ui run dev` (Vite on :5173, proxying to :4100).

The console uses [shadcn/ui](https://ui.shadcn.com) for its primitives. Add one
from inside `ui/` and it lands in `ui/src/components/ui/`:

```bash
cd ui && vp dlx shadcn@latest add <name>
vp run fmt                   # generated files follow this repo's style
```

Those files are generated and get replaced on upgrade, so keep changes out of
them — wrap them instead. Everything else in `ui/src` is hand-written, and the
shared `ui/src/components.tsx` adapters compose these primitives for the pages.

The scaffolder in `packages/create-keyforge` is plain ESM using Clack prompts
and has no build step. Try a change against a local checkout without publishing
anything:

```bash
vp node packages/create-keyforge/bin/create-keyforge.mjs /tmp/try --template . -y
```

## Ground rules

- `vp run typecheck` and `vp run test` must pass; new behavior needs a test in
  `test/`.
- Never log or hardcode private key material; keep the fail-closed behavior
  of the admin surfaces (missing secret = surface disabled, not open).
- Token format changes require a version bump in the payload (`v`) and a
  compatibility story for consuming apps.
- Console primitives come from shadcn/ui rather than being hand-rolled, and
  generated files are not hand-edited. New semantic colours belong in
  `ui/src/index.css` beside the existing tokens.
- Public API and config schema changes should update `README.md` and
  `docs/`, and must keep `packages/create-keyforge` emitting a config this
  server accepts — `test/create-keyforge.test.ts` parses the scaffolder's
  output with the real schema, so it fails loudly when the two drift.
- Deployment manifests live in `packages/create-keyforge/src/platforms.mjs` and
  are documented in `docs/deploy.md`. Every generated manifest is parsed by the
  tests (YAML/TOML/JSON, and Compose itself where the CLI exists); none of them
  may carry upstream's service names or paths.

## Security issues

Do not open public issues for vulnerabilities — see [SECURITY.md](SECURITY.md).

## Console components and UI review

Use the shared adapters in `ui/src/components.tsx`, generated shadcn primitives,
and the Polaris visual system documented in `ui/DESIGN.md`. Keep generated
components unmodified; compose them in hand-written wrappers. Preserve the
`@/` alias in both UI TypeScript and Vite configuration.

Run `vp run test:console` for isolated smoke checks and `vp run test:features` against a running seeded local app for all-page desktop/mobile coverage and feature actions. The latter writes a JSON report and screenshots under .artifacts/feature-checks and operates on demo records; it must never be pointed at customer production data.

## Branches and releases

Target contribution PRs at `dev`; use forks unless you are a trusted maintainer.
The owner works solo, so PRs require CI and resolved conversations but no
second person's approval yet. Squash feature changes; merge `dev` into `main`
with a promotion PR. Production deployment and npm publication are manual.
See [the maintainer guide](docs/maintaining.md) for staging, permissions,
releases, urgent fixes and recovery. This public repository is authoritative.
