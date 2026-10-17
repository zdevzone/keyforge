# KeyForge

**Self-hosted licensing for your software.**

KeyForge is an MIT-licensed license server with an admin console, REST API and TypeScript SDK. Run it on your own infrastructure with SQLite or PostgreSQL.

- Product catalog, plans, entitlements and license issuance.
- Activations, trials, offline tokens and optional device recognition.
- Sales, payments, customer support and financial reports.
- Operator permissions, audit history and encrypted backups.

## Getting started

### Requirements

- [Node.js](.node-version)
- [Vite+](https://viteplus.dev/guide/install)

### Create a project

[Use this template](https://github.com/new?template_name=keyforge&template_owner=zdevzone) or generate a configured deployment with the CLI.

```sh
vp create keyforge@latest
```

Use Up/Down and Enter to choose a database, starting plans and deployment target, or Ctrl+C to cancel. See the [CLI guide](packages/create-keyforge/README.md), or run the generator from source:

```sh
git clone https://github.com/zdevzone/keyforge.git
cd keyforge
vp node packages/create-keyforge/bin/create-keyforge.mjs ../my-license-server --template .
```

Follow the generator's printed steps or the [setup guide](docs/getting-started.md) to configure secrets, create an administrator and start the server. The console runs at `http://localhost:4100`; docs are served at `/docs`.

## Development

Build output is generated, not tracked. Run `vp run build:all` before deployment.
For cPanel, explicitly include prebuilt `dist/`; see the [deployment guide](docs/deploy.md).

```sh
vp install --frozen-lockfile
vp run check
vp run test
vp run build:all
```

For UI development, run `vp -C ui run dev` alongside the server. See [contributing](CONTRIBUTING.md) for details.

## Documentation

- [Guides](docs/index.md) · [Setup](docs/getting-started.md) · [Deployment](docs/deploy.md)
- [Client integration](docs/dependent-app-integration.md) · [TypeScript SDK](packages/keyforge-client/README.md) · [Client starter](packages/create-keyforge-client/README.md) · [OpenAPI](docs/client-openapi.json)
- [CLI](packages/create-keyforge/README.md) · [Backups](docs/backups.md) · [Database upgrades](docs/database.md#upgrade-existing-installations)
- [Security](SECURITY.md) · [Known limitations](docs/integration-review.md) · [Package releases](docs/publishing.md)
- [Maintainer guide](docs/maintaining.md): contributions, Vercel Preview, production promotion and recovery.

## License

[MIT](LICENSE). Self-hosted for one company managing multiple products. Hosted multi-tenant SaaS is not included.
