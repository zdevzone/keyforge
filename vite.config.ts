import { defineConfig } from "vite-plus";

/**
 * Vite+ configuration for the repository root.
 *
 * This root is **not** a Vite application — it is a Fastify service compiled by
 * `tsc` into a tracked `dist/`. Only the `lint` and `fmt` blocks apply here.
 * The console under `ui/` is the real Vite project and keeps its own config.
 *
 * Oxlint and Oxfmt are the reason this file exists. Until now the repo had no
 * linter and no formatter of any kind, so every style decision was made by hand
 * and nothing checked for the classes of bug a linter finds for free.
 *
 * ## What deliberately stays where it is
 *
 * - **The server build stays `tsc`.** `scripts/create-admin.mjs`,
 *   `scripts/db-tool.mjs` and `scripts/license-tool.mjs` import compiled
 *   modules by path (`../dist/src/<name>.js`), which works because tsc emits a
 *   plain unbundled tree. Rolldown would collapse that layout and break all
 *   three — on the cPanel host that cannot rebuild.
 * - **Tests stay on `node:test`.** They run against SQLite *and* Postgres and
 *   drive the API through `fastify.inject`. Vitest would buy nothing and put
 *   the dual-engine coverage at risk.
 */
export default defineConfig({
  // Oxfmt — https://oxc.rs/docs/guide/usage/formatter/config.html
  fmt: {
    tabWidth: 2,
    semi: true,
    printWidth: 100,
    singleQuote: false,
    endOfLine: "lf",
    trailingComma: "all",
    sortImports: {},
    // Markdown is excluded below rather than reflowed: docs/api.md and
    // docs/cli.md are hand-wrapped, and their tables and fenced examples are
    // load-bearing — test/docs.test.ts reads them.
    ignorePatterns: [
      "dist",
      "node_modules",
      "**/*.md",
      "package-lock.json",
      "ui/package-lock.json",
      ".github/",
      ".claude/",
    ],
  },

  // Oxlint — https://oxc.rs/docs/guide/usage/linter/config
  lint: {
    plugins: ["typescript", "react", "jsx-a11y"],
    env: {
      builtin: true,
      node: true,
      browser: true,
    },
    ignorePatterns: ["dist", "node_modules", "ui/dist", ".github/", ".claude/"],
  },
});
