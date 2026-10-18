import { randomUUID } from "node:crypto";

import {
  generateProductKey,
  hashProductKey,
  type LicenseDatabase,
  type LicenseRow,
} from "../src/db.js";
import { Records } from "../src/platform-store.js";
/** Scoped records for storage/reset tests; business workflows use the HTTP API. */
export async function seedLicense(database: LicenseDatabase, input: Partial<LicenseRow> = {}) {
  const key = generateProductKey();
  const license = {
    id: randomUUID(),
    keyHash: hashProductKey(key),
    plan: "standard",
    entitlements: {},
    issuedTo: "Fixture customer",
    status: "active" as const,
    activationLimit: 1,
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    revokedAt: null,
    productId: "default",
    keyReference: "fixture",
    subjectKind: "installation" as const,
    revision: 1,
    ...input,
  };
  await new Records(database.db).put("product:default", "license", license);
  return { key, license };
}
