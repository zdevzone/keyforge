# Writing a `.cpanel.yml`

Reference for the cPanel deployment file. `.agents/skills/cpanel/SKILL.md` is
the procedure; this is the background that explains why the procedure looks the
way it does. `docs/deploy.md` is the operator-facing version.

## What cPanel actually does with the file

cPanel's Git Version Control runs `.cpanel.yml` **as the system user, outside
the Node.js virtual environment**. That single fact drives most of the rules
below.

- `vp install` and `vp run build` inside `.cpanel.yml` either fail or silently
  pick up the wrong system binary. Build elsewhere — locally or in CI — and
  deploy the artifacts.
- Node apps are served by Phusion Passenger, which reloads only when
  `[DEPLOYPATH]/tmp/restart.txt` changes. A deployment that copies files without
  touching it leaves the old code running, and nothing reports an error.
- Never copy `node_modules/` or `.git/` to the server.

## Syntax rules

The parser is stricter than most YAML you will have written:

1. The file must open with the document marker `---` on line 1, then
   `deployment:`, then `tasks:`.
2. Use absolute binary paths — `/bin/mkdir`, `/bin/cp`, `/bin/touch`. The
   deployment shell is minimal and does not have the `PATH` you expect.
3. Use a block scalar (`|`) for anything with environment variables or
   step-dependent commands, so the whole thing runs as one Bash block.
4. Nothing interactive. `/bin/rm -i` will hang the deployment until it times
   out.
5. Spaces only, two per level. A tab is a parse error.

## What to establish before writing one

- The cPanel username, which fixes `/home/<username>/…`.
- The application root path on the server.
- Whether the stack needs a build step, and where that build lands.
- Whether the app is CommonJS or ESM — it decides the Passenger entry point.

## Shapes

**Backend service run by Passenger.** Copy the prebuilt dist/ and dist/runtime-package.json as the deployed package.json,
and any runtime scripts into the app directory, then touch
`tmp/restart.txt`. This is what Keyforge's own `.cpanel.yml` does.

**Built frontend only.** Build in CI, copy the compiled folder (`dist/` or
`build/`) into `public_html`. No Passenger involved.

**Monorepo.** Target each sub-folder at its own destination explicitly rather
than copying the tree and pruning afterwards.

## Two mistakes worth naming

- **Guessing the entry path.** With a `rootDir` above `src/`, TypeScript keeps
  the prefix: the entry is `dist/src/index.js`, not `dist/index.js`. Passenger
  fails with `MODULE_NOT_FOUND` and the cause is not obvious from the log.
- **Copying a local database over a live one.** Create the file only when it is
  absent (`if [ ! -f … ]`), never unconditionally.

For standalone Vite+/pnpm runtime installs, also deploy dist/runtime-pnpm-workspace.yaml as pnpm-workspace.yaml. It allows the required native SQLite build while omitting development workspace catalogs. Keep the runtime packageManager pin.
