import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { docCatalog, docPath, resolveDocHref, sourceRepository } from "../ui/src/docs/catalog.js";
import { createArticle, markdownLinks, searchDocs } from "../ui/src/docs/markdown.js";

const read = (source: string) => readFileSync(resolve(source), "utf8");
const optionalSources = new Set(
  docCatalog.filter((entry) => entry.optional).map((entry) => entry.source),
);
const articles = docCatalog
  .filter((entry) => existsSync(entry.source))
  .map((entry) => createArticle(entry, read(entry.source)));
test("documentation publishes only explicit public sources, including all required guides", () => {
  assert.equal(new Set(docCatalog.map((d) => d.slug)).size, docCatalog.length);
  assert.equal(new Set(docCatalog.map((d) => d.source)).size, docCatalog.length);
  for (const entry of docCatalog) {
    assert.match(
      entry.source,
      /^(docs\/[a-z-]+\.md|packages\/(keyforge-client|create-keyforge)\/README\.md)$/,
    );
    assert.ok(read("ui/src/docs/content.ts").includes('"../../../' + entry.source + '"'));
    if (!entry.optional && !entry.source.startsWith("packages/"))
      assert.ok(existsSync(entry.source));
  }
  for (const required of [
    "getting-started",
    "configuration",
    "deploy",
    "cli",
    "api",
    "dependent-app-integration",
    "backups",
    "device-identity",
  ])
    assert.ok(docCatalog.some((d) => d.slug === required));
  assert.ok(!read("ui/src/docs/content.ts").includes('"../../../docs/*.md"'));
});
test("every published Markdown local link and heading fragment resolves to an existing source", () => {
  const broken: string[] = [];
  for (const article of articles)
    for (const link of markdownLinks(article.markdown)) {
      if (/^(https?:|mailto:|\/)/.test(link)) continue;
      const resolved = new URL(link, "https://local.invalid/" + article.source);
      const source = decodeURIComponent(resolved.pathname.slice(1));
      if (!existsSync(source)) {
        if (!source.startsWith("packages/") && !optionalSources.has(source))
          broken.push(article.source + " → " + link);
        continue;
      }
      const target = articles.find((a) => a.source === source);
      if (target && resolved.hash) {
        const ids = createArticle(target, read(source)).sections.map((s) => s.id);
        if (!ids.includes(decodeURIComponent(resolved.hash.slice(1))))
          broken.push(article.source + " → " + link);
      }
    }
  assert.deepEqual(broken, []);
});
test("Markdown links stay local for included guides, support pruned packages and reject unsafe or malformed URLs", () => {
  assert.equal(
    resolveDocHref("cli.md#plan-based-issuance", "docs/index.md", docCatalog, "/assets/api.json"),
    "/docs/cli#plan-based-issuance",
  );
  assert.equal(
    resolveDocHref("../packages/keyforge-client/README.md", "docs/index.md", docCatalog, "api"),
    "/docs/sdk",
  );
  assert.equal(
    resolveDocHref("../packages/keyforge-client/README.md", "docs/index.md", [], "api"),
    sourceRepository + "/blob/main/packages/keyforge-client/README.md",
  );
  assert.equal(
    resolveDocHref("client-openapi.json", "docs/api.md", docCatalog, "/assets/api.json"),
    "/assets/api.json",
  );
  assert.equal(
    resolveDocHref("/request-license", "docs/api.md", docCatalog, "api"),
    "/request-license",
  );
  for (const bad of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "vbscript:bad",
    "https://[invalid",
    "%invalid.md",
  ])
    assert.equal(resolveDocHref(bad, "docs/api.md", docCatalog, "api"), "");
});
test("search indexes actual body/code content and duplicate formatted headings have stable destinations", () => {
  const article = createArticle(
    docCatalog[0],
    "# Guide\n\n## **Signing** keys\n\n```sh\nuniquebodyword --flag\n```\n\n## Signing keys\n\nSecond section.",
  );
  assert.deepEqual(
    article.headings.map((h) => h.id),
    ["signing-keys", "signing-keys-1"],
  );
  const result = searchDocs([article], "uniquebodyword");
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "signing-keys");
  assert.match(result[0].snippet, /uniquebodyword/);
  assert.deepEqual(searchDocs([article], "notpresentanywhere"), []);
  assert.equal(docPath(""), "/docs");
  assert.equal(docPath("getting-started"), "/docs/getting-started");
  assert.ok(searchDocs(articles, "randomBytes").some((r) => r.article.slug === "getting-started"));
});
