# UI Arc components

Installed through the shadcn registry `https://uiarc.dev/r/{name}.json`:

- `@uiarc/combobox`
- `@uiarc/command-palette`
- `@uiarc/date-picker` (includes calendar)
- `@uiarc/sortable-data-table`

The sortable table was chosen after inspecting `@reui/c-data-grid-23`; UI Arc
provides the required sortable product directory and matches the preferred library.
These files are app-owned adaptations, unlike the generated `components/ui` primitives.
Review these changes when refreshing registry source:

- Combobox uses a Radix Popover portal for collision handling and nested-dialog
  focus scopes, supports disabling its clear action, closes on blur, and keeps
  Escape inside the widget. Focus alone does not open a menu.
- Command palette exposes query changes for debounced, product-scoped license
  search. Escape clears a query before closing. Shortcut text follows the OS.
- Calendar/date picker retain local calendar days; `DateField` converts them to
  date-only strings before the existing UTC expiry rules run.
- Explicit WAI-ARIA roles are intentional for composite widgets and the table's
  mobile stacked layout. Roving focus/active-descendant keyboard behavior remains.

`../../arc.css` maps UI Arc variables into the existing console palette, scoped
to `.arc-theme`. `Choice`, `DateField`, and `GlobalCommand` are application adapters.
Existing Radix Dialog powers modal focus trapping, dismissal, and accessible titles.

Additional registry sources installed for the console improvements:

- `@uiarc/select`: Choice uses this for up to seven options; portal carries scoped theme variables and options retain Radix grouping. Empty catalog values are encoded at the adapter boundary.
- `@uiarc/pagination`: shared ListPagination and Audit cursor navigation. Product sorting/filtering precedes page slicing, and rendered row keys remain record identities.
- `@uiarc/file-upload`: profile source selection, type/size feedback and keyboard browsing. The drop target is a semantic button; the file input is labelled. The app processes the selected raster and saves only through the explicit profile action.
- `@uiarc/tooltip`: scoped portal theme; used by compact ActionButton icons with accessible names.

The sortable grid supports a distinct right-alignment column option, avoiding mobile numeric-cell semantics for actions. See `docs/ui-component-inventory.md` at the repository root for the full screen/component audit.

- `@uiarc/chat-thread`: public and private conversation history with controlled messages, composer disabled in favor of the existing validated form, no attachments/reactions or unsupported delivery claims. History is paginated in the application adapter.
