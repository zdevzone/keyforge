import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildLicenseApp } from "../dist/src/app.js";
import { createAuth, closeAuth, ensureAuthSchema, seedOperator } from "../dist/src/auth.js";
import { loadConfig } from "../dist/src/config.js";
import { LicenseDatabase } from "../dist/src/db.js";
import { resolveSigningKey } from "../dist/src/keypair.js";
import { Records, Vault, atomic } from "../dist/src/platform-store.js";
import { WORKSPACE } from "../dist/src/platform.js";
import { resolveRuntime } from "../dist/src/runtime.js";
import { loadKeyRing } from "../dist/src/secrets.js";
import { flags, requireOffline } from "./maintenance-common.mjs";

export async function seedDemo(
  env = process.env,
  output = resolve(".artifacts/demo/manifest.json"),
) {
  const runtime = resolveRuntime(env),
    ring = loadKeyRing("LICENSE_DATA_KEYRING", env),
    privateKey = resolveSigningKey(env);
  if (!ring || !env.LICENSE_AUTH_SECRET)
    throw Error("Demo seeding requires the data key ring and console auth secret.");
  if (!runtime.url) {
    await mkdir(dirname(runtime.sqlitePath), { recursive: true });
    await mkdir(dirname(runtime.authDbPath), { recursive: true });
  }
  const db = await LicenseDatabase.open({ url: runtime.url, sqlitePath: runtime.sqlitePath }),
    records = new Records(db.db),
    vault = new Vault(ring);
  const save = async (manifest) => {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    console.log("Demo ready. Local credentials and fixture IDs: " + output);
    return manifest;
  };
  let auth, app;
  try {
    const prior = await records.get(WORKSPACE, "demo-seed", "v1");
    if (prior)
      return await save(JSON.parse(vault.decrypt(prior.encryptedManifest, "demo-seed:v1")));
    if (await records.get(WORKSPACE, "product", "demo-api"))
      throw Error("A partial demo-api product exists. Reset the demo database before seeding.");
    const operators = {
      admin: { email: "demo.admin@keyforge.test", password: randomBytes(24).toString("base64url") },
      support: {
        email: "demo.support@keyforge.test",
        password: randomBytes(24).toString("base64url"),
      },
    };
    await seedOperator({
      dbPath: runtime.authDbPath,
      url: runtime.url,
      secret: env.LICENSE_AUTH_SECRET,
      baseURL: env.LICENSE_SERVER_URL || env.RENDER_EXTERNAL_URL,
      ...operators.admin,
      name: "Demo Administrator",
    });
    auth = createAuth({
      dbPath: runtime.authDbPath,
      url: runtime.url,
      secret: env.LICENSE_AUTH_SECRET,
      baseURL: env.LICENSE_SERVER_URL || env.RENDER_EXTERNAL_URL,
      allowSignUp: true,
    });
    await ensureAuthSchema(auth);
    await auth.api.signUpEmail({ body: { ...operators.support, name: "Demo Support" } });
    const bearer = "demo-offline-" + randomBytes(24).toString("hex");
    app = await buildLicenseApp({
      database: db,
      privateKey,
      keyring: ring,
      auth,
      authDbPath: runtime.url ? undefined : runtime.authDbPath,
      adminToken: bearer,
      config: loadConfig(env.LICENSE_CONFIG),
      backups: { enabled: false },
      uiDir: ".no-ui",
    });
    const call = async (method, url, payload, secret = bearer) => {
      const result = await app.inject({
        method,
        url,
        payload,
        headers: {
          authorization: "Bearer " + secret,
          ...(url.endsWith("/support") && payload?.requestId
            ? { "idempotency-key": payload.requestId }
            : {}),
        },
      });
      if (result.statusCode >= 400)
        throw Error("Demo " + method + " " + url + " failed: " + result.json().error);
      return result.json();
    };
    const admin = (product, method, path, body) =>
      call(method, "/admin/products/" + product + path, body);
    await call("POST", "/admin/products", { id: "demo-api", name: "Atlas API" });
    for (const product of ["default", "demo-api"]) {
      const definition = product === "default" ? "exports" : "requests";
      await admin(product, "PUT", "/definitions/" + definition, {
        id: definition,
        type: "number",
        description: "Monthly " + definition,
        minimum: 0,
        defaultValue: 100,
        archived: false,
      });
      await admin(product, "PUT", "/definitions/team", {
        id: "team",
        type: "boolean",
        description: "Team collaboration",
        defaultValue: false,
        archived: false,
      });
      await admin(product, "PUT", "/plans/starter-demo", {
        id: "starter-demo",
        description: "Starter demo plan",
        price: 100000,
        currency: "ETB",
        entitlements: { [definition]: 500, team: false },
        durationDays: 30,
        activationLimit: 1,
        archived: false,
      });
      await admin(product, "PUT", "/plans/pro-demo", {
        id: "pro-demo",
        description: "Team demo plan",
        price: 250000,
        currency: "ETB",
        entitlements: { [definition]: 10000, team: true },
        durationDays: null,
        activationLimit: 3,
        archived: false,
      });
      await admin(product, "PUT", "/meters/monthly-" + definition, {
        id: "monthly-" + definition,
        entitlement: definition,
        period: "monthly",
        description: "Monthly " + definition,
        archived: false,
      });
    }
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      origin: env.LICENSE_SERVER_URL || env.RENDER_EXTERNAL_URL || "http://localhost:4100",
      operators,
      products: ["default", "demo-api"],
      licenses: [],
      installations: [],
      support: [],
      credentials: [],
    };
    for (const [index, name] of [
      "Acme Design",
      "Northwind Studio",
      "Contoso Research",
      "Expired Evaluation",
      "Revoked Customer",
    ].entries()) {
      const issued = await admin("default", "POST", "/licenses", {
        requestId: randomUUID(),
        plan: index % 2 ? "starter-demo" : "pro-demo",
        issuedTo: name,
      });
      if (index === 3) {
        const updated = await admin("default", "PATCH", "/licenses/" + issued.license.id, {
          revision: issued.license.revision,
          expiresAt: new Date(Date.now() - 86400000).toISOString(),
        });
        issued.license = updated.license;
      }
      manifest.licenses.push({ productId: "default", ...issued });
      if (index === 4) {
        await admin("default", "POST", "/licenses/" + issued.license.id + "/revoke", {});
        continue;
      }
      if (index === 3) continue;
      const installationId = "demo-desktop-" + (index + 1),
        secret = randomBytes(32).toString("base64url");
      await call(
        "POST",
        "/v1/products/default/register",
        {
          installationId,
          requestId: randomUUID(),
          appVersion: "2.4.1",
          platform: index === 1 ? "macOS" : "Windows",
          userName: name,
          userEmail: "customer" + index + "@example.test",
          machineSignals: ["machine-guid", "smbios-uuid"].map((kind) => ({
            kind,
            hash: createHash("sha256")
              .update(installationId + kind)
              .digest("hex"),
          })),
        },
        secret,
      );
      const activation = await call(
        "POST",
        "/v1/products/default/activate",
        { installationId, key: issued.key },
        secret,
      );
      manifest.installations.push({
        installationId,
        secret,
        productId: "default",
        licenseId: issued.license.id,
        token: activation.token,
      });
    }
    const trialId = "demo-trial-installation",
      trialSecret = randomBytes(32).toString("base64url");
    const trial = await call(
      "POST",
      "/v1/products/default/register",
      {
        installationId: trialId,
        requestId: randomUUID(),
        appVersion: "2.4.1",
        platform: "Linux",
        userName: "Trial Customer",
        userEmail: "trial@example.test",
        machineSignals: ["machine-guid", "smbios-uuid"].map((kind) => ({
          kind,
          hash: createHash("sha256")
            .update(trialId + kind)
            .digest("hex"),
        })),
      },
      trialSecret,
    );
    manifest.installations.push({
      installationId: trialId,
      secret: trialSecret,
      productId: "default",
      trialToken: trial.trial?.token,
    });
    const first = manifest.installations[0];
    for (const [index, subject] of [
      "Activation limit after replacing a laptop",
      "Export quota question",
      "Invoice and renewal request",
    ].entries()) {
      const requestId = randomUUID(),
        response = await call(
          "POST",
          "/v1/products/default/installations/" + first.installationId + "/support",
          {
            requestId,
            licenseId: first.licenseId,
            subject,
            message: "This is a fictional demo request for testing operator actions.",
            category: ["technical", "licensing", "billing"][index],
            urgency: index === 0 ? "high" : "normal",
            createdAt: new Date().toISOString(),
          },
          first.secret,
        );
      const id = response.request.id;
      manifest.support.push({ id, subject });
      if (index === 0) {
        let current = (await admin("default", "GET", "/support/" + id)).request;
        await admin("default", "PATCH", "/support/" + id, {
          revision: current.revision,
          status: "in_progress",
          assignedTo: operators.support.email,
        });
        current = (await admin("default", "GET", "/support/" + id)).request;
        await admin("default", "POST", "/support/" + id + "/messages", {
          revision: current.revision,
          requestId: randomUUID(),
          message: "We are checking your previous activation.",
          internal: false,
        });
        current = (await admin("default", "GET", "/support/" + id)).request;
        await admin("default", "POST", "/support/" + id + "/messages", {
          revision: current.revision,
          requestId: randomUUID(),
          message: "Internal demo note: confirm the hardware replacement.",
          internal: true,
        });
      }
    }
    for (const productId of ["default", "demo-api"]) {
      const credential = await admin(productId, "POST", "/credentials", {
        name: "Demo backend integration",
        permissions: ["usage:read", "usage:consume"],
      });
      manifest.credentials.push({ productId, ...credential });
      const grant =
        productId === "default"
          ? manifest.licenses[0]
          : await admin(productId, "POST", "/licenses", {
              requestId: randomUUID(),
              plan: "pro-demo",
              issuedTo: "Atlas API integration",
              subjectKind: "service",
            });
      if (productId !== "default") manifest.licenses.push({ productId, ...grant });
      await call(
        "POST",
        "/v1/products/" + productId + "/usage/consume",
        {
          licenseId: grant.license.id,
          meterId: productId === "default" ? "monthly-exports" : "monthly-requests",
          units: 125,
          eventId: randomUUID(),
        },
        credential.secret,
      );
    }
    await atomic(db, (r) =>
      r.put(WORKSPACE, "demo-seed", {
        id: "v1",
        encryptedManifest: vault.encrypt(JSON.stringify(manifest), "demo-seed:v1"),
      }),
    );
    return await save(manifest);
  } finally {
    await app?.close();
    if (auth) await closeAuth(auth);
    await db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const flag = flags();
    await requireOffline(flag.has("maintenance"));
    await seedDemo(process.env, resolve(flag.read("output") || ".artifacts/demo/manifest.json"));
  } catch (error) {
    console.error(error?.message || "Demo seed failed.");
    process.exitCode = 1;
  }
}
