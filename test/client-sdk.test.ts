import assert from "node:assert/strict";
import { randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import addFormats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { runReference } from "../examples/keyforge-node.js";
import {
  createDeviceSignalsProvider,
  DeviceSignalQueryError,
  hashDeviceIdentifier,
  normalizeDeviceIdentifier,
} from "../packages/keyforge-client/src/device-signals.js";
import {
  KeyForgeClient,
  KeyForgeError,
  MemoryStorage,
  TokenError,
  verifySignedToken,
  DEVICE_SIGNAL_KINDS,
  type ClientOptions,
  type ClientState,
  type SecureStorage,
} from "../packages/keyforge-client/src/index.js";
import { createLinuxDeviceSignalsProvider } from "../packages/keyforge-client/src/linux.js";
import { createMacOSDeviceSignalsProvider } from "../packages/keyforge-client/src/macos.js";
import {
  createWindowsDeviceSignalsProvider,
  hashWindowsIdentifier,
  normalizeWindowsIdentifier,
  WindowsQueryError,
} from "../packages/keyforge-client/src/windows.js";
import { clientOpenApi, clientOpenApiJson } from "../scripts/generate-client-openapi.js";
import { buildLicenseApp } from "../src/app.js";
import { configSchema } from "../src/config.js";
import { LicenseDatabase } from "../src/db.js";
import { SIGNAL_KINDS, signalAvailability } from "../src/machines.js";
import { Records } from "../src/platform-store.js";
import { generateSigningKeyPair } from "../src/sign.js";
import { productTokenSchema } from "../src/token-contract.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
const validators = new Map<object, ReturnType<Ajv2020["compile"]>>();
function validate(schema: object, value: unknown) {
  let check = validators.get(schema);
  if (!check) {
    check = ajv.compile({ ...schema, components: clientOpenApi.components });
    validators.set(schema, check);
  }
  assert.ok(check(value), JSON.stringify(check.errors));
}
const methods = new Set<string>();
function contractOperation(method: string, path: string): any {
  const entry = Object.entries(clientOpenApi.paths).find(([template]) =>
    new RegExp("^" + template.replace(/\{[^}]+\}/g, "[^/]+") + "$").test(path),
  );
  assert.ok(entry, `Missing OpenAPI path: ${path}`);
  const operation = entry[1][method.toLowerCase()];
  assert.ok(operation, `Missing OpenAPI operation: ${method} ${entry[0]}`);
  methods.add(`${method.toLowerCase()} ${entry[0]}`);
  return operation;
}
const contractFetch: typeof fetch = async (input, init) => {
  const method = init?.method ?? "GET",
    operation = contractOperation(method, new URL(String(input)).pathname);
  if (init?.body)
    validate(
      operation.requestBody.content["application/json"].schema,
      JSON.parse(String(init.body)),
    );
  for (const p of operation.parameters)
    if (p.in === "header" && p.required) {
      assert.ok(new Headers(init?.headers).get(p.name));
      if (p.name === "Idempotency-Key")
        assert.equal(
          new Headers(init?.headers).get(p.name),
          JSON.parse(String(init?.body)).requestId,
        );
    }
  const response = await fetch(input, init);
  validate(
    (operation.responses[response.status] ?? operation.responses.default).content[
      "application/json"
    ].schema,
    await response.clone().json(),
  );
  return response;
};
async function fixture(t: any) {
  const database = await LicenseDatabase.open({ sqlitePath: ":memory:" });
  const pair = generateSigningKeyPair();
  let time = Date.parse("2026-10-15T12:00:00Z");
  const routes: string[] = [];
  const app = await buildLicenseApp({
    database,
    privateKey: pair.privateKey,
    kid: "sdk-key",
    adminToken: "sdk-test-admin",
    keyring: { active: "test", keys: { test: randomBytes(32).toString("hex") } },
    config: configSchema.parse({ limits: { enabled: false } }),
    now: () => new Date(time),
    uiDir: ".no-sdk-ui",
    onRoute: (method, path) =>
      routes.push(`${method.toLowerCase()} ${path.replace(/:([^/]+)/g, "{$1}")}`),
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
    await database.close();
  });
  const admin = async (method: any, path: string, payload?: any) => {
    const response = await app.inject({
      method,
      url: path.startsWith("/admin/") ? path : "/admin/products/default" + path,
      headers: { authorization: "Bearer sdk-test-admin" },
      payload,
    });
    assert.ok(response.statusCode < 300, response.body);
    return response.json();
  };
  const plan = (await admin("GET", "/catalog")).plans[0];
  await admin("PUT", "/plans/" + plan.id, {
    ...plan,
    price: 10000,
    currency: "ETB",
    activationLimit: 1,
  });
  const issue = (extra: object = {}) =>
    admin("POST", "/licenses", {
      requestId: randomUUID(),
      plan: plan.id,
      issuedTo: "SDK customer",
      ...extra,
    });
  const product = async (extra: object) => {
    const current = (await admin("GET", "/admin/products")).products.find(
      (p: any) => p.id === "default",
    );
    return admin("PATCH", "", {
      name: current.name,
      archived: current.archived,
      graceDays: current.graceDays,
      trial: current.trial,
      revision: current.revision,
      ...extra,
    });
  };
  const options = (
    storage: SecureStorage = new MemoryStorage(),
    extra: Partial<ClientOptions> = {},
  ): ClientOptions => ({
    serverUrl: url,
    productId: "default",
    publicKeys: { "sdk-key": pair.publicKey },
    storage,
    now: () => time,
    fetch: contractFetch,
    sleep: async () => {},
    ...extra,
  });
  return {
    app,
    database,
    pair,
    admin,
    issue,
    product,
    options,
    url,
    routes,
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test("Windows signal normalization, scoped hashing and safe partial diagnostics", async () => {
  const guid = "a1234567-b123-c123-d123-e123456789ab";
  assert.equal(normalizeWindowsIdentifier("machine-guid", ` {${guid.toUpperCase()}}\r\n`), guid);
  assert.equal(normalizeWindowsIdentifier("volume-serial", "ABCD-1234"), "abcd1234");
  for (const value of [
    "",
    "To be filled by O.E.M.",
    "00000000-0000-0000-0000-000000000000",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "03000200-0400-0500-0006-000700080009",
    "a".repeat(300),
  ])
    assert.equal(normalizeWindowsIdentifier("smbios-uuid", value), null);
  for (const value of ["00000000", "FFFFFFFF", "12345678", "not serial"])
    assert.equal(normalizeWindowsIdentifier("volume-serial", value), null);
  const scope = { serverUrl: "https://licenses.example.test", productId: "studio" };
  const hashed = hashWindowsIdentifier(scope, "machine-guid", guid);
  assert.equal(hashed, "aa7f9a3b0eeee456daced7ae390c08795b46934418950b09e5a7aeb7a0d8127f");
  assert.equal(
    hashWindowsIdentifier(
      { ...scope, serverUrl: scope.serverUrl.toUpperCase() + "/" },
      "machine-guid",
      guid,
    ),
    hashed,
  );
  assert.notEqual(
    hashWindowsIdentifier({ ...scope, productId: "other" }, "machine-guid", guid),
    hashed,
  );
  assert.notEqual(
    hashWindowsIdentifier(
      { ...scope, serverUrl: "https://other.example.test" },
      "machine-guid",
      guid,
    ),
    hashed,
  );
  const report = await createWindowsDeviceSignalsProvider({
    platform: "win32",
    query: async (kind) => {
      if (kind === "machine-guid") return guid;
      if (kind === "smbios-uuid") throw new WindowsQueryError("permission_denied");
      throw new WindowsQueryError("timeout");
    },
  })(scope);
  assert.deepEqual(report.signals, [{ kind: "machine-guid", hash: hashed }]);
  assert.deepEqual(
    report.diagnostics.map((d) => d.status),
    ["available", "permission_denied", "timeout"],
  );
  assert.equal(JSON.stringify(report).includes(guid), false);
  const unsupported = await createWindowsDeviceSignalsProvider({
    platform: "linux",
    query: async () => {
      throw new Error("must not query");
    },
  })(scope);
  assert.equal(unsupported.signals.length, 0);
  assert.ok(unsupported.diagnostics.every((d) => d.status === "unsupported"));
});

test("Windows query fixtures enforce timeout/output bounds and classify complete or invalid reports", async () => {
  const context = { serverUrl: "https://licenses.example.test", productId: "studio" };
  const complete = await createWindowsDeviceSignalsProvider({
    platform: "win32",
    query: async (kind) =>
      kind === "volume-serial" ? "abcd1234" : "a1234567-b123-c123-d123-e123456789ab",
  })(context);
  assert.equal(complete.signals.length, 3);
  assert.ok(complete.diagnostics.every((d) => d.status === "available"));
  const incomplete = await createWindowsDeviceSignalsProvider({
    platform: "win32",
    query: async (kind) =>
      kind === "machine-guid"
        ? new Promise<string>(() => {})
        : kind === "volume-serial"
          ? "x".repeat(5000)
          : "",
  })(context);
  assert.deepEqual(
    incomplete.diagnostics.map((d) => d.status),
    ["timeout", "unavailable", "query_failed"],
  );
  assert.deepEqual(incomplete.signals, []);
  const invalid = await createWindowsDeviceSignalsProvider({
    platform: "win32",
    query: async () => "To be filled by O.E.M.",
  })(context);
  assert.ok(invalid.diagnostics.every((d) => d.status === "invalid"));
});

test("Linux and macOS normalization, hash namespaces and per-OS availability preserve the Windows contract", () => {
  assert.deepEqual(DEVICE_SIGNAL_KINDS, SIGNAL_KINDS);
  const context = { serverUrl: "https://licenses.example.test", productId: "studio" };
  const machineId = "a1234567b123c123d123e123456789ab",
    uuid = "a1234567-b123-c123-d123-e123456789ab";
  assert.equal(
    normalizeDeviceIdentifier("linux-machine-id", ` ${machineId.toUpperCase()}\n`),
    machineId,
  );
  for (const value of ["uninitialized", "0".repeat(32), "f".repeat(32), uuid, "short"])
    assert.equal(normalizeDeviceIdentifier("linux-machine-id", value), null);
  assert.equal(normalizeDeviceIdentifier("macos-platform-uuid", `{${uuid.toUpperCase()}}`), uuid);
  assert.equal(
    hashDeviceIdentifier(context, "linux-machine-id", machineId),
    "f7736a4b994708015d9f047378b6db01b7e794ac9301f59ee354e4e4dc76e47a",
  );
  assert.equal(
    hashDeviceIdentifier(context, "macos-platform-uuid", uuid),
    "2c696778660c3bf7a4245764b919128ecb411182f33caced158fa3b405870fe3",
  );
  assert.notEqual(
    hashDeviceIdentifier(context, "smbios-uuid", uuid),
    hashDeviceIdentifier(context, "macos-platform-uuid", uuid),
  );
  assert.equal(signalAvailability(["macos-platform-uuid", "root-volume-uuid"]), "Available");
  assert.equal(
    signalAvailability(["linux-machine-id", "smbios-uuid", "root-volume-uuid"]),
    "Available",
  );
  assert.equal(signalAvailability(["linux-machine-id", "smbios-uuid", "volume-serial"]), "Partial");
  assert.equal(signalAvailability([]), "Unavailable");
});

test("Linux fixtures use fixed files/commands, preserve privacy and tolerate denied or missing sources", async () => {
  const context = { serverUrl: "https://licenses.example.test", productId: "studio" },
    reads: string[] = [];
  const machineId = "a1234567b123c123d123e123456789ab",
    uuid = "b1234567-b123-c123-d123-e123456789ab";
  const provider = createLinuxDeviceSignalsProvider({
    platform: "linux",
    readFile: async (path) => {
      reads.push(path);
      if (path === "/etc/machine-id")
        throw Object.assign(new Error("private OS output"), { code: "ENOENT" });
      return path === "/var/lib/dbus/machine-id" ? machineId : uuid;
    },
    execute: async (file, args) => {
      assert.equal(file, "/usr/bin/findmnt");
      assert.deepEqual(args, ["--noheadings", "--raw", "--output", "UUID", "--target", "/"]);
      return uuid;
    },
  });
  const report = await provider(context);
  assert.deepEqual(reads, [
    "/etc/machine-id",
    "/var/lib/dbus/machine-id",
    "/sys/class/dmi/id/product_uuid",
  ]);
  assert.equal(report.signals.length, 3);
  assert.equal(JSON.stringify(report).includes(machineId), false);
  assert.equal(JSON.stringify(report).includes(uuid), false);
  const partial = await createLinuxDeviceSignalsProvider({
    platform: "linux",
    readFile: async (path) => {
      if (path === "/etc/machine-id") return machineId;
      throw Object.assign(new Error("PRIVATE"), { code: "EACCES" });
    },
    execute: async () => "",
  })(context);
  assert.deepEqual(
    partial.diagnostics.map((d) => d.status),
    ["available", "permission_denied", "unavailable"],
  );
  const absent = await createLinuxDeviceSignalsProvider({
    platform: "linux",
    readFile: async () => "uninitialized",
    execute: async () => {
      throw new DeviceSignalQueryError("unavailable");
    },
  })(context);
  assert.equal(absent.signals.length, 0);
  assert.equal(absent.diagnostics[0].status, "invalid");
});

test("macOS fixtures extract only platform/volume UUIDs, not serials or APFS snapshot identifiers", async () => {
  const context = { serverUrl: "https://licenses.example.test", productId: "studio" },
    uuid = "b1234567-b123-c123-d123-e123456789ab";
  const report = await createMacOSDeviceSignalsProvider({
    platform: "darwin",
    execute: async (file, args) => {
      if (file === "/usr/sbin/ioreg") {
        assert.deepEqual(args, ["-r", "-d", "1", "-c", "IOPlatformExpertDevice", "-w", "0"]);
        return `"IOPlatformSerialNumber" = "PRIVATE-SERIAL"\n"IOPlatformUUID" = "${uuid}"`;
      }
      assert.equal(file, "/usr/sbin/diskutil");
      assert.deepEqual(args, ["info", "-plist", "/"]);
      return `<plist><dict><key>VolumeUUID</key><string>${uuid}</string><key>APFSSnapshotUUID</key><string>IGNORE-SNAPSHOT</string></dict></plist>`;
    },
  })(context);
  assert.equal(report.signals.length, 2);
  assert.equal(JSON.stringify(report).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(report).includes(uuid), false);
  const missing = await createMacOSDeviceSignalsProvider({
    platform: "darwin",
    execute: async () => "<key>APFSSnapshotUUID</key><string>ignore</string>",
  })(context);
  assert.ok(missing.diagnostics.every((d) => d.status === "unavailable"));
  const oversized = await createMacOSDeviceSignalsProvider({
    platform: "darwin",
    execute: async () => "x".repeat(65537),
  })(context);
  assert.ok(oversized.diagnostics.every((d) => d.status === "query_failed"));
});

test("Auto detection selects a single desktop adapter; unsupported runtimes retain installation operation", async () => {
  const context = { serverUrl: "https://licenses.example.test", productId: "studio" };
  for (const platform of ["linux", "darwin", "win32", "freebsd"]) {
    const provider = createDeviceSignalsProvider({
      platform,
      windows: { query: async () => "" },
      linux: { readFile: async () => "", execute: async () => "" },
      macos: { execute: async () => "" },
    });
    const report = await provider(context);
    assert.equal(
      report.diagnostics.length,
      platform === "freebsd" ? 0 : platform === "darwin" ? 2 : 3,
    );
    assert.equal(report.signals.length, 0);
  }
});

test("Native host collector returns bounded safe diagnostics without elevation or identifier logs", async (t) => {
  const report = await createDeviceSignalsProvider()({
    serverUrl: "https://licenses.example.test",
    productId: "native-smoke",
  });
  assert.ok(report.signals.every((s) => /^[a-f0-9]{64}$/.test(s.hash)));
  assert.ok(report.diagnostics.every((d) => d.status !== "unsupported"));
  t.diagnostic(JSON.stringify({ platform: process.platform, diagnostics: report.diagnostics }));
});

test("Linux/macOS registration and authenticated backfill preserve grants, seats, trial consumption and sales", async (t) => {
  const h = await fixture(t),
    uuid = "b1234567-b123-c123-d123-e123456789ab";
  for (const platform of ["linux", "darwin"]) {
    const storage = new MemoryStorage();
    const provider = createDeviceSignalsProvider({
      platform,
      linux: {
        readFile: async (path) =>
          path === "/etc/machine-id" ? "b1234567b123c123d123e123456789ab" : uuid,
        execute: async () => uuid,
      },
      macos: {
        execute: async (file) =>
          file.endsWith("ioreg")
            ? `"IOPlatformUUID" = "${uuid}"`
            : `<key>VolumeUUID</key><string>${uuid}</string>`,
      },
    });
    const client = new KeyForgeClient(h.options(storage, { deviceSignalsProvider: provider }));
    await client.startTrial();
    await client.consumeTrial(3);
    const issued = await h.issue();
    await client.activate(issued.key);
    const original = (await storage.load())!;
    const groups = (await h.admin("GET", "/machines")).machines.map((m: any) => [
      m.id,
      m.registrationCount,
    ]);
    const finance = await h.admin("GET", "/finance");
    await client.updateDeviceSignals();
    await client.register();
    assert.equal((await client.refresh()).state, "licensed");
    assert.deepEqual((await storage.load())!.registration, original.registration);
    assert.equal((await storage.load())!.trialConsumed, 3);
    assert.deepEqual(
      (await h.admin("GET", "/machines")).machines.map((m: any) => [m.id, m.registrationCount]),
      groups,
    );
    assert.deepEqual(await h.admin("GET", "/finance"), finance);
    const installation = (await h.admin("GET", "/installations")).installations.find(
      (i: any) => i.installationId === original.installationId,
    );
    assert.equal(installation.signalAvailability, "Available");
    assert.equal(installation.signalKinds.length, platform === "darwin" ? 2 : 3);
    assert.equal(installation.machineGroups.length, 1);
    assert.equal(JSON.stringify(installation).includes("hash"), false);
    assert.equal(
      (await h.admin("GET", `/licenses/${issued.license.id}/activations`)).activations.filter(
        (b: any) => !b.deactivatedAt,
      ).length,
      1,
    );
  }
});

test("Device backfill is authenticated, product isolated and leaves trials, seats and finance unchanged", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage();
  let generation = 0;
  const options = h.options(storage, {
    deviceSignalsProvider: async () => ({
      signals: [{ kind: "machine-guid", hash: String(++generation).padStart(64, "0") }],
      diagnostics: [{ kind: "machine-guid", status: "available" }],
    }),
  });
  const client = new KeyForgeClient(options);
  await client.startTrial();
  await client.consumeTrial(2);
  const issued = await h.issue();
  await client.activate(issued.key);
  const state = (await storage.load())!;
  const originalRegistration = structuredClone(state.registration);
  const before = await h.admin("GET", "/machines"),
    sales = await h.admin("GET", "/finance"),
    bindings = await h.admin("GET", `/licenses/${issued.license.id}/activations`);
  await client.updateDeviceSignals();
  const after = await h.admin("GET", "/machines");
  assert.equal(after.machines[0].registrationCount, before.machines[0].registrationCount);
  assert.equal(after.machines[0].id, before.machines[0].id);
  assert.equal(after.machines[0].trialState, before.machines[0].trialState);
  assert.deepEqual(await h.admin("GET", "/finance"), sales);
  assert.deepEqual(
    (await h.admin("GET", `/licenses/${issued.license.id}/activations`)).activations.map(
      (b: any) => [b.installationId, b.activatedAt, b.deactivatedAt],
    ),
    bindings.activations.map((b: any) => [b.installationId, b.activatedAt, b.deactivatedAt]),
  );
  assert.equal((await storage.load())!.trialConsumed, 2);
  assert.deepEqual((await storage.load())!.registration, originalRegistration);
  const installation = (await h.admin("GET", "/installations")).installations[0];
  assert.equal(installation.signalAvailability, "Partial");
  assert.equal(installation.machineGroups[0].id, before.machines[0].id);
  assert.equal(JSON.stringify(installation).includes("hash"), false);
  await h.admin("POST", "/admin/products", { id: "other", name: "Other product" });
  for (const [pid, secret] of [
    ["default", "wrong"],
    ["other", state.credential],
  ]) {
    const response = await h.app.inject({
      method: "PUT",
      url: `/v1/products/${pid}/installations/${state.installationId}/device-signals`,
      headers: { authorization: "Bearer " + secret },
      payload: { machineSignals: [] },
    });
    assert.equal(response.statusCode, 401);
  }
  assert.equal((await client.getAuthorization()).state, "licensed");
  // Existing state must not be recollected or rewritten during a registration replay.
  let recollected = false;
  await new KeyForgeClient(
    h.options(storage, {
      deviceSignalsProvider: async () => {
        recollected = true;
        throw new Error("no");
      },
    }),
  ).register();
  assert.equal(recollected, false);
});

test("Legacy backfill anchors by installation, never merges matching groups and tolerates missing signals", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage();
  const oldSignals = [
    { kind: "machine-guid" as const, hash: "a".repeat(64) },
    { kind: "smbios-uuid" as const, hash: "b".repeat(64) },
  ];
  const newSignals = [
    { kind: "machine-guid" as const, hash: "c".repeat(64) },
    { kind: "smbios-uuid" as const, hash: "d".repeat(64) },
  ];
  await new KeyForgeClient(
    h.options(storage, { registration: { machineSignals: oldSignals } }),
  ).startTrial();
  await new KeyForgeClient(
    h.options(new MemoryStorage(), { registration: { machineSignals: newSignals } }),
  ).register();
  const records = new Records(h.database.db);
  await records.put("product:default", "usage", { id: "preserved-meter", consumed: 37 });
  const before = (await h.admin("GET", "/machines")).machines;
  const registration = await records.list("product:default", "registration");
  const consumption = await records.list("product:default", "usage");
  const state = (await storage.load())!;
  const own = before.find((m: any) => m.installationIds.includes(state.installationId));
  const client = new KeyForgeClient(
    h.options(storage, {
      deviceSignalsProvider: async () => ({ signals: newSignals, diagnostics: [] }),
    }),
  );
  await client.updateDeviceSignals();
  await client.updateDeviceSignals();
  const after = (await h.admin("GET", "/machines")).machines;
  assert.deepEqual(
    after.map((m: any) => [m.id, m.registrationCount, m.installationIds]),
    before.map((m: any) => [m.id, m.registrationCount, m.installationIds]),
  );
  assert.deepEqual(
    (await h.admin("GET", "/installations")).installations
      .find((i: any) => i.installationId === state.installationId)
      .machineGroups.map((g: any) => g.id),
    [own.id],
  );
  assert.deepEqual(await records.list("product:default", "registration"), registration);
  assert.deepEqual(await records.list("product:default", "usage"), consumption);
  assert.equal((await storage.load())!.trialToken, state.trialToken);
  const unavailable = new KeyForgeClient(
    h.options(storage, {
      deviceSignalsProvider: async () => {
        throw new Error("PRIVATE HARDWARE IDENTIFIER");
      },
    }),
  );
  await unavailable.updateDeviceSignals();
  assert.equal((await unavailable.getAuthorization()).state, "trial");
  assert.equal(
    (await h.admin("GET", "/installations")).installations.find(
      (i: any) => i.installationId === state.installationId,
    ).signalAvailability,
    "Unavailable",
  );
  assert.ok(
    (await unavailable.getDeviceSignalsDiagnostics()).every((d) => d.status === "query_failed"),
  );
  assert.equal(JSON.stringify(await storage.load()).includes("PRIVATE HARDWARE"), false);
  await assert.rejects(
    () =>
      new KeyForgeClient(
        h.options(new MemoryStorage(), {
          deviceSignalsProvider: async () => ({ signals: [], diagnostics: [] }),
        }),
      ).updateDeviceSignals(),
    { code: "registration_required" },
  );
});

