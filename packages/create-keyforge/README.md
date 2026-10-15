# create-keyforge

Generate a self-hosted KeyForge deployment with your database, licensing model, operator scope and deployment target. The generator writes independent console/admin and data/backup encryption secrets; its next steps generate the signing key and start the server.

## Use the CLI today

The CLI is included in the repository. Run it from a source checkout without installing a registry package:

```sh
git clone https://github.com/zdevzone/keyforge.git
cd keyforge
node packages/create-keyforge/bin/create-keyforge.mjs ../my-license-server --template . --pm vp
```

Follow the prompts, then the printed commands to install dependencies, generate the signing key, build, create the first operator and start the server. Vite+ is the default workflow; Node and pnpm versions follow the repository pins. See the [beginner guide](../../docs/getting-started.md) for credential purposes and your first license workflow.

For a noninteractive deployment:

```sh
node packages/create-keyforge/bin/create-keyforge.mjs ../my-license-server --template . --deploy docker --db postgres --pm vp --runtime node --yes
```

Set `DATABASE_URL` in the generated `.env.local` before starting a PostgreSQL deployment.

## Short command after publication

The `create-keyforge` package is prepared for publication but is not published yet. After its registry release, users can run:

```sh
vp create keyforge
vp create keyforge -- my-license-server --deploy docker --db postgres --pm vp
```

Package publication is a separate release step. Until then, use the local CLI above, or [Use this template](https://github.com/new?template_name=keyforge&template_owner=zdevzone) for a source copy and follow the beginner guide.

## Options

| Option | Purpose |
| --- | --- |
| `--template owner/repo#ref` or a local directory | Choose trusted project sources; defaults to the public KeyForge repository |
| `--db sqlite` or `--db postgres` | Choose the database |
| `--deploy local\|render\|fly\|railway\|koyeb\|docker\|cpanel` | Write the selected host's deployment files |
| `--pm vp`, `--runtime node` | Select the toolchain; alternative managers are also supported |
| `--auth core`, `--auth full` or a feature list | Configure operator administration |
| `--use-case`, `--name`, `--key-prefix` | Choose the initial licensing model and product identity |
| `--yes`, `--install`, `--no-git` | Accept defaults, install dependencies, or skip Git initialization |

Run `node packages/create-keyforge/bin/create-keyforge.mjs --help` for the full argument list.

## Generated project

The generator removes upstream identity, local databases, dependency folders, build output and secret files. Protect the generated `.env.local` and `secrets/` directory. Select trusted templates: they supply executable project sources.

Manage products, entitlement definitions and priced plans in the console. The root configuration seeds the initial catalog once; later console changes live in the database. Issuance snapshots the selected plan's terms and price into the license and sale.

Deployment manifests contain no private keys. SQLite needs durable storage; cPanel copies prebuilt artifacts and never builds during deployment. See [deployment](../../docs/deploy.md) and [backups](../../docs/backups.md).
