# KeyForge

**License your software. Host it yourself.**

An MIT-licensed license server with an admin console, REST API and TypeScript SDK. Run it on your own infrastructure with SQLite or PostgreSQL.

- Products, priced plans, entitlements and plan-based license issuance.
- Activation limits, trials and signed authorizations for bounded offline use.
- Optional device recognition on Windows, Linux and macOS.
- Manual ETB sales, payments, refunds and financial reports.
- Customer requests, support conversations and in-app notifications.
- Operator permissions, audit history and verified encrypted backups.

## Get started

Install [Vite+](https://viteplus.dev/guide/install) and the Node.js version in [.node-version](.node-version).

[Use this template](https://github.com/new?template_name=keyforge&template_owner=zdevzone), or generate a configured deployment with the included CLI:

```sh
git clone https://github.com/zdevzone/keyforge.git
cd keyforge
node packages/create-keyforge/bin/create-keyforge.mjs ../my-license-server --template .
```

For the CLI, follow its printed next steps. For a template copy, follow the [beginner guide](docs/getting-started.md) to configure secrets, build, create your first administrator and start the server. The console runs at `http://localhost:4100`; documentation is served at `/docs`.

For guided database, licensing and deployment choices, use the [configurable CLI](packages/create-keyforge/README.md). Its source is included; the short `vp create keyforge` command requires publishing `create-keyforge` first.

## Develop

Build output is generated, not tracked. Run `vp run build:all` before deployment.
For cPanel, explicitly include prebuilt `dist/`; see the [deployment guide](docs/deploy.md).

From the repository root:

```sh
vp install --frozen-lockfile
vp run check
vp run test
vp run build:all
```

Run `vp -C ui run dev` alongside the configured server for frontend development. See [contributing](CONTRIBUTING.md) for the full workflow.

## Documentation

- [All guides](docs/index.md) · [Setup and secrets](docs/getting-started.md) · [Deployment](docs/deploy.md)
- [Client integration](docs/dependent-app-integration.md) · [TypeScript SDK](packages/keyforge-client/README.md) · [OpenAPI](docs/client-openapi.json)
- [CLI](docs/cli.md) · [Backups](docs/backups.md) · [Upgrading](docs/database.md#upgrade-existing-installations)
- [Security](SECURITY.md) · [Current limitations](docs/integration-review.md)

## License

[MIT](LICENSE). Self-hosted for one company managing multiple products. Hosted multi-tenant SaaS is not included.