test("SDK online activation, offline restart, grace expiry and signed negative refresh", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage));
  assert.equal((await client.getAuthorization()).state, "unlicensed");
  const issued = await h.issue();
  assert.equal((await client.validate(issued.key)).valid, true);
  assert.equal((await client.getAuthorization()).state, "unlicensed"); // inspection grants nothing
  assert.equal((await client.activate(issued.key)).state, "licensed");
  const snapshot = await storage.load();
  assert.ok(snapshot?.registered);
  assert.equal(JSON.stringify(snapshot).includes(issued.key), false); // never persist the product key
  let calls = 0;
  const offline = new KeyForgeClient(
    h.options(storage, {
      fetch: async () => {
        calls++;
        throw new TypeError("offline");
      },
    }),
  );
  assert.equal((await offline.getAuthorization()).state, "licensed");
  assert.equal(calls, 0);
  h.advance(31 * 86400000);
  assert.deepEqual(await offline.getAuthorization(), {
    state: "reconnect_required",
    reason: "offline_grace_expired",
  });
  await assert.rejects(() => offline.refresh(), { code: "network_error" });
  assert.equal(calls, 3);
  assert.equal((await client.refresh()).state, "licensed");
  await h.admin("POST", `/licenses/${issued.license.id}/revoke`, {});
  assert.equal((await client.refresh()).state, "revoked");
  assert.equal((await offline.getAuthorization()).state, "revoked"); // persists even HTTP 200 negative status
  const replayedActive = new KeyForgeClient(
    h.options(storage, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            token: snapshot?.licenseToken,
            serverTime: new Date(h.now()).toISOString(),
          }),
        ),
    }),
  );
  await assert.rejects(() => replayedActive.refresh(), { code: "stale_grant" });
  assert.equal((await client.getAuthorization()).state, "revoked");
});

