# Public welcome — Polaris

Mode: Persuade. This is an ordinary user-pinned extension of the incumbent Polaris world, implemented from code without an approved visual comp. The related device views remain an Operate extension.

## Direction contract

THESIS: Help software developers understand KeyForge's licensing workflow, inspect the self-hosted source and reach this deployment's operator sign-in with clear expectations.

OWN-WORLD: Preserve the selected Polaris semantic light/dark colors, locally hosted Google Sans Flex, teal primary actions, amber secondary roles and square geometry recorded in `ui/DESIGN.md`. Larger public typography is scoped to this surface; the console's compact operational hierarchy remains its authority. The configured shadcnblocks registry supplied the inspected `hero1` source composition. The implementation adapts its split copy/actions and product-preview relationship to KeyForge.

STORY: Establish self-hosted licensing in the hero, show a real console composition with synthetic demo records, explain capabilities, walk through plan definition → issuance → online activation → bounded offline authorization, introduce deployment and SDK integration, answer practical questions, then finish with MIT, documentation and source links.

FIRST VIEWPORT: The header identifies KeyForge and provides Features, How it works, Docs, GitHub, appearance control and same-deployment Sign in. The exact headline is “License your software. Host it yourself.” Copy and Download source / Read the deployment guide actions sit beside the theme-matched Plans preview. The preview is explicitly a Demo workspace. On mobile the copy precedes the preview and navigation opens in an accessible Sheet.

FORM: Use an open split hero, definition-list capabilities, an ordered four-step walkthrough, an integration explanation beside a code panel, a single-open collapsible FAQ and a simple link footer. Use the public-only display hierarchy and retain semantic foreground pairs, square controls, visible focus, a skip link, descriptive image text and reduced-motion behavior. Desktop container width is bounded at (1320px); the walkthrough changes from four to two to one column, and the other split sections stack on mobile. Preserve source/raster provenance rather than adding decorative imagery.

FINISH: Fresh reviewer disposition is **SHIP**, with no material fixes. The main agent and finish reviewer inspected all twelve required current-build screenshots: six public desktop/mobile and light/dark/hero captures plus six device-view desktop/mobile captures. This visual handoff records sampled composition and interaction evidence, not independent proof of backend authorization or device recognition.

## Product and routing contract

- Source authority is `https://github.com/zdevzone/keyforge`. Download source links explicitly to its `main` branch ZIP; it is a source archive, not a packaged installer.
- `/welcome` is public. Unauthenticated root navigation reaches it; protected console routes require sign-in. Sign in links to this deployment's `/login`, and Login links back to the welcome page. Existing authenticated console entry remains available.
- Present the current MIT-licensed self-hosted release. Accounts are administrator-provisioned. Public sign-up, hosted pricing and multi-tenant SaaS are not current offerings.
- Describe licensing policy accurately: plans snapshot terms at issuance; activation and authorization refresh need connectivity; cached offline access ends at its signed deadline. Revocation takes effect when checked online or the authorization expires.
- Distinguish manual ETB sales/payment records from payment collection. Keep private signing keys on the server and public verification keys pinned in the consuming app. The framework-independent TypeScript SDK needs an explicit secure storage adapter; its optional Windows, Linux and macOS signal collectors are Node-only.

## Device recognition — Operate extension

`DeviceIdentity` and `SignalAvailability` reuse existing console Badge, monospace identity and supporting-text patterns on Installations and license activation history; Machines uses the same signal presentation. Show readable group support references and the kinds Windows ID, System UUID, Volume, Linux ID, Mac UUID and Root volume, with Available, Partial or Unavailable status and explicit absence copy. Availability reflects each operating system's expected signals; it is not proof of a physical device. Hashes, raw hardware identifiers and credentials are absent from these views. Full group UUIDs remain operational IDs, including the reference tooltip and existing actions; a support reference does not replace identity.

Keep registered app identities, active installation seat counts, activation history and reported machine groups distinct. Matching signals are recognition hints and may be absent, changed or cloned; they do not prove a physical-device count or automatically transfer/release seats. Registration timestamps describe registration, while the separate signal Updated timestamp describes the most recent signal update. Preserve existing scoped actions, permission checks, table scrolling and empty states.

## Provenance and verified evidence

Implementation sources are `ui/src/pages/Welcome.tsx`, the scoped welcome rules in `ui/src/index.css`, `ui/src/components/DeviceIdentity.tsx`, the Installations, Machines and LicenseDetail pages, and routing in App/Login. `hero1` was source-inspected through the configured registry before adaptation; registry authorization stays environment-based and no API key belongs in documentation or deployed assets.

The shipped rasters are `ui/public/welcome-console-light.png` and `ui/public/welcome-console-dark.png`: theme-matched main-content captures of the real Entitlements & plans → Plans tab, created against an isolated temporary SQLite deployment. Synthetic Studio standard, starter and team plan descriptions/prices provide the demo content; no customer data, operator header, production database or credentials were used. Their intrinsic preview dimensions are (1200 × 720). The PNGs retain embedded source provenance from Impeccable's embed-prompt workflow. They are product evidence rather than generated illustrations; the local capture helper is not a published build prerequisite, and no new image-generation work was used for this handoff.

Public review captures: `.impeccable/review/desktop.png`, `desktop-hero.png`, `desktop-dark.png`, `mobile.png`, `mobile-hero.png` and `mobile-dark.png`. Device review captures: `.artifacts/console-smoke/installations-desktop.png`, `installations-mobile.png`, `machines-desktop.png`, `machines-mobile.png`, `activation-history-desktop.png` and `activation-history-mobile.png`.

The detector report `.artifacts/windows-welcome-detect.json` contains no primary findings and five advisory type-size findings: the public brand, desktop fluid display, fluid section heading, tablet display and mobile fluid display. These are intentional scoped reading roles, now recorded in DESIGN frontmatter and sidecar metadata; no detector rerun is implied. This addition preserves the console palette, type hierarchy and earlier console guidance. Unrelated historical inventory and inactive-source drift are not canonized or repaired by this handoff.
