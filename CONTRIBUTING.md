# Contributing to Keyforge

Thanks for considering a contribution. Keyforge aims to stay **small and
readable** — a license server you can audit in an afternoon. Features that
grow the core will be weighed against that goal; config-driven behavior and
documented recipes are preferred over new required machinery.

## Development setup

```bash
npm install
npm --prefix ui install
npm run license keygen        # local signing key
cp .env.example .env.local    # fill in secrets
npm run typecheck
npm test
npm run build:all
npm run start
```

UI development: `npm --prefix ui run dev` (Vite on :5173, proxying to :4100).

The scaffolder in `packages/create-keyforge` is plain ESM with no dependencies
and no build step. Try a change against a local checkout without publishing
anything:

```bash
node packages/create-keyforge/bin/create-keyforge.mjs /tmp/try --template . -y
```

## Ground rules

- `npm run typecheck` and `npm test` must pass; new behavior needs a test in
  `test/`.
- Never log or hardcode private key material; keep the fail-closed behavior
  of the admin surfaces (missing secret = surface disabled, not open).
- Token format changes require a version bump in the payload (`v`) and a
  compatibility story for consuming apps.
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