test("SDK trial is explicit, allowance survives refresh/restart, disabled and spent trials fail closed", async (t) => {
  const h = await fixture(t);
  await h.product({ trial: { enabled: true, allowance: 3, durationDays: 2 } });
  const signals = [
    { kind: "machine-guid" as const, hash: "a".repeat(64) },
    { kind: "smbios-uuid" as const, hash: "b".repeat(64) },
  ];
  const storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage, { registration: { machineSignals: signals } }));
  await client.register();
  assert.equal((await client.getAuthorization()).state, "unlicensed");
  assert.equal((await client.startTrial()).state, "trial");
  const consumed = await client.consumeTrial(2);
  assert.equal(consumed.state === "trial" && consumed.remaining, 1);
  const restarted = new KeyForgeClient(h.options(storage));
  const grant = await restarted.getAuthorization();
  assert.equal(grant.state === "trial" && grant.remaining, 1);
  const issued = await h.issue();
  await restarted.activate(issued.key);
  await restarted.refresh();
  assert.equal((await storage.load())?.trialConsumed, 2);
  await restarted.deactivate();
  assert.equal((await restarted.getAuthorization()).state, "unlicensed");
  assert.equal((await restarted.startTrial()).state, "trial");
  assert.deepEqual(await restarted.consumeTrial(), { state: "expired", reason: "trial_exhausted" });
  await restarted.startTrial();
  assert.deepEqual(await restarted.getAuthorization(), {
    state: "expired",
    reason: "trial_exhausted",
  });
  const spent = new KeyForgeClient(
    h.options(new MemoryStorage(), { registration: { machineSignals: signals } }),
  );
  assert.deepEqual(await spent.startTrial(), { state: "expired", reason: "trial_spent" });
  await h.product({ trial: { enabled: false, allowance: null, durationDays: null } });
  const disabled = new KeyForgeClient(h.options());
  assert.equal((await disabled.startTrial()).state, "unlicensed");
  await h.product({ trial: { enabled: true, allowance: null, durationDays: 1 } });
  const timeOnly = new KeyForgeClient(h.options());
  const timed = await timeOnly.startTrial();
  assert.equal(timed.state === "trial" && timed.remaining, null);
  h.advance(86400001);
  assert.deepEqual(await timeOnly.getAuthorization(), {
    state: "expired",
    reason: "trial_expired",
  });
});

