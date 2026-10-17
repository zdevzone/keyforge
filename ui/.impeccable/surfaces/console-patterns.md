# Console operations — Polaris

Mode: Operate. Preserve Keyforge's existing records, APIs, product scope and permission boundaries.

## Direction contract

THESIS: Make repeated license administration tasks easy to scan and complete through a compact shell, bounded listings, focused dialogs and clear feedback.

OWN-WORLD: The user explicitly selected the Polaris theme from `@shadcnblocks/theme/polaris`, authored by tweakcn, and requested paid shadcnblocks source components. The visual authority is now `ui/DESIGN.md` and the exact light/dark semantic tokens in `ui/src/index.css`: Google Sans Flex, cool neutral surfaces, teal primary, amber secondary and square base corners. This supersedes the previous Figma/Inter/blue and UI Arc/ReUI styling direction. Existing business contracts below remain binding.

STORY: Operators choose a product, scan and filter bounded listings, open focused editors, manage their account from the avatar menu, and inspect or export clearly scoped reports.

FIRST VIEWPORT: The application-shell1 adaptation supplies the grouped sidebar, sticky header, breadcrumbs, collapsed rail and mobile drawer. Header controls follow product, theme, bell and avatar. Listings show title, task controls, clear headings and right-aligned actions. Reports put filters above a dated summary and paginated results. Settings contains Account, Preferences, Notifications, enabled admin-only Backups and admin-only System. The Reports group contains Reports, admin-only Financial Report and feature-gated Audit.

FORM: This is the completed user-pinned replacement world, with code-led implementation and no approved visual comp. Use app-owned application-shell1, data-table12 and settings-profile1 adaptations on generated shadcn primitives. Use Select for up to seven choices and Command/Popover Combobox for longer catalogs or explicit searchable overrides. Calendar day and UTC semantics stay explicit. Tables scroll within their containers, forms stack, Settings tabs scroll horizontally and dialogs scroll internally within 90dvh. Follow reduced-motion preferences.

FINISH: Reviewer disposition is **SHIP**. The twelve required fresh current-build captures cover desktop/mobile and light/dark, including products, Settings, licenses, notifications, support notes, financial reports, paid issuance and private request status. The finish reviewer reported no material fixes. No shipping raster assets were added.

## Shared interaction and ownership contracts

- Keep application behavior in the owned Choice, DateField, GlobalCommand, PageNavigation, ListPagination, ActionButton, ConversationThread and ProfileImage adapters. Generated shadcn primitives under `ui/src/components/ui` retain their upgrade boundary.
- Choice accepts supplied options only. Intentional empty-ID options, including manual delivery, remain selectable in short and searchable branches. Required searchable selection reports an error and focuses its trigger when a supplied option has not been selected.
- DateField uses shadcn Calendar/Popover and preserves date-only strings until the API interprets UTC expiry. Do not shift a chosen calendar day through timezone conversion.
- GlobalCommand provides Ctrl/Cmd K navigation and API-backed license search within the active product. Keep loading/error states, permission visibility and direct list filters. It must not interrupt an open editor.
- Local collections normally use 20-record pages after filtering and sorting. Filters reset pages; shrinking collections clamp them. Operators retain server offsets; Audit exposes visited cursor pages and the available next page without implying a known total. Operator-session detail remains a full list.
- Focused dialogs retain accessible titles, focus trapping, dismissal, focus return and destructive-action confirmations. Support operators can view product policy read-only; edits and signing-key actions remain admin-only.
- data-table12 uses TanStack Table v8 sorting, column visibility and accessible headings. No demonstration orders, people, totals or unsupported actions from the source blocks are shipped.
- The public application-shell10 catalog listing could not be retrieved from the registry. Support uses an owned email-style ConversationThread with shadcn Avatar/Badge and its existing validated composer. It is not represented as an installed block.
- Inactive UI Arc/ReUI source remains on disk because automatic approval review rejected recursive deletion. Runtime imports and registry entries have been removed. It supplies no current visual authority.

## Reports and ETB sales

The approved initial operational reports cover license status/expirations, usage by product/customer, activations and support, with applicable date/customer/status filters, complete CSV exports and browser Print / Save PDF. The corrected requirement is system status; no public sharing was requested. Status reports describe current state. Usage reports include whole overlapping daily/monthly buckets and lifetime totals only without dates; keep meter units separate and preserve accessible chart titles, descriptions and mobile scrolling hints.

