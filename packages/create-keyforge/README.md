# create-keyforge

Scaffold a self-hosted [Keyforge](https://github.com/zdevzone/keyforge) license
server — signed offline license tokens, activation seats, an install census,
and an admin console — configured for your product before you ever open an
editor.

```bash
npm create keyforge@latest my-license-server
```

Answer four questions (or pass them as flags) and you get a project with your
product name, your key format, your plan presets, your database, and freshly
generated secrets already in place.

## Usage

```bash
npm create keyforge@latest <directory> [options]
npx create-keyforge@latest <directory> [options]
```

| Option | Values | What it decides |
| --- | --- | --- |
| `--db`, `-d` | `sqlite`, `postgres` | Where the ledger and operator accounts live. |
| `--auth` | `core`, `full`, or a list | Which Better Auth admin features the console exposes: `operators`, `sessions`, `bans`, `impersonation`. |
| `--use-case` | `count`, `time`, `features`, `blank` | The plan presets to start from. |
| `--name` | any string | Product name in the console, CLI, and logs. |
| `--key-prefix` | `1-10` uppercase chars | `ACME-7WV8M-JD2V7-V8NRA-HKWKA`. |
| `--deploy` | `local`, `docker`, `render`, `fly`, `railway`, `koyeb`, `cpanel` | Which host's deployment manifest to write. Defaults to `local`. |
| `--cpanel-user` | account name | Fills in `.cpanel.yml` for `--deploy cpanel`. |
| `--template` | `owner/repo[#ref]`, URL, or path | Scaffold from a fork, a pinned tag, or a local checkout. |
| `--install` | | Run `npm install` in the new project. |
| `--no-git` | | Skip the initial git repository and commit. |
| `--force` | | Scaffold into a directory that already has files. |
| `--yes`, `-y` | | Take defaults for anything not passed; never prompt. |

```bash
npx create-keyforge@latest acme-licensing \
    --db postgres --auth full --use-case time --name "Acme Photos" -y
```

Non-interactive by construction when it needs to be: piped input, CI, or `-y`
answers every question with its default instead of hanging.

## Licensing models

These pick the plan presets your console's issue form starts with. They are
starting shapes, not modes — the server signs freeform entitlements and never
interprets them, so you can mix and edit them freely afterwards.

| `--use-case` | Presets | For |
| --- | --- | --- |
| `count` | `trial`, `standard`, `pro` with a numeric `allowance` | Metered products: imports, renders, API calls. |
| `time` | `trial`, `monthly`, `yearly` with expiry dates | Subscriptions. A 7-day offline grace, so a lapsed subscription notices. |
| `features` | `basic`, `pro`, `enterprise` with feature flags | Editions and tiers. |
| `blank` | one plain plan | Defining your own from scratch. |

## Deployment targets

`--deploy` writes one host's manifest, named after your project, and leaves the
others out. Free means four different things across these hosts, so:

| Target | Writes | Cost | Keeps data? |
| --- | --- | --- | --- |
| `local` | nothing | — | Yes, on your disk |
| `docker` | `docker-compose.yml` | Whatever the box costs | Yes, named volumes |
| `render` | `render.yaml` | Free web service tier | **No** on free — no disk |
| `fly` | `fly.toml` | Trial credit, then pay-as-you-go | Yes, with a volume |
| `railway` | `railway.json` | Trial credit, then ~$5/mo | Only with a volume |
| `koyeb` | `deploy/koyeb.sh` | One free instance per org | **No** |
| `cpanel` | `.cpanel.yml` | Hosting you already pay for | Yes |

Koyeb gets a script rather than a manifest because Koyeb declares services
through CLI flags — a YAML file nothing reads would be worse than none.

Pick an ephemeral host with `--db sqlite` and the scaffolder says so plainly:
that ledger is empty again after every deploy. It still scaffolds exactly what
you asked for.

## What it writes

- `keyforge.config.json` — branding, key format, grace window, rate limits,
  plan presets, install census, and the admin scope from `--auth`.
- `.env.local` — a generated `LICENSE_ADMIN_TOKEN` and `LICENSE_AUTH_SECRET`
  (32 random bytes each, not placeholders), plus your database settings. It is
  gitignored; the signing key is left to `npm run license keygen`, which is the
  only thing that should ever create it.
- `.env.example` — the same variables with the values removed, for committing.
- `README.md` — your project's front page, describing what you chose, including
  how to deploy it and what that host does not keep. Keyforge's own
  documentation moves to `docs/keyforge.md`.
- the chosen host's deployment manifest, with your project's name in it.
- `package.json` — renamed to your project, private, upstream's identity removed
  and every script and dependency kept.

Upstream's git history, build output, and contribution paperwork are not
copied. The MIT `LICENSE` is, because that is the license the code stays under.

## After scaffolding

```bash
cd my-license-server
npm install
npm run license keygen        # the Ed25519 signing key pair — the trust root
npm run build:all
npm run admin:create -- --email you@example.com --password "long secret"
npm run start
```

MIT licensed.
