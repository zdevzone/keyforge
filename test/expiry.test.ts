import assert from "node:assert/strict";
import test from "node:test";

import { expiryDate, expiryFromDate } from "../ui/src/lib/expiry.js";
test("editing unrelated fields does not round or extend an existing expiry", () => {
  const original = "2026-10-13T08:15:17.400Z";
  assert.equal(expiryFromDate(expiryDate(original), original), original);
  const offset = "2026-10-13T00:30:17.400+03:00";
  assert.equal(expiryDate(offset), "2026-10-12");
  assert.equal(expiryFromDate(expiryDate(offset), offset), offset);
});
test("explicit date changes expire at the selected UTC day and empty means perpetual", () => {
  assert.equal(expiryFromDate("2026-10-14", "2026-10-13T08:15:00Z"), "2026-10-14T23:59:59.000Z");
  assert.equal(expiryFromDate("", "2026-10-13T08:15:00Z"), null);
});
