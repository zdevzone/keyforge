import assert from "node:assert/strict";
import test from "node:test";

import type { Grant } from "../src/platform.js";
import { isProfileImage } from "../src/profile-image.js";
import { buildReport, reportQuerySchema } from "../src/reports.js";

const licenses = [
  {
    id: "one",
    issuedTo: "Acme",
    status: "active",
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2026-02-01T00:00:00Z",
    plan: "pro",
    activationLimit: 3,
  },
  {
    id: "two",
    issuedTo: "Other",
    status: "revoked",
    issuedAt: "2026-02-01T00:00:00Z",
    expiresAt: null,
    plan: "pro",
    activationLimit: 2,
  },
] as Grant[];
test("reports filter the appropriate date and current status without leaking key material", () => {
  const report = buildReport(
    reportQuerySchema.parse({
      type: "expirations",
      from: "2026-02-01",
      to: "2026-02-01",
      customer: "ACM",
      status: "expired",
    }),
    licenses,
    [],
    "2026-03-01T00:00:00Z",
  );
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].id, "one");
  assert.equal(report.rows[0].status, "expired");
  assert.deepEqual(report.counts, { expired: 1 });
  assert.equal("keyHash" in report.rows[0], false);
  assert.equal(
    reportQuerySchema.safeParse({ from: "2026-03-01", to: "2026-02-01" }).success,
    false,
  );
  assert.equal(reportQuerySchema.safeParse({ from: "2026-02-30" }).success, false);
});
test("usage ranges include overlapping month buckets, exclude undated lifetime, and retain separate meter units", () => {
  const records = [
    { id: "a", licenseId: "one", meterId: "requests", period: "2026-02", consumed: 30 },
    { id: "b", licenseId: "one", meterId: "storage", period: "2026-02-15", consumed: 8 },
    { id: "c", licenseId: "one", meterId: "requests", period: "lifetime", consumed: 99 },
  ];
  const report = buildReport(
    reportQuerySchema.parse({ type: "usage", from: "2026-02-14", to: "2026-02-16" }),
    licenses,
    records,
    "2026-03-01T00:00:00Z",
  );
  assert.equal(report.rows.length, 2);
  assert.deepEqual(report.meters, { storage: 8, requests: 30 });
  assert.equal(
    buildReport(
      reportQuerySchema.parse({ type: "usage" }),
      licenses,
      records,
      "2026-03-01T00:00:00Z",
    ).rows.length,
    3,
  );
});
test("avatar validation allows bounded raster data and HTTPS while rejecting scripts, spoofing and oversized payloads", () => {
  assert.ok(isProfileImage("https://example.com/photo.png"));
  assert.ok(isProfileImage(""));
  assert.ok(isProfileImage("data:image/png;base64,iVBORw0KGgo="));
  for (const value of [
    "javascript:alert(1)",
    "http://example.com/a.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,YmFk",
    "data:image/png;base64," + Buffer.alloc(300000).toString("base64"),
  ])
    assert.equal(isProfileImage(value), false);
});