test("initial registration and deferred trial require online access, exact registration survives response loss and restart", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage();
  const sent: { body: string; bearer: string | null }[] = [];
  let collections = 0;
  const deviceSignalsProvider: ClientOptions["deviceSignalsProvider"] = async () => ({
    signals: [{ kind: "machine-guid", hash: String(++collections).padStart(64, "0") }],
    diagnostics: [{ kind: "machine-guid", status: "available" }],
  });
  const interrupted = new KeyForgeClient(
    h.options(storage, {
      maxAttempts: 1,
      deviceSignalsProvider,
      fetch: async (input, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), (await storage.load())?.registration);
        sent.push({
          body: String(init?.body),
          bearer: new Headers(init?.headers).get("authorization"),
        });
        await contractFetch(input, init);
        throw new TypeError("lost response");
      },
    }),
  );
  await assert.rejects(() => interrupted.register(), { code: "network_error" });
  assert.equal((await storage.load())?.registered, false);
  const replay = new KeyForgeClient(
    h.options(storage, {
      registration: { appVersion: "new version after restart" },
      deviceSignalsProvider,
      fetch: async (input, init) => {
        sent.push({
          body: String(init?.body),
          bearer: new Headers(init?.headers).get("authorization"),
        });
        return contractFetch(input, init);
      },
    }),
  );
  await replay.register();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(collections, 1);
  const offline = new KeyForgeClient(
    h.options(storage, {
      maxAttempts: 1,
      fetch: async () => {
        throw new TypeError("offline");
      },
    }),
  );
  await assert.rejects(() => offline.startTrial(), { code: "network_error" });
  assert.equal((await offline.getAuthorization()).state, "unlicensed");
  assert.equal((await h.admin("GET", "/installations")).total, 1);
  await assert.rejects(
    () =>
      new KeyForgeClient(
        h.options(new MemoryStorage(), {
          maxAttempts: 1,
          fetch: async () => {
            throw new TypeError("offline");
          },
        }),
      ).activate("some-key"),
    { code: "network_error" },
  );
});

