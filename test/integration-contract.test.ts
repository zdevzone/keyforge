import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  KeyForgeClient,
  MemoryStorage,
  verifySignedToken,
  type ClientState,
} from "../packages/keyforge-client/src/index.js";

const root = new URL("../docs/examples/studio-proof-contract/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");
const fixtures = JSON.parse(read("fixtures.json"));

test("frozen integration package checksums and production public trust remain intact", () => {
  const manifest = JSON.parse(read("manifest.json"));
  for (const [name, digest] of Object.entries(manifest.sha256))
    assert.equal(createHash("sha256").update(read(name)).digest("hex"), digest, name);
  const deployment = JSON.parse(read("deployment.json"));
  for (const pem of Object.values(deployment.publicKeys))
    assert.equal(
      createHash("sha256")
        .update(createPublicKey(pem as string).export({ type: "spki", format: "der" }))
        .digest("hex"),
      deployment.spkiSha256,
    );
  assert.equal(fixtures.testOnly, true);
  assert.equal(fixtures.context.productId, "fixture-product");
  assert.ok(!JSON.stringify(fixtures).includes("PRIVATE KEY"));
  for (const pem of Object.values(fixtures.context.publicKeys))
    assert.notEqual(
      createHash("sha256")
        .update(createPublicKey(pem as string).export({ type: "spki", format: "der" }))
        .digest("hex"),
      deployment.spkiSha256,
      "Test and production trust must remain separate.",
    );
});

test("portable signed vectors reproduce verification and offline authorization in the SDK", async (t) => {
  for (const item of fixtures.cases) {
    await t.test(item.id, async () => {
      const context = { ...fixtures.context, now: Date.parse(fixtures.clock) };
      if (item.expected.verification !== "valid") {
        await assert.rejects(() => verifySignedToken(item.token, context), {
          code: item.expected.verification,
        });
        return;
      }
      const grant = await verifySignedToken(item.token, context);
      assert.deepEqual(grant, item.payload);
      const storage = new MemoryStorage();
      const state: ClientState = {
        version: 1,
        serverUrl: "https://fixture.example.test",
        productId: context.productId,
        subjectKind: "installation",
        installationId: context.installationId,
        credential: "A".repeat(43), // In-memory test value, never sent or accepted as secure entropy.
        registration: {
          installationId: context.installationId,
          requestId: "22222222-2222-4222-8222-222222222222",
        },
        registered: true,
        trialStarted: grant.kind === "trial",
        trialConsumed: 0,
        trialToken: grant.kind === "trial" ? item.token : null,
        licenseToken: grant.kind === "license" ? item.token : null,
        denial: null,
        lastObservedTime: context.now,
      };
      await storage.save(state);
      const client = new KeyForgeClient({
        ...context,
        serverUrl: state.serverUrl,
        storage,
        now: () => context.now,
        fetch: async () => {
          throw new Error("Offline vectors must never make a network request.");
        },
      });
      assert.equal((await client.getAuthorization()).state, item.expected.authorization);
    });
  }
});
