import assert from "node:assert/strict";
import test from "node:test";

import { publicAnalyticsPath, sanitizeAnalyticsEvent } from "../ui/src/lib/analytics.js";

test("analytics reports only public page categories and strips private URL data", () => {
  for (const [path, expected] of [
    ["/welcome", "/welcome"],
    ["/docs/getting-started", "/docs/:slug"],
    ["/docs", "/docs"],
    ["/request-license", "/request-license"],
  ]) {
    assert.equal(publicAnalyticsPath(path), expected);
    assert.deepEqual(
      sanitizeAnalyticsEvent({
        type: "pageview",
        url: "https://keyforge.example" + path + "?email=private&token=secret#private-key",
      }),
      { type: "pageview", url: "https://keyforge.example" + expected },
    );
  }
});

test("analytics rejects console, customer status, malformed URLs and custom events", () => {
  for (const path of [
    "/",
    "/login",
    "/settings?tab=account",
    "/licenses/key",
    "/license-request/private-id#secret",
    "/support/id",
    "/docs/private/extra",
    "/sales",
    "/audit",
  ]) {
    assert.equal(
      sanitizeAnalyticsEvent({ type: "pageview", url: "https://keyforge.example" + path }),
      null,
      path,
    );
  }
  for (const url of [
    "invalid",
    "http://localhost/welcome",
    "https://user:secret@keyforge.example/welcome",
  ])
    assert.equal(sanitizeAnalyticsEvent({ type: "pageview", url }), null);
  assert.equal(
    sanitizeAnalyticsEvent({ type: "event", url: "https://keyforge.example/welcome" }),
    null,
  );
});
