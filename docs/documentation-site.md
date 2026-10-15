# Maintain the documentation site

## Source of truth

The public `/docs` reader is built into the existing React console assets and served by the same KeyForge process. It works without operator authentication, console configuration or GitHub access. The existing `/help` URL redirects to `/docs`. Welcome-page Docs/deployment/integration links and console help links use this local reader.

Articles come from an explicit catalogue in `ui/src/docs/catalog.ts`. `ui/src/docs/content.ts` imports only its approved Markdown files as raw build inputs. Package READMEs are optional because generated deployment projects prune upstream `packages/`; missing package articles are omitted and their links lead to public source. Required `docs/` sources must remain available. Internal design briefs, real `.env` files, keys, databases and arbitrary filesystem paths are never published by this reader.

## Update or add a guide

1. Edit the repository's Markdown; do not create a second HTML copy.
2. For a new public article, add its stable slug, title, navigation group, source and description to the catalogue and its literal path to `content.ts`.
3. Use relative Markdown links to other guides. The reader resolves approved sources to local `/docs/...` URLs, preserves heading fragments and sends uncatalogued source-file links to the public repository. `client-openapi.json` links download the built contract.
4. Use normal headings, fenced code blocks, lists and GitHub-flavored tables. Duplicate and formatted headings receive consistent GitHub-style IDs. Raw HTML/MDX and Markdown images are not rendered. No executable documentation or arbitrary remote HTML is loaded.
5. Explain prerequisites, secret ownership, real command syntax, expected results and recovery steps. Mark sample identities/prices/UUIDs as examples. Do not include actual credentials or customer data.
6. Run the checks below and rebuild/redeploy. Content changes appear in the next build; there is no runtime fetch from GitHub's latest branch.

The source link opens the public repository's `main` Markdown for maintenance and may be newer than a deployed build. The article shown locally is the one included with this deployment. Public repository syncing and package publication remain separate release steps.

## Verification

```sh
vp run check
vp run test
vp run build:all
vp exec playwright install chromium
vp run test:docs
vp run test:console
vp run test:issuance
```

The documentation tests cover route/CLI discoverability, published-file boundaries, local link/heading resolution, search and rendering rules. Client API fixtures check the OpenAPI contract against real server behavior; `vp run docs:client-api -- --check` detects generated-contract drift. The browser test uses a temporary server/database to verify public deep links, navigation, full-text search, keyboard access, code copying, OpenAPI download, light/dark appearance, mobile overflow and absence of administrative requests.

## Visual and privacy boundaries

The reader reuses the Polaris semantic palette, local typography, shared theme toggle and existing shadcn navigation/dialog controls. Prose, code and tables have documentation-specific layouts; console forms and business workflows remain separate. Keep documentation content out of the initial console bundle by preserving the lazy documentation route.

Search operates locally on bundled public article text. It does not call administration, query production records or send search terms to an external search provider. Raw HTML is disabled, links retain the renderer's safe URL transformation, and external links open with a noreferrer relationship. Never enable raw HTML or executable MDX without an explicit security review.
