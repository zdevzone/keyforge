import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import {
  licenseTokenSchema,
  trialTokenSchema,
  recoveryTokenSchema,
} from "../src/token-contract.js";

// Public reproducible test seed. Never use this key for a deployment.
const key = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 73),
  ]),
  format: "der",
  type: "pkcs8",
});
const publicKeyPem = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
const common = {
  iss: "default",
  productId: "fixture-product",
  kid: "test-only-v1",
  installationId: "11111111-1111-4111-8111-111111111111",
  issuedAt: "2030-01-01T00:00:00.000Z",
  expiresAt: null,
};
const license = licenseTokenSchema.parse({
  ...common,
  v: 1,
  kind: "license",
  licenseId: "fixture-license",
  plan: "standard",
  entitlements: { imports: 50000 },
  issuedTo: "Test studio",
  subject: { kind: "installation", id: common.installationId },
  offlineGraceUntil: "2030-01-31T00:00:00.000Z",
  status: "active",
  accountId: "fixture-account",
  authorizationRevision: 2,
  paidImportsGranted: 50000,
  recoveryGeneration: 0,
  trialConverted: true,
});
const trial = trialTokenSchema.parse({
  ...common,
  v: 1,
  kind: "trial",
  verdict: "fresh",
  allowance: 20000,
  supportReference: null,
  converted: false,
});
const recovery = recoveryTokenSchema.parse({
  ...common,
  v: 1,
  kind: "usage-recovery",
  recoveryId: "22222222-2222-4222-8222-222222222222",
  accountId: "fixture-account",
  challenge: Buffer.alloc(32, 17).toString("base64url"),
  mode: "lost_history",
  usageDigest: null,
  paidImportsFloor: 50000,
  trialImportsFloor: 20000,
  recoveryGeneration: 1,
  authorizationRevision: 3,
  expiresAt: "2030-01-02T00:00:00.000Z",
});
const token = (payload: unknown) => {
  const b = Buffer.from(JSON.stringify(payload));
  return b.toString("base64url") + "." + sign(null, b, key).toString("base64url");
};
const samples = [
  { name: "paid-import-license", payload: license },
  {
    name: "ordinary-license",
    payload: licenseTokenSchema.parse({ ...license, accountId: null, paidImportsGranted: null }),
  },
  { name: "revoked-license", payload: { ...license, status: "revoked" } },
  { name: "trial", payload: trial },
  {
    name: "converted-trial",
    payload: { ...trial, converted: true, verdict: "spent", allowance: 0 },
  },
  { name: "usage-recovery", payload: recovery },
];
const outputs: Record<string, string> = {
  "fixtures.json":
    JSON.stringify(
      {
        testOnly: true,
        context: {
          productId: common.productId,
          installationId: common.installationId,
          now: Date.parse("2030-01-01T12:00:00.000Z"),
        },
        publicKeys: { [common.kid]: publicKeyPem },
        samples: samples.map((s) => ({ ...s, token: token(s.payload) })),
      },
      null,
      2,
    ) + "\n",
  "license-v1.schema.json": JSON.stringify(z.toJSONSchema(licenseTokenSchema), null, 2) + "\n",
  "trial-v1.schema.json": JSON.stringify(z.toJSONSchema(trialTokenSchema), null, 2) + "\n",
  "recovery-v1.schema.json": JSON.stringify(z.toJSONSchema(recoveryTokenSchema), null, 2) + "\n",
};
outputs["manifest.json"] =
  JSON.stringify(
    {
      contract: "keyforge-v1",
      testOnly: true,
      sha256: Object.fromEntries(
        Object.entries(outputs).map(([name, body]) => [
          name,
          createHash("sha256").update(body).digest("hex"),
        ]),
      ),
    },
    null,
    2,
  ) + "\n";
const directory = resolve("docs/examples/client-contract");
mkdirSync(directory, { recursive: true });
for (const [name, body] of Object.entries(outputs)) {
  const target = resolve(directory, name);
  if (process.argv.includes("--check")) {
    if (readFileSync(target, "utf8") !== body) throw Error(`Regenerate client fixture ${name}`);
  } else writeFileSync(target, body);
}
