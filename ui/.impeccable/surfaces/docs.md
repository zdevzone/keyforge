# Documentation — Polaris

Mode: Read. This extends the established public KeyForge surface with the documentation structure approved by the user: existing Markdown, a beginner walkthrough, search, sidebar navigation, section links, copyable code, mobile support and light/dark appearance. This is a precise approved extension, so no new concept selection or visual-world replacement is needed.

## Direction contract

THESIS: Help an administrator deploy a working server and a developer connect a real app, with the next instruction and its prerequisites visible together.

OWN-WORLD: Inherit Polaris semantic surfaces, teal links, square controls and locally hosted Google Sans Flex. Code uses the existing monospace role; paragraphs use the established body role with a comfortable line height and bounded measure.

STORY: Start with the beginner guide; find operational and integration references through grouped navigation or search; follow local Markdown links without leaving the deployed documentation version.

FIRST VIEWPORT: A compact public header carries KeyForge, Documentation, search, theme and Sign in. Desktop shows a left navigation rail, a readable central article and a small right section index. Mobile keeps the article first, with navigation and search in accessible dialogs/sheets. The introductory article links directly to the beginner guide.

FORM: Approved documentation reading layout, not a new aesthetic concept. Existing shadcn Button, Sheet, Command and feedback primitives provide controls. The signature interaction is keyboard search into the full article text, with meaningful snippets and route/heading navigation. Motion remains limited to existing overlays and honors reduced motion. No new raster assets are needed.

FINISH: Complete for this ordinary Polaris extension. The initial five-section finish review found one light-appearance selected-navigation contrast issue; the remaining sampled composition passed. The subsequent verdict checked that fix list, confirmed the matching primary/primary-foreground pair at approximately (6.46:1) in light and (6.76:1) in dark, and returned SHIP. This is a fix-list verdict, not a second full review or an independent backend audit. The scoped reading hierarchy is recorded in ui/DESIGN.md; incumbent normative tokens and the design sidecar are preserved. No new raster assets ship with this surface, so no new asset provenance manifest is required.

## Content boundary

Only catalogued public Markdown and the client OpenAPI download enter the build. Secret files, development-only design briefs and arbitrary filesystem paths are excluded. Raw HTML and executable MDX are disabled. Existing source-file links resolve to an approved local document when present, otherwise the public source repository. The scaffolder may omit package-specific guides when its packages directory is pruned.

## Shipped surface

The public `/docs` reader renders the explicit Markdown allowlist through `ui/src/pages/Docs.tsx` and `ui/src/docs/*`. It includes the beginner setup, secret generation and storage, deployment, CLI, API and client integration guides. Local documentation links retain the deployed documentation version. Grouped navigation, full-text search with section destinations, a section index, copy feedback and failure feedback, mobile navigation and light/dark appearance use the existing Polaris control language.

Reading styles at the start of `ui/src/index.css` use Google Sans Flex, semantic light/dark surfaces and square controls. Articles use (16px)/(1.75) body text bounded to (72ch), (32px)/(1.2) desktop titles, (24px) second-level headings, (20px) third-level headings and (13px) monospace blocks. Below (640px), titles become (28px) and second-level headings (22px). The desktop composition has a (1480px) maximum width, a (224px) navigation rail and a (210px) section index; the index moves into an article accordion below (1280px), and navigation moves into a Sheet below (1024px).

## Finish evidence and handoff

Required full-page captures, all opened and validated after the final contrast fix:

- [Desktop light](../../../.impeccable/review/docs/desktop.png)
- [Desktop dark](../../../.impeccable/review/docs/desktop-dark.png)
- [Mobile light](../../../.impeccable/review/docs/mobile.png)
- [Mobile dark](../../../.impeccable/review/docs/mobile-dark.png)

Supplemental viewport captures cover [desktop search](../../../.impeccable/review/docs/desktop-search.png), [mobile navigation](../../../.impeccable/review/docs/mobile-navigation.png), and the beginner guide's secrets section on [desktop](../../../.impeccable/review/docs/beginner-secrets-desktop.png) and [mobile](../../../.impeccable/review/docs/beginner-secrets-mobile.png). These are review evidence, not publicly bundled product assets. No approved comp was required for this approved extension.

The [manual detector result](../../../.artifacts/docs-detect.json) contains zero primary findings and one advisory: the (32px) article title falls outside the incumbent type ramp. It is documented as an intentional docs-scoped reading role, supported by the reviewed article hierarchy; it is not promoted to a global token change. The existing theme, normative frontmatter and sidecar remain the visual authority.

Implementation verification recorded for this handoff: full check and typecheck passed; the full test run passed (149 tests, with 8 environment-dependent skips); all three browser suites and the OpenAPI drift check passed; a fresh scaffold with pruned package sources also built its UI. These checks supplement the sampled visual review and do not expand its scope. Pre-existing unrelated repository drift is preserved.
