# create-keyforge

Generate a self-hosted licensing server deployment:

```sh
vp create keyforge my-license-server
vp create keyforge my-license-server --deploy docker --db postgres --pm vp --runtime node
```

Vite+ is the default workflow, with Node 24.21.0 and managed pnpm 12.11.2. The scaffolder also supports explicit alternative package managers for deployments that need them; generated instructions follow the selected manager. This repository's own documentation uses Vite+.

Options include --template owner/repo#ref or a local directory, --deploy local|render|fly|railway|koyeb|docker|cpanel, --db sqlite|postgres, --pm vp, --runtime node and operator administration scope. Run vp create keyforge --help for the full argument list.

The generator removes upstream identity, local databases, node_modules, build output and secret files. It creates independent signing, console/admin and data/backup encryption secrets; protect the generated .env.local and secrets directory. Templates are executable project sources: select one you trust.

After generation, follow the generated next steps: vp install, vp run build:all, provision the first operator and vp run start. Choose products, entitlement definitions and plan presets in the console. The root JSON seeds the initial catalog once; later GUI changes live in the database.

Deployment manifests never contain private keys. SQLite requires durable storage. Postgres requires a configured DATABASE_URL. cPanel copies prebuilt artifacts and never builds during deployment.
