# Polaris console redesign

The console uses the user-selected **Polaris** theme from `@shadcnblocks/theme/polaris`, authored by tweakcn. Its cool neutral surfaces, teal primary, amber secondary, zero base radius and light/dark palettes replace the previous Figma/Arc styling. Google Sans Flex is self-hosted through Fontsource; identifiers retain a monospace fallback for legibility.

## Frontend and installation assessment

The frontend is React 19, TypeScript, Vite+, Tailwind 4, React Router and Radix shadcn primitives. Shadcnblocks publishes source rather than a separate runtime UI package, so its Radix blocks fit this stack without replacing routing, query caching, forms or the backend. Full Next.js templates are references rather than a reason to introduce another framework. Generated primitives remain under `ui/src/components/ui`; application adapters live outside that upgrade boundary.

Registry requests use the configured `@shadcnblocks` entry in `ui/components.json` and its environment-based authorization header. Run registry commands from `ui/`, for example `vp dlx shadcn@latest view @shadcnblocks/data-table12`. Never paste an API key into commands, source, logs or documentation. The registry metadata uses Radix Nova; existing generated primitives were retained rather than overwritten. No library API key is required by the deployed application.

The table block uses TanStack Table v8 APIs, so the dependency is pinned to the compatible v8 range. The newest v9 API is incompatible with that block. The profile block's optional Dice UI uploader dependency was not introduced: its composition is adapted to KeyForge's existing single-image processing workflow instead.

The public support-ticket `application-shell10` listing exists, but its source returned not found through both configured styles. The inbox therefore retains KeyForge's real workflow and uses shared shadcn primitives for its conversation history rather than claiming an unavailable block was installed. Registry keyword indexing was also unavailable; named block views and the public catalog were used instead.

## Screen and component inventory

| Screens / need | Previous implementation | Replacement or retained behavior |
| --- | --- | --- |
| App navigation and header | Handwritten shell around shadcn Sidebar | App-owned `application-shell1` adaptation; grouped navigation, breadcrumbs, mobile drawer and collapsed rail. Product, theme, bell and avatar retain their order. |
| License overview and management | Summary strip, server-paged shadcn table, focused edit dialog | Polaris summary composition and consistent shared table/dialog styling. Retain search, status filters, counts, server pagination and license detail tabs. |
| Products | UI Arc sortable data table | Adapted shadcnblocks `data-table12`: TanStack v8 sorting, column visibility, accessible table headings and local pagination after filtering/sorting. Row actions remain right aligned and permission-aware. |
| Plans and entitlements | Arc tabs, shared tables and edit dialogs | Shadcn Tabs, Field, Select/Combobox and Dialog. Retain plan ETB prices, entitlement terms, archive behavior and revision validation. |
| Issuance and license requests | Arc checkbox/select/calendar adapters | Shared shadcn form adapters. Existing plan selection, read-only terms, already-paid fields, idempotency, customer installation delivery and pre-installation private links remain unchanged. |
| Customers | Customer identity on requests, licenses, sales and support; no separate directory | Retain those workflows and data boundaries. Do not invent a second customer model or fabricate a customer directory. |
| Sales and financial reports | Shared table, dialogs, browser print and CSV | Polaris controls and layouts; retain admin-only access, ETB amounts, unpaid/received/refunded distinctions, partial payments, history and complete exports. |
| Operational reports and audit | Shared tables; local pagination or audit cursor navigation | Unified typography, filters, pagination and table actions. Audit still labels only known cursor pages; exports include all filtered results. |
| Installations, machines and metering | Handwritten pages using shared primitives | Reuse new fields, selectors, dialogs, feedback and pagination; retain counters, quota units and device security workflows. |
| Support inbox and conversations | Inbox list/detail with UI Arc ChatThread | Polaris inbox and email-style history using shadcn Avatar/Badge and existing validated composer. Preserve assignment, unread state, open/resolved status, history pagination and private-note separation. |
| Notifications | Arc notification center and checkbox | Shadcn Popover, buttons and checkbox; five recent items plus View all. Retain read/unread, page versus all-matching selection, confirmations and bulk API operations. |
| Account settings | ReUI uploader and Arc tabs | `settings-profile1` composition, shadcn avatar/actions and native single-file selection. Preserve PNG/JPEG/WebP validation, 5 MB limit, 256px resize, preview, removal and explicit Save profile. |
| Preferences, system and backups | Arc tabs plus existing page forms | Consolidated shadcn tabs: Account, Preferences, Notifications, admin-only Backups and System. Preserve security, own sessions, theme persistence, notification preferences and service status. |
| Sign-in and public request/status pages | Shared cards and fields | Polaris theme and form primitives, preserving auth, private status links and key retrieval. |
| Public welcome | Public source/download entry at `/welcome` | App-owned `hero1` split-hero adaptation with theme-matched synthetic Plans captures, scoped public typography, capabilities, workflow, integration, FAQ and MIT/source/docs footer. Download source is the main-branch source ZIP; Sign in opens this deployment's `/login`. |
| Device recognition in installations, machines and activation history | Existing operational tables | Shared `DeviceIdentity` / `SignalAvailability` patterns show group references, signal kinds and availability. Preserve operational group IDs, distinguish active installation seats from history and reported groups, and keep registration separate from signal-update timestamps. No hashes, raw hardware or credentials are rendered. |
| Shared feedback | Mixed text colors, Alert and modal | Semantic success/destructive feedback, visible disabled/loading states, accessible labels, focus return and internally scrolling dialogs. |