Sales retain plan defaults with product fallback, immutable amounts, initial and renewal sales, partial payments/refunds and ETB-only units. Taxes and multi-license orders are deferred. Finance is admin-only. Sales do not alter license entitlements or expiry. Focused sale and payment/refund/credit dialogs reuse shared fields, Choice and DateField. Financial reports label product, customer, UTC date basis and currency; CSV uses integer santim and printing includes the full filtered balance list.

## Support and notification history

Customer replies stay in the dependent app; notifications are in-app only. Inbox assignment, unread state, open/resolved state and bounded history remain. Internal notes are separated from customer conversation and explicitly labelled private and never sent to the customer. Attachments and reactions are not introduced. Preserve the existing 30-second refresh, message/assignment/expiration preferences and 30/7/1-day expiry thresholds.

The bell Popover shows five recent personal records and View all; callbacks update read state. Notifications uses the shared table and shadcn checkbox/Choice/pagination. Clearly distinguish current-page and all-matching selection. Selected read/unread/delete and all-read/all-delete preserve active-product scope; deletion uses the shared confirmation dialog. History remains persisted per person/product with deletion tombstones and legacy read compatibility. Disabling a preference stops future capture without erasing recorded history.

## Account and appearance

Account retains profile/contact details, password security and own sessions. The settings-profile1 composition places ProfileImage above labelled fields: horizontal preview/details on desktop, stacked on mobile. The owned adapter now uses shadcn Avatar/actions and a native single-file input. Preserve PNG/JPEG/WebP validation, a 5 MB source limit, maximum 256-pixel dimension, processing errors, preview, removal, initials fallback, optional HTTPS URL and explicit Save profile. ReUI is no longer the runtime uploader.

Preferences distinguishes browser-local appearance under `keyforge.theme` from server-saved notification preferences scoped to the active product. Appearance follows the system initially, persists and synchronizes across tabs. Legacy profile, system, notification and backup routes redirect to their Settings tabs. SQLite continues to use one shared auth/licensing file; reset and seed guidance remains in `docs/database.md`.

## System reset

Admin-only **Settings → System → Reset application data** extends the existing Polaris cards and focused confirmation dialog. Identify the retained seeded administrator before confirmation; require exact `DELETE ALL` text and default the optional encrypted-backup checkbox to checked. Explain unavailable reset/backup prerequisites inline. While running, disable submission, cancellation and dismissal, and show backup/reset progress; backup creation or verification failure must leave application data intact. Database failures roll back deletion.

Preserve the first recorded seeded administrator's ID, current profile, password/provider accounts and non-impersonated sessions. Unknown or invalid bootstrap identity disables reset. Recreate deployment product/plan defaults and retain external configuration, signing keys and archive files. On completion, clear cached records through full navigation: the retained administrator returns to System with confirmation and a verified-backup link when applicable; removed or impersonated sessions reach Login with reset guidance. Detailed deletion, replay and multi-instance maintenance contracts remain in `docs/database.md` and `docs/api.md`.

The fresh visual/source review accepted this extension as **SHIP**, with desktop/mobile confirmation and completion captures at `.artifacts/console-smoke/system-reset-{desktop,mobile,complete-desktop,complete-mobile}.png`; the detector reported no drift (`[]`). Reported checks passed: `vp run check`, default tests (122 passed, eight optional skips), PostgreSQL-enabled tests (129 passed, one Docker skip), `vp run build:all`, and console/issuance browser suites including a verified-backup reset, retained login and archive metadata. This extension introduces no visual-system or token changes.

## Plan issuance and public requests

Plans display existing ETB price/currency beside their terms. The issuance dialog selects customer/delivery and a plan, then shows read-only price, seats, duration and entitlements. Already paid defaults unchecked. When selected, PaymentFields shows payment method, today's UTC date and transaction reference. Zero-price plans are complimentary; missing prices block issuance. Mark as paid later reuses those fields with an editable UTC date and settles the existing sale. Initial sale creation and optional full receipt remain atomic and idempotent with issuance; `docs/license-sales.md` owns those backend contracts.

