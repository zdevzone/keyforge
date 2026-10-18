export const sourceRepository = "https://github.com/zdevzone/keyforge";
export interface DocEntry {
  slug: string;
  title: string;
  group: string;
  source: string;
  description: string;
  /** Upstream-only guides may be pruned from generated deployment projects. */
  optional?: boolean;
}
/** Explicit public files only. Never publish arbitrary repository paths. */
export const docCatalog: DocEntry[] = [
  {
    slug: "",
    title: "Introduction",
    group: "Start here",
    source: "docs/index.md",
    description: "Find the right guide for hosting, administration or app integration.",
  },
  {
    slug: "getting-started",
    title: "Beginner guide",
    group: "Start here",
    source: "docs/getting-started.md",
    description: "From a source checkout to your first activated license.",
  },
  {
    slug: "configuration",
    title: "Configuration & secrets",
    group: "Run a server",
    source: "docs/configuration.md",
    description: "Environment variables, credential purposes and deployment policy.",
  },
  {
    slug: "deploy",
    title: "Deployment",
    group: "Run a server",
    source: "docs/deploy.md",
    description: "Render, Docker, VPS and other deployment targets.",
  },
  {
    slug: "vercel",
    title: "Vercel deployment",
    group: "Run a server",
    source: "docs/vercel.md",
    description: "PostgreSQL, private archives, hosted scheduling and staging acceptance.",
    optional: true,
  },
  {
    slug: "cpanel-guide",
    title: "cPanel deployment",
    group: "Run a server",
    source: "docs/cpanel-guide.md",
    description: "Prebuilt artifacts, runtime setup and Passenger reloads.",
  },
  {
    slug: "backups",
    title: "Backups & recovery",
    group: "Run a server",
    source: "docs/backups.md",
    description: "Create, verify and restore recoverable archives.",
  },
  {
    slug: "database",
    title: "Database maintenance",
    group: "Run a server",
    source: "docs/database.md",
    description: "SQLite, PostgreSQL, demo data and reset behavior.",
  },
  {
    slug: "license-sales",
    title: "Licenses & payments",
    group: "Operate KeyForge",
    source: "docs/license-sales.md",
    description: "Requests, plan-based issuance, ETB sales and manual payments.",
  },
  {
    slug: "cli",
    title: "CLI reference",
    group: "Operate KeyForge",
    source: "docs/cli.md",
    description: "Keys, issuance, diagnostics and maintenance commands.",
  },
  {
    slug: "api",
    title: "API reference",
    group: "Operate KeyForge",
    source: "docs/api.md",
    description: "Routes, authentication, request bodies, permissions and errors.",
  },
  {
    slug: "dependent-app-integration",
    title: "Connect an application",
    group: "Build an integration",
    source: "docs/dependent-app-integration.md",
    description: "Online onboarding, signed offline use, support and metering.",
  },
  {
    slug: "import-licensing",
    title: "Import licensing & recovery",
    group: "Build an integration",
    source: "docs/import-licensing.md",
    description:
      "Additive renewals, separate trial/paid usage, atomic storage and approved recovery.",
  },
  {
    slug: "sdk",
    title: "TypeScript SDK",
    group: "Build an integration",
    source: "packages/keyforge-client/README.md",
    description: "Secure storage, retries, client methods and desktop adapters.",
  },
  {
    slug: "device-identity",
    title: "Device recognition",
    group: "Build an integration",
    source: "docs/device-identity.md",
    description: "Optional Windows, Linux and macOS signals and safe recovery.",
  },
  {
    slug: "windows-device-identity",
    title: "Windows adapter reference",
    group: "Build an integration",
    source: "docs/windows-device-identity.md",
    description: "Windows sources, normalization and v1 vectors.",
  },
  {
    slug: "verify-token",
    title: "Token verification",
    group: "Build an integration",
    source: "docs/verify-token.md",
    description: "Ed25519 license, trial and recovery v1 verification for any language.",
  },
  {
    slug: "dependent-app-ai-context",
    title: "AI integration context",
    group: "Build an integration",
    source: "docs/dependent-app-ai-context.md",
    description: "A compact contract for an app's coding assistant.",
  },
  {
    slug: "create-keyforge",
    title: "Deployment scaffolder",
    group: "Reference",
    source: "packages/create-keyforge/README.md",
    description: "Generate an independent deployment project.",
  },
  {
    slug: "integration-review",
    title: "Architecture & limitations",
    group: "Reference",
    source: "docs/integration-review.md",
    description: "Current boundaries and future hosted-service work.",
  },
  {
    slug: "studio-proof-contract",
    title: "Studio Proof contract review",
    group: "Build an integration",
    source: "docs/studio-proof-contract.md",
    optional: true, // Deployment generators omit this upstream-specific review.
    description: "Verified deployment contract, offline fixtures and unresolved product policies.",
  },
  {
    slug: "documentation-site",
    title: "Maintain these docs",
    group: "Reference",
    source: "docs/documentation-site.md",
    description: "Source files, publishing, rendering and documentation checks.",
  },
  {
    slug: "publishing",
    title: "Package releases",
    group: "Reference",
    source: "docs/publishing.md",
    description: "Stable and beta SDK/CLI releases with npm trusted publishing.",
  },
  {
    slug: "maintaining",
    title: "Maintainer guide",
    group: "Reference",
    source: "docs/maintaining.md",
    optional: true,
    description: "Contributions, staging, production promotion and recovery.",
  },
];
export function docPath(slug: string) {
  return slug ? "/docs/" + slug : "/docs";
}

export function resolveDocHref(
  href: string,
  source: string,
  entries: readonly DocEntry[],
  openApiUrl: string,
): string {
  if (!href) return "";
  if (href.startsWith("#")) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  let resolved: URL;
  try {
    resolved = new URL(href, "https://keyforge-docs.invalid/" + source);
  } catch {
    return "";
  }
  if (!["https:", "http:", "mailto:"].includes(resolved.protocol)) return "";
  if (resolved.origin !== "https://keyforge-docs.invalid") return resolved.href;
  let path: string;
  try {
    path = decodeURIComponent(resolved.pathname.slice(1));
  } catch {
    return "";
  }
  if (path === "docs/client-openapi.json") return openApiUrl;
  const entry = entries.find((doc) => doc.source === path);
  if (entry) return docPath(entry.slug) + resolved.hash;
  return sourceRepository + "/blob/main/" + resolved.pathname.slice(1) + resolved.hash;
}
