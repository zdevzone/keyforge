# Keyforge

Keyforge is an MIT-licensed, self-hosted licensing server for one company managing multiple products or services. Deploy it on your own infrastructure and define your own plans and entitlements. A future paid hosted platform can add vendor tenancy and billing around this core; that hosted layer is not implemented.

The console includes product policy and signing-key rotation, entitlement definitions, priced plans, license issuance and encrypted admin key recovery, activation seats, installations and machine trial history, support assignment and replies, trusted-backend metering, operator profiles and sessions, token diagnostics, and downloadable or independently scheduled backups to local storage, AWS S3, Cloudflare R2, UploadThing and custom upload endpoints.

Build output is generated, not tracked in this public repository. Run
`vp run build:all` before deployment. A cPanel deployment project must explicitly
include its prebuilt `dist/`, as described in the deployment guide.

## Develop

Start with the [beginner guide](docs/getting-started.md) for prerequisites, secret generation and the first license workflow. Install [Vite+](https://viteplus.dev/guide/install), copy `.env.example` to `.env.local` and replace its secret placeholders before running:

```sh
vp install
vp run license keygen
vp run secrets:init
vp run build:all
vp run admin:create --email admin@example.com --password "<strong-password>"
vp run start
```

Set exactly one signing-key source, independent random console/admin secrets, the public `LICENSE_SERVER_URL`, and the generated encryption ring file paths. The key generator follows `LICENSE_SIGNING_KEY_FILE`. Secrets and databases are ignored by Git. `secrets:init` creates data and backup rings, not console/admin secrets.

```sh
vp run check
vp run test
vp -C ui run dev
```

Node 24.21.0 LTS is pinned for development and deployment. Supported runtime lines are modern Node 22, 24 and 26 as declared in `engines`; CI covers 22 and 24. Vite+ 1.1.0 fronts pnpm 12.11.2 and uses one workspace lockfile. Use `vp run test` for this repository's Node test suite; `vp test` invokes Vite+'s separate Vitest command.

## Guides

Every deployment serves a public **`/docs`** reader with search, local guide links, copyable code and both themes. Content is bundled from the repository's Markdown at build time. Start with the [documentation index](docs/index.md) or [beginner guide](docs/getting-started.md); see [maintaining the docs site](docs/documentation-site.md).

- [TypeScript client SDK](packages/keyforge-client/README.md): online onboarding, signed offline use, secure storage adapters, and a Node reference example.
- [Windows device recognition](docs/windows-device-identity.md): optional scoped signals, diagnostics, authenticated backfill and recovery.
- [Cross-platform device identity and language support](docs/device-identity.md): Windows/Linux/macOS auto selection, native adapters, HTTP clients in other languages and shared hash vectors.
- [Client OpenAPI contract](docs/client-openapi.json) and [AI integration skill](packages/keyforge-client/skill/keyforge-integrate/SKILL.md).
- [Dependent app integration](docs/dependent-app-integration.md): registration, activation, offline verification, support and metering.
- [AI integration context](docs/dependent-app-ai-context.md): compact instructions to give another app's coding assistant.
- [API reference](docs/api.md) and [token verification](docs/verify-token.md).
- [Configuration and environment precedence](docs/configuration.md).
- [CLI](docs/cli.md), [backups and recovery](docs/backups.md), [deployment](docs/deploy.md), [cPanel](docs/cpanel-guide.md).
- [Implementation review and future hosted architecture](docs/integration-review.md).
- [Polaris console redesign and component inventory](docs/ui-redesign.md), [visual system](ui/DESIGN.md).
- [Scaffolder](packages/create-keyforge/README.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md).

## Upgrade existing installations

Back up the unified database (licensing and operators together), and keep separate recovery copies of signing keys and encryption rings first. Boot migrations preserve historical records and import historical ledger records into the `default` product once; they do not import the retired split auth database. Old license hashes cannot be reversed: an admin can securely re-enter the original product key after password verification to retain it encrypted. Historical installation IDs cannot be claimed without a credential; dependent apps must register a new identity.

This release replaces the old unscoped device API. Integrators must adopt product-scoped routes, license token v4 and trial token v2. Existing client binaries require an application update; no compatibility adapter is provided. Preserve old public keys in client trust stores for the chosen transition period.

For a populated local demo, build with `vp run build:all`, stop the app, run `vp run demo:reset --apply --maintenance --scope database`, then `vp run start`. Demo login details are in the ignored .artifacts/demo/manifest.json file. See [reset and cleanup commands](docs/cli.md#reset-cleanup-and-demo-data) for targeted resets and provider setup.

SQLite uses one file for licensing and operator authentication. See [Database setup and demo data](docs/database.md) for resetting and reseeding the demo installation.

Customers can request a license before installation at `/request-license`. Operators review **Licenses → License requests**. See [License requests, issuance and payments](docs/license-sales.md).