test("activation retry cannot duplicate a seat; exhausted seats and lost credentials are explicit failures", async (t) => {
  const h = await fixture(t),
    issued = await h.issue(),
    storage = new MemoryStorage();
  let lost = false;
  const client = new KeyForgeClient(
    h.options(storage, {
      fetch: async (input, init) => {
        const response = await contractFetch(input, init);
        if (String(input).endsWith("/activate") && !lost) {
          lost = true;
          throw new TypeError("lost activation response");
        }
        return response;
      },
    }),
  );
  assert.equal((await client.activate(issued.key)).state, "licensed");
  const second = new KeyForgeClient(h.options());
  await assert.rejects(() => second.activate(issued.key), {
    code: "activation_limit_reached",
    status: 409,
  });
  assert.equal((await second.getAuthorization()).state, "unlicensed");
  const state = (await storage.load())!;
  state.credential = randomBytes(32).toString("base64url");
  await storage.save(state);
  await assert.rejects(() => client.refresh(), { code: "installation_unauthorized", status: 401 });
  assert.deepEqual(await client.getAuthorization(), {
    state: "reconnect_required",
    reason: "installation_unauthorized",
  });
});

test("released and expired licenses cannot fall back to cached active authorization", async (t) => {
  const h = await fixture(t),
    client = new KeyForgeClient(h.options()),
    issued = await h.issue();
  await client.activate(issued.key);
  await h.admin("POST", `/licenses/${issued.license.id}/deactivate`, {
    installationId: (await client.register()).installationId,
  });
  await assert.rejects(() => client.refresh(), { code: "not_activated_here" });
  assert.equal((await client.getAuthorization()).state, "reconnect_required");
  await client.activate(issued.key);
  const record = (await h.admin("GET", `/licenses/${issued.license.id}`)).license;
  await h.admin("PATCH", `/licenses/${issued.license.id}`, {
    revision: record.revision,
    expiresAt: new Date(h.now() - 1000).toISOString(),
  });
  assert.equal((await client.refresh()).state, "expired");
});

