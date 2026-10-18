import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { verifySignedToken, verifyRecoveryToken } from "../packages/keyforge-client/src/index.js";
import { productTokenSchema, recoveryTokenSchema } from "../src/token-contract.js";
const root = new URL("../docs/examples/client-contract/", import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL("fixtures.json", root), "utf8"));
test("portable v1 vectors verify current artifacts and checksums", async () => {
  const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
  for (const [file, hash] of Object.entries(manifest.sha256))
    assert.equal(
      createHash("sha256")
        .update(readFileSync(new URL(file, root)))
        .digest("hex"),
      hash,
    );
  for (const sample of fixtures.samples) {
    const context = { ...fixtures.context, publicKeys: fixtures.publicKeys };
    if (sample.payload.kind === "usage-recovery") {
      assert.deepEqual(await verifyRecoveryToken(sample.token, context), sample.payload);
      assert.ok(recoveryTokenSchema.safeParse(sample.payload).success);
      await assert.rejects(() => verifySignedToken(sample.token, context), {
        code: "unexpected_token_kind",
      });
    } else {
      assert.deepEqual(await verifySignedToken(sample.token, context), sample.payload);
      assert.ok(productTokenSchema.safeParse(sample.payload).success);
    }
  }
});
test("server and SDK reject every discarded version even with a valid signature", async () => {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, 73),
    ]),
    format: "der",
    type: "pkcs8",
  });
  for (const sample of fixtures.samples)
    for (const v of [0, 2, 3, 4, 5]) {
      const payload = { ...sample.payload, v },
        bytes = Buffer.from(JSON.stringify(payload)),
        token = bytes.toString("base64url") + "." + sign(null, bytes, key).toString("base64url");
      assert.equal(productTokenSchema.safeParse(payload).success, false);
      assert.equal(recoveryTokenSchema.safeParse(payload).success, false);
      const verify =
        sample.payload.kind === "usage-recovery" ? verifyRecoveryToken : verifySignedToken;
      await assert.rejects(
        () => verify(token, { ...fixtures.context, publicKeys: fixtures.publicKeys }),
        { code: "invalid_payload" },
      );
    }
});
