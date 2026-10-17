import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import Fastify from "fastify";

import type { StorageOptions } from "../src/backup-destinations.js";
import type { CustomDestination } from "../src/backup-destinations.js";
import { BackupStorage } from "../src/backup-storage.js";
import { registerBackups } from "../src/backups.js";
import { configSchema } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { Platform, WORKSPACE } from "../src/platform.js";
import { generateSigningKeyPair } from "../src/sign.js";

test("backup credentials migrate once, remain encrypted, preserve archive versions and verify without environment credentials", async (t) => {
  const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  t.after(() => database.close());
  const platform = new Platform({
    database,
    config: configSchema.parse({}),
    privateKey: generateSigningKeyPair().privateKey,
    kid: "test",
    gate: async () => null,
    now: () => new Date(),
    keyring: { active: "test", keys: { test: randomBytes(32).toString("hex") } },
  });
  const objects = new Map<string, Buffer>();
  const options: StorageOptions = {
    blob: { token: "old-private-provider-token" },
    drivers: {
      blob: {
        upload: async (id, bytes) => {
          objects.set(id, bytes);
          return { type: "blob", key: id };
        },
        download: async (file) => objects.get(file.key)!,
        remove: async (file) => {
          objects.delete(file.key);
        },
      },
    },
  };
  const storage = new BackupStorage(platform, options);
  await storage.migrate();
  const version = await storage.version("blob");
  assert.ok(version);
  await storage.migrate();
  assert.equal(await storage.version("blob"), version);
  const before = await storage.metadata("blob");
  assert.equal(before.source, "database");
  assert.equal(JSON.stringify(before).includes("old-private-provider-token"), false);
  await storage.save("blob", { revision: before.revision, token: "new-private-provider-token" });
  assert.equal((await storage.resolve("blob", version)).blob?.token, "old-private-provider-token");
  assert.equal((await storage.resolve("blob")).blob?.token, "new-private-provider-token");
  await assert.rejects(
    storage.save("blob", { revision: before.revision, token: "stale" }),
    /changed/,
  );
  const records = await platform.records.list(WORKSPACE, "backup-storage");
  assert.equal(JSON.stringify(records).includes("private-provider-token"), false);
  const independent = new BackupStorage(platform, {});
  assert.equal((await independent.resolve("blob")).blob?.token, "new-private-provider-token");
  await storage.verify("blob");
  assert.ok((await storage.metadata("blob")).verifiedAt);
  assert.equal(objects.size, 0);
  const latest = await storage.metadata("blob");
  await storage.save("blob", { revision: latest.revision, token: "" });
  assert.equal((await storage.resolve("blob")).blob?.token, "new-private-provider-token");
  assert.equal((await storage.metadata("blob")).verifiedAt, undefined);
});

test("storage settings are admin-only and return no credentials", async (t) => {
  const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  t.after(() => database.close());
  const platform = new Platform({
    database,
    config: configSchema.parse({}),
    privateKey: generateSigningKeyPair().privateKey,
    kid: "test",
    gate: async () => null,
    now: () => new Date(),
    keyring: { active: "test", keys: { test: randomBytes(32).toString("hex") } },
  });
  const app = Fastify();
  t.after(() => app.close());
  const service = await registerBackups(app, platform, { enabled: true }, async (req) => ({
    actor: "test",
    role: req.headers.authorization === "admin" ? "admin" : "support",
  }));
  const url = "/admin/backups/providers/blob";
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url,
        payload: { revision: 0, token: "private-token-value" },
      })
    ).statusCode,
    403,
  );
  const result = await app.inject({
    method: "PUT",
    url,
    headers: { authorization: "admin" },
    payload: { revision: 0, token: "private-token-value" },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.body.includes("private-token-value"), false);
  const listing = await app.inject({
    method: "GET",
    url: "/admin/backups",
    headers: { authorization: "admin" },
  });
  assert.equal(listing.statusCode, 200);
  assert.equal(listing.body.includes("private-token-value"), false);
  let received: string | undefined;
  const endpoint = createServer(async (req, res) => {
    received = req.headers.authorization;
    for await (const _chunk of req) {
      /* Drain the uploaded fixture. */
    }
    res.writeHead(201).end();
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        endpoint.close(() => resolve());
        endpoint.closeAllConnections();
      }),
  );
  const created = await app.inject({
    method: "POST",
    url: "/admin/backups/destinations",
    headers: { authorization: "admin" },
    payload: {
      name: "Private endpoint",
      url: "http://127.0.0.1:" + (endpoint.address() as { port: number }).port + "/upload",
      headerName: "Authorization",
      headerValue: "Bearer private-header-value",
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.body.includes("private-header-value"), false);
  assert.equal(created.body.includes("encryptedHeaderValue"), false);
  const destination = created.json().destination;
  const saved = (await platform.records.get<CustomDestination>(
    WORKSPACE,
    "backup-destination",
    destination.id,
  ))!;
  assert.ok(saved.encryptedHeaderValue);
  assert.equal(JSON.stringify(saved).includes("private-header-value"), false);
  await (
    await service.driver({ destination: saved.id, destinationConfig: saved })
  ).upload(randomUUID(), Buffer.from("encrypted archive fixture"));
  assert.equal(received, "Bearer private-header-value");
});