test("SDK messaging, notifications and license collection preserve customer privacy and idempotency", async (t) => {
  const h = await fixture(t),
    client = new KeyForgeClient(h.options()),
    registration = await client.register();
  const issued = await h.issue({ installationId: registration.installationId });
  const feed = await client.getNotifications();
  const notice = feed.items.find((n) => n.kind === "license");
  assert.ok(notice);
  assert.equal(JSON.stringify(feed).includes(issued.key), false);
  const delivered = await client.collectLicense(issued.license.id);
  assert.equal(delivered.key, issued.key);
  assert.equal((await client.getAuthorization()).state, "unlicensed"); // collecting doesn't activate
  await client.activate(delivered.key);
  const input = {
    requestId: randomUUID(),
    licenseId: issued.license.id,
    category: "technical" as const,
    urgency: "normal" as const,
    subject: "SDK integration",
    message: "Please help with this integration",
    createdAt: new Date(h.now()).toISOString(),
  };
  const first = await client.createSupportThread(input),
    replay = await client.createSupportThread(input);
  assert.equal(first.request.id, replay.request.id);
  let thread = (await client.getSupportThread(first.request.id)).request;
  await h.admin("POST", `/support/${thread.id}/messages`, {
    requestId: randomUUID(),
    revision: thread.revision,
    message: "Internal private note",
    internal: true,
  });
  thread = (await h.admin("GET", `/support/${thread.id}`)).request;
  await h.admin("POST", `/support/${thread.id}/messages`, {
    requestId: randomUUID(),
    revision: thread.revision,
    message: "Visible operator answer",
    internal: false,
  });
  thread = (await client.getSupportThread(thread.id)).request;
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].author, "support");
  assert.equal(JSON.stringify(thread).includes("Internal private note"), false);
  assert.equal("assignedTo" in thread, false);
  const reply = {
    requestId: randomUUID(),
    revision: thread.revision,
    message: "Thanks for your answer",
  };
  await client.replyToSupportThread(thread.id, reply);
  await client.replyToSupportThread(thread.id, reply);
  assert.equal((await client.listSupportThreads()).requests[0].messages.length, 2);
  const replies = await client.getNotifications(),
    notification = replies.items.find((n) => n.kind === "reply");
  assert.ok(notification);
  await client.markNotificationRead(notification.id);
  assert.equal(
    (await client.getNotifications()).items.find((n) => n.id === notification.id)?.read,
    true,
  );
  await client.setNotificationPreferences({ messages: false, expirations: false });
  assert.ok((await client.getNotifications()).items.every((n) => n.kind === "license"));
  const stranger = new KeyForgeClient(h.options());
  await stranger.register();
  await assert.rejects(() => stranger.collectLicense(issued.license.id), {
    code: "delivery_unavailable",
  });
  await assert.rejects(() => stranger.getSupportThread(thread.id), {
    code: "unknown_support_request",
  });
  assert.deepEqual((await stranger.listSupportThreads()).requests, []);
});