The public `/request-license` card collects name/email, product and requested plan, explains that no installation is required and tells the customer to retain the private link. `/license-request/:id#secret` provides status and authenticated key retrieval using the fragment credential as a bearer header. The operator request list opens the shared issuance dialog. Registered installations retain authenticated in-app notification/key retrieval; manual sharing remains available. Delivery states Available, Retrieved, Manual and Failed retain explicit feedback. Available does not claim receipt, and delivery does not consume an activation seat.

## Validation and handoff

The implementation reports `vp run check` passing, `vp run test` with 117 passes and seven optional skips, and `vp run build:all` passing. Three warnings in retained inactive sources were corrected: the upload error callback dependency and native typing-status/reaction-group semantics. Console and issuance browser suites passed, including required searchable-recipient selection and the empty-ID manual option. The twelve required current-build captures were accepted by the finish reviewer; these visual samples do not independently prove backend atomicity, authorization or financial correctness. Credential scanning found zero matches in changed files and built assets.

The detector ran once against the old DESIGN and reported nine advisory type-ramp mismatches. The refreshed token-bearing DESIGN documents the intentional annotation, title and metric sizes, including 10/11/15/24/26/28/30px; the detector was not rerun. `ui/.impeccable/design.json` now carries matching schemaVersion 2 extensions and self-contained component previews. See `docs/ui-redesign.md` for the complete inventory, registry provenance, preserved contracts and remaining source availability gaps.

## Compact controls and database-managed storage

Listing controls form a horizontal wrapping toolbar above the table; the Products search, status and Columns control share it. Shared field adapters bound text/numeric widths and make short selects and buttons fit content. Request listing defaults to all statuses, includes explicit product scope and keys/refetches its query by product.

Settings → Backups adds encrypted database-managed provider credentials, connection verification and a default destination for downloads/reset backups. Editors never populate existing secret values; blank secrets retain credentials, with explicit temporary-token removal. Historical backup jobs pin their original credential version. Application reset preserves this storage configuration; a full database drop does not. Root signing/auth/data/archive keys remain external.

## Field consistency and preview refresh

Labels remain above controls at all sizes. `FormFields` composes the generated FieldGroup with a container-driven grid: related fields share rows when each can fit 15rem, with 20px gaps, and stack in narrower containers. Definition/plan identifiers use the same TextField adapter as their descriptions. The catalog file input and export action align at the bottom edge of a wrapping toolbar. Text, choice and date controls share a 40px minimum height; bounded text and numeric fields retain their existing maximum widths.

Inputs use one continuous 2px focus stroke at a -1px offset. Command search gives its enclosing input group that stroke; the inner input has no separate outline. Accessible keyboard focus remains visible. Operator roles use the shadcn Badge with semantic foreground/background pairs. Backup verification, trial status, warnings and error feedback use success/warning/destructive tokens in both themes. Scheduled backups uses a generated shadcn Switch with an explicitly associated label. Generated primitives are not manually restyled.

The schemaVersion 2 preview sidecar was refreshed from the current token-bearing DESIGN, preserving Polaris, typography, shadows and public-page scope. It now records canonical colors and the responsive-form, toolbar, command-focus and role-badge previews; the obsolete side-label breakpoint is removed. The doctor no longer reports a stale sidecar. An unset future build-path preference is unrelated to the preview and was not changed.

The bounded browser review covers 24 route surfaces at 1440px, 900px and 390px in both themes (144 captures), plus focused entitlement, catalog and command dialogs. The console suite asserts no document overflow and checks sampled labels, placeholders, text buttons and status text against AA contrast thresholds. It caught and corrected inactive catalog-tab contrast in light mode and restore-verification contrast in dark mode. All final combinations passed. Console, issuance and documentation browser suites also preserve keyboard navigation, dialog focus, public request/private retrieval, payment, upload, notification bulk actions and reset workflows. These checks are scoped evidence, not a complete WCAG certification.

Evidence is generated under `.artifacts/console-smoke/consistency/` (`audit.json` and per-surface screenshots). One source detector pass reported retained inactive UI Arc radius/type advisories, the already-documented documentation title size, and an image-wrapper false positive: ArcImg forwards its required source through props and is outside the active UI. No detector-driven visual loop or new ignore rule was added.
