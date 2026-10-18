import openApiUrl from "../../../docs/client-openapi.json?url";
import { docCatalog } from "./catalog";
import { createArticle } from "./markdown";

// Keep literal imports aligned with the explicit catalogue. Package guides are optional
// because generated deployment projects intentionally prune upstream packages/.
const sources = import.meta.glob<string>(
  [
    "../../../docs/index.md",
    "../../../docs/getting-started.md",
    "../../../docs/configuration.md",
    "../../../docs/deploy.md",
    "../../../docs/vercel.md",
    "../../../docs/cpanel-guide.md",
    "../../../docs/backups.md",
    "../../../docs/database.md",
    "../../../docs/license-sales.md",
    "../../../docs/cli.md",
    "../../../docs/api.md",
    "../../../docs/dependent-app-integration.md",
    "../../../docs/device-identity.md",
    "../../../docs/windows-device-identity.md",
    "../../../docs/verify-token.md",
    "../../../docs/dependent-app-ai-context.md",
    "../../../docs/integration-review.md",
    "../../../docs/studio-proof-contract.md",
    "../../../docs/documentation-site.md",
    "../../../docs/publishing.md",
    "../../../docs/maintaining.md",
    "../../../packages/keyforge-client/README.md",
    "../../../packages/create-keyforge/README.md",
  ],
  { query: "?raw", import: "default", eager: true },
);

export const articles = docCatalog
  .filter((entry) => typeof sources["../../../" + entry.source] === "string")
  .map((entry) => createArticle(entry, sources["../../../" + entry.source]));
export { openApiUrl };