test("verifier rejects altered, malformed, unknown-version/key, wrong context and future tokens", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage));
  const issued = await h.issue();
  await client.activate(issued.key);
  const state = (await storage.load())!,
    token = state.licenseToken!;
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  const context = {
    productId: "default",
    installationId: state.installationId,
    publicKeys: { "sdk-key": h.pair.publicKey },
    now: h.now(),
  };
  const mint = (body: object, encodedSigning = false) => {
    const bytes = Buffer.from(JSON.stringify(body)),
      encoded = bytes.toString("base64url");
    return (
      encoded +
      "." +
      sign(null, encodedSigning ? Buffer.from(encoded) : bytes, h.pair.privateKey).toString(
        "base64url",
      )
    );
  };
  assert.ok(productTokenSchema.safeParse(await verifySignedToken(token, context)).success);
  for (const [body, code] of [
    [{ ...payload, v: 3 }, "invalid_payload"],
    [{ ...payload, kid: "unknown" }, "unknown_key"],
    [{ ...payload, iss: "other" }, "invalid_payload"],
    [{ ...payload, productId: "other" }, "context_mismatch"],
    [
      { ...payload, installationId: "other", subject: { kind: "installation", id: "other" } },
      "context_mismatch",
    ],
    [{ ...payload, subject: { kind: "service", id: state.installationId } }, "context_mismatch"],
    [{ ...payload, issuedAt: new Date(h.now() + 600000).toISOString() }, "future_issuance"],
    [{ ...payload, extra: true }, "invalid_payload"],
    [{ ...payload, entitlements: { broken: null } }, "invalid_payload"],
  ] as const)
    await assert.rejects(() => verifySignedToken(mint(body), context), { code });
  await assert.rejects(() => verifySignedToken(mint(payload, true), context), {
    code: "invalid_signature",
  });
  const altered = { ...payload, plan: "tampered" };
  await assert.rejects(
    () =>
      verifySignedToken(
        Buffer.from(JSON.stringify(altered)).toString("base64url") + "." + token.split(".")[1],
        context,
      ),
    { code: "invalid_signature" },
  );
  for (const malformed of [
    "",
    token + ".extra",
    "a.b",
    token.replace(".", "=."),
    "A".repeat(65537),
  ])
    await assert.rejects(() => verifySignedToken(malformed, context), TokenError);
  const corrupted = { ...state, licenseToken: "broken" };
  await storage.save(corrupted);
  assert.equal((await client.getAuthorization()).state, "reconnect_required");
  assert.equal((await client.activate(issued.key)).state, "licensed"); // recover with a freshly authenticated grant, retaining identity/counters
});

test("SDK rejects clock rollback, storage corruption/context mixup and unsafe URLs; serializes concurrent use", async (t) => {
  const h = await fixture(t),
    storage = new MemoryStorage(),
    client = new KeyForgeClient(h.options(storage));
  await client.startTrial();
  h.advance(600000);
  await client.getAuthorization();
  h.advance(-600000);
  assert.deepEqual(await client.getAuthorization(), {
    state: "reconnect_required",
    reason: "clock_rollback",
  });
  assert.throws(
    () => new KeyForgeClient(h.options(storage, { serverUrl: "http://unsafe.example" })),
    { code: "invalid_server_url" },
  );
  assert.throws(
    () =>
      new KeyForgeClient(h.options(storage, { serverUrl: "https://user:password@example.com" })),
    { code: "invalid_server_url" },
  );
  const mixed = new KeyForgeClient(h.options(storage, { productId: "other" }));
  await assert.rejects(() => mixed.register(), { code: "storage_context_mismatch" });
  const invalidStorage: SecureStorage = {
    load: async () => ({ version: 2 }) as unknown as ClientState,
    save: async () => {},
  };
  await assert.rejects(() => new KeyForgeClient(h.options(invalidStorage)).register(), {
    code: "invalid_stored_state",
  });
  h.advance(600000);
  const concurrent = new KeyForgeClient(h.options());
  await Promise.all([concurrent.register(), concurrent.register(), concurrent.startTrial()]);
  await Promise.all([
    concurrent.consumeTrial(),
    concurrent.consumeTrial(),
    concurrent.consumeTrial(),
  ]);
  const grant = await concurrent.getAuthorization();
  assert.equal(grant.state === "trial" && grant.remaining, 19997);
});

