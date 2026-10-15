import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

// Built assets land in dist/public, where the Fastify process serves them —
// same origin as the API, so session cookies need no CORS story. During
// development Vite proxies API calls to a locally running server instead.
export default defineConfig({
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    // Generated shadcn/ui sources, skipped for the reasons the root
    // vite.config.ts spells out. Repeated here because `vp lint` run from this
    // directory reads this config rather than the root's.
    ignorePatterns: ["src/components/ui", "src/hooks/use-mobile.ts"],
  },
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  // shadcn/ui components are generated with "@/" imports and the CLI writes
  // them expecting the alias to exist. Declared here and in tsconfig.json —
  // the bundler and the typechecker each need their own copy.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      cn: fileURLToPath(new URL("./src/lib/utils.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:4100",
      "/admin": "http://localhost:4100",
      "/v1": "http://localhost:4100",
    },
  },
});