Use Select for short fixed lists and Command/Popover Combobox for longer lists. Direct table search stays local to that list; the global command palette retains navigation and API-backed license search. Calendar selections remain date-only strings so UTC expiry behavior does not change.

## Preserved contracts and gaps

The redesign does not change database schemas, license signing, validation, issuance/sale atomicity, permissions, customer channels or existing records. No sample people, orders, financial totals, charts or unsupported delivery actions from the blocks are shipped. Existing UI Arc/ReUI source is inactive; its registry entries are removed and the application no longer imports those components. The inactive source remains on disk because automatic approval review blocked recursive deletion.

Financial print styles are maintained independently of the retired Arc stylesheet. Mobile tables scroll within their containers, forms stack, and Settings tabs remain reachable by horizontal scrolling. Theme preference remains browser-local under `keyforge.theme`.

## Render URL fallback

Environment validation resolves `LICENSE_SERVER_URL` first, then `RENDER_EXTERNAL_URL` when the explicit setting is missing or empty. The selected URL is validated before console startup; a malformed explicit override is rejected rather than hidden by a fallback. Production without either URL still fails closed. No hostname is inferred from untrusted request headers. Set the explicit URL to the custom HTTPS domain when one is configured.

## Validation and design handoff

The token-bearing [visual system](../ui/DESIGN.md) and schemaVersion 2 [component preview sidecar](../ui/.impeccable/design.json) now describe the shipped Polaris palette, typography, square geometry, responsive layout and shared adapters. [The console surface brief](../ui/.impeccable/surfaces/console-patterns.md) retains the operational contracts and records the replacement visual authority.

Validation passed: `vp run check`, `vp run test` (117 passed, seven optional skips), `vp run build:all`, and the console and issuance browser suites. The three warnings in inactive sources were corrected by tracking the upload error callback dependency and using native semantic elements for typing status and reaction controls. The required searchable-recipient and empty-ID manual-option paths passed. The finish reviewer accepted all twelve required fresh desktop/mobile light/dark captures with a **SHIP** disposition and no material fixes. Credential scanning found zero matches in changed files and built assets.

The design detector ran once before documentation was refreshed and reported nine advisory type sizes outside the old Inter ramp. DESIGN now records the actual Polaris annotation, title and metric sizes, including 10/11/15/24/26/28/30px; no detector rerun is implied. Visual review establishes sampled composition and interaction evidence, not an independent proof of backend financial correctness or authorization.

The later [public welcome and device extension](../ui/.impeccable/surfaces/welcome.md) preserves this console system. Its fresh finish reviewer returned **SHIP** with all twelve required public/device captures valid and no material fixes. The extension's detector report (`.artifacts/windows-welcome-detect.json`) has no primary findings and five advisory findings for intentional public-only brand/display/section sizes; those roles are now scoped in DESIGN and the sidecar without changing console typography. The two shipped welcome rasters are light/dark captures of the real Plans composition with synthetic demo data. The welcome brief records their provenance, routing and product contracts, plus the exact review evidence paths. Earlier validation counts above remain historical rather than a claim about this extension's test run.

## Source references

- [Registry installation and authentication](https://www.shadcnblocks.com/docs/shadcn-cli/overview)
- [Radix compatibility](https://www.shadcnblocks.com/docs/primitive-libraries/overview)
- [Application shell](https://www.shadcnblocks.com/block/application-shell1)
- [Data table](https://www.shadcnblocks.com/block/data-table12)
- [Profile layout](https://www.shadcnblocks.com/block/settings-profile1)
- [Split hero composition](https://www.shadcnblocks.com/block/hero1)
- [Render environment variables](https://render.com/docs/environment-variables)