test("SDK retries transient failures with bounds, honors throttling and never includes secrets in errors", async (t) => {
  const h = await fixture(t);
  for (const status of [429, 502, 503, 504]) {
    const delays: number[] = [];
    let calls = 0;
    const client = new KeyForgeClient(
      h.options(new MemoryStorage(), {
        sleep: async (ms) => {
          delays.push(ms);
        },
        fetch: async (input, init) => {
          if (++calls === 1)
            return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
              status,
              headers: { "retry-after": "1" },
            });
          return contractFetch(input, init);
        },
      }),
    );
    await client.register();
    assert.equal(calls, 2);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 1000);
  }
  let calls = 0;
  const limited = new KeyForgeClient(
    h.options(new MemoryStorage(), {
      fetch: async () => {
        calls++;
        return new Response("{}", { status: 429, headers: { "retry-after": "60" } });
      },
    }),
  );
  await assert.rejects(() => limited.register(), { status: 429 });
  assert.equal(calls, 1);
  const forbidden = new KeyForgeClient(
    h.options(new MemoryStorage(), {
      fetch: async () =>
        new Response(JSON.stringify({ error: "denied", message: "secret must never be copied" }), {
          status: 403,
        }),
    }),
  );
  await assert.rejects(
    () => forbidden.register(),
    (error) => error instanceof KeyForgeError && !String(error).includes("secret"),
  );
  let timeouts = 0;
  const stalled = new KeyForgeClient(
    h.options(new MemoryStorage(), {
      maxAttempts: 2,
      timeoutMs: 10,
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          timeouts++;
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    }),
  );
  await assert.rejects(() => stalled.register(), { code: "request_timeout" });
  assert.equal(timeouts, 2);
});

test("Node reference uses real HTTP and SDK enforces durable identity before sending", async (t) => {
  const h = await fixture(t),
    issued = await h.issue();
  const skipped = await runReference(h.options());
  assert.equal(skipped.authorization.state, "unlicensed");
  assert.equal(skipped.canUsePaidFeatures, false);
  const result = await runReference(h.options(), { key: issued.key });
  assert.equal(result.authorization.state, "licensed");
  assert.equal(result.canUsePaidFeatures, true);
  const trial = await runReference(h.options(), { trial: true });
  assert.equal(trial.authorization.state, "trial");
  assert.equal(trial.canUsePaidFeatures, false);
  let calls = 0;
  const failing: SecureStorage = {
    load: async () => null,
    save: async () => {
      throw new Error("vault unavailable");
    },
  };
  await assert.rejects(
    () =>
      new KeyForgeClient(
        h.options(failing, {
          fetch: async () => {
            calls++;
            return new Response("{}");
          },
        }),
      ).register(),
    /vault unavailable/,
  );
  assert.equal(calls, 0);
});

test("OpenAPI request links and backend metering contracts are exercised without desktop credential escalation", async (t) => {
  const h = await fixture(t);
  const call = async <T>(
    method: string,
    path: string,
    payload?: object,
    secret?: string,
  ): Promise<T> => {
    const response = await contractFetch(h.url + path, {
      method,
      headers: {
        ...(payload ? { "content-type": "application/json" } : {}),
        ...(secret ? { authorization: "Bearer " + secret } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    assert.ok(response.ok);
    return response.json() as Promise<T>;
  };
  await call("GET", "/healthz");
  await call("GET", "/v1/meta");
  await call("GET", "/v1/products/default/keys");
  const catalog = await call<{ products: { plans: { id: string }[] }[] }>(
      "GET",
      "/v1/license-request-catalog",
    ),
    plan = catalog.products[0].plans[0].id;
  const secret = randomBytes(32).toString("base64url"),
    id = randomUUID();
  await call(
    "POST",
    "/v1/license-requests",
    { id, productId: "default", plan, name: "Request customer", email: "buyer@example.com" },
    secret,
  );
  await call("GET", "/v1/license-requests/" + id, undefined, secret);
  const issued = await h.issue({ licenseRequestId: id });
  await call("GET", "/v1/license-requests/" + id, undefined, secret);
  const collected = await call<{ key: string }>(
    "POST",
    `/v1/license-requests/${id}/collect`,
    undefined,
    secret,
  );
  assert.equal(collected.key, issued.key);
  await h.admin("PUT", "/definitions/actions", {
    id: "actions",
    type: "number",
    description: "Actions",
    minimum: 0,
    archived: false,
  });
  const license = (await h.admin("GET", `/licenses/${issued.license.id}`)).license;
  await h.admin("PATCH", `/licenses/${license.id}`, {
    revision: license.revision,
    entitlements: { actions: 10 },
  });
  await h.admin("PUT", "/meters/actions", {
    id: "actions",
    entitlement: "actions",
    period: "lifetime",
    description: "Actions",
    archived: false,
  });
  const credential = await h.admin("POST", "/credentials", {
    name: "Trusted backend fixture",
    permissions: ["usage:read", "usage:consume"],
  });
  const summary = await call<{ remaining: number }>(
    "POST",
    "/v1/products/default/usage/summary",
    { licenseId: license.id, meterId: "actions" },
    credential.secret,
  );
  assert.equal(summary.remaining, 10);
  const consumed = await call<{ remaining: number }>(
    "POST",
    "/v1/products/default/usage/consume",
    { licenseId: license.id, meterId: "actions", eventId: randomUUID(), units: 2 },
    credential.secret,
  );
  assert.equal(consumed.remaining, 8);
});

test("OpenAPI stays generated, valid and covers every public product/request route", async (t) => {
  const h = await fixture(t);
  assert.deepEqual(
    JSON.parse(readFileSync(new URL("../docs/client-openapi.json", import.meta.url), "utf8")),
    JSON.parse(clientOpenApiJson),
  );
  const operations = Object.entries(clientOpenApi.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method} ${path}`),
  );
  assert.deepEqual(
    h.routes.filter((r) => r.includes(" /v1/") || r === "get /healthz").sort(),
    operations.sort(),
  );
  for (const schema of Object.values(clientOpenApi.components.schemas))
    validate(
      { anyOf: [schema, { const: "__schema_compilation_probe__" }] },
      "__schema_compilation_probe__",
    );
  // Recovery routes are exercised by the dedicated import-contract integration suite.
  assert.deepEqual(
    [...methods].sort(),
    operations.filter((op) => !op.includes("/recovery-requests")).sort(),
  );
});
