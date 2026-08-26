# The admin console

A React app served from the same origin as the API, so session cookies need no
CORS story. It is optional: without `LICENSE_AUTH_SECRET` there is no console
at all, and the CLI does everything the console does.

## Getting the first operator in

**Sign-up is disabled on the running service.** There is no public registration
form to find, so the first operator has to be created deliberately, one of two
ways:

```bash
npm run admin:create -- --email you@example.com --password "long secret"
```

This writes to the auth database directly, so it must run **on the machine
hosting the service**.

Or seed at boot with `LICENSE_SEED_ADMIN_EMAIL` and
`LICENSE_SEED_ADMIN_PASSWORD` — the right choice for hosts with no shell access
or an ephemeral disk, since it recreates the operator after every deploy. It is
idempotent: an existing user's password is never changed.

After that, admins add operators from the **Operators** page.

## Roles

| | `admin` | `support` |
| --- | --- | --- |
| Read licenses, installations, audit | yes | yes |
| Release an activation (seat transfer) | yes | yes |
| Issue, edit, revoke licenses | yes | no |
| Download database backups | yes | no |
| Manage operators | yes | no |

Roles are enforced **server-side** (403 `insufficient_role`), not by hiding
buttons. A support operator who crafts the request by hand is refused too.

The CLI's `LICENSE_ADMIN_TOKEN` predates roles and acts as an admin.

## Scoping operator management

Operator management uses [Better Auth](https://better-auth.com)'s admin plugin,
scoped by `auth.admin` in the config:

| Value | Enables |
| --- | --- |
| `"core"` (default) | Operator and session management |
| `"full"` | Adds bans and impersonation |
| `["operators","bans"]` | Picks features individually |

Endpoints behind a disabled feature answer **404** — switching impersonation
off actually switches it off, rather than hiding the button and leaving the
route live.

## The pages

- **Licenses** — server-side search, status filter and pagination; summary
  counts; an issue flow with a one-time key reveal; edit customer, seat limit
  and expiry; revoke; release individual activations for transfer.
- **Installations** — the installed base as the installer reports it: licensed
  versus unlicensed counts against licenses issued, per-install user info, app
  version, platform and last-seen. Searchable and paginated.
- **Inspector** — paste a token an installation holds and read what it claims.
  Decoded in the browser; signature verification stays in your app.
- **Audit** — an append-only log of every admin action. Operators appear by
  email; actions taken with the shared CLI token are recorded as `cli`.
- **Entitlements** — the catalogue of entitlement keys in use across issued
  licenses, so you can see what your own plans actually grant.
- **Operators** (admins only) — add operators, change roles, set passwords,
  review and revoke sessions; ban and impersonate where enabled.
- **Settings** — change your operator password (which revokes your other
  sessions), and download consistent snapshots of the license and auth
  databases.

## Developing the console

```bash
npm --prefix ui run dev
```

Vite serves on `http://localhost:5173` and proxies `/api`, `/admin` and `/v1`
to a service on port 4100, so run the server alongside it. `npm run build:all`
builds the console into `dist/public`, which the Fastify process serves.

## Related

- [configuration.md](configuration.md) — `LICENSE_AUTH_SECRET` and the seeding variables
- [api.md](api.md) — the `/admin/*` routes behind these pages
- [backups.md](backups.md) — what the Settings downloads give you, and what they do not
