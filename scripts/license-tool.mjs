/**
 * The vendor's licensing tool — the counter across which keys are sold,
 * inspected, revoked and transferred.
 *
 * Everything except `keygen` and `inspect` talks to the deployed license
 * service's admin API, because the service's ledger is the source of truth and
 * a second tool writing to its database directly would eventually disagree
 * with it. Configure the connection once:
 *
 *   LICENSE_SERVER_URL=https://license.example.com
 *   LICENSE_ADMIN_TOKEN=<the token the service was started with>
 *
 * The signing keypair is the whole trust model: the public half is pasted into
 * `server/license.ts` and ships with every copy of the app; the private half
 * stays with the license service and nowhere else. `keygen` writes it to
 * LICENSE_SIGNING_KEY_FILE (default ./secrets/license-signing.key), which is
 * gitignored — move it somewhere safer than a working copy.
 */
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  confirmLocalUpdate,
  localEnvironmentOptions,
  readLocalEnv,
  saveLocalEnv,
} from "./local-env.mjs";

const [, , command, ...rest] = process.argv;
if (command === "--help" || command === "-h" || rest.includes("--help")) {
  usage();
  process.exit(0);
}
const environmentOptions = localEnvironmentOptions(rest);
const selectedEnvironment = await readLocalEnv(environmentOptions.file);
if (environmentOptions.explicit && !selectedEnvironment.exists && command !== "keygen")
  throw Error("The selected environment file does not exist.");
const environment = environmentOptions.explicit ? selectedEnvironment.values : process.env;

function env(name) {
  const value =
    environment[name] ||
    (name === "LICENSE_SERVER_URL" ? environment.RENDER_EXTERNAL_URL : undefined);
  if (!value) return value;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function flag(name, fallback = undefined) {
  const index = rest.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = rest[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
}

function usage() {
  console.log(`License tool

  --env-file PATH selects one environment for any command, without falling
  back to local or ambient server credentials. Relative key paths use the
  project working directory.

  vp run license keygen [--force] [--yes] [--env-file PATH] [--secrets-dir PATH]
      Generate the Ed25519 signing keypair. Prints the public key to embed in
      server/license.ts; writes LICENSE_SIGNING_KEY_FILE (default
      ./secrets/license-signing.key) — KEEP PRIVATE, gitignored.

  vp run license keycheck [--expect <pem-or-file>] [--token <token>] [--server]
      Validate the signing key this deployment is configured with and print its
      public half and fingerprint. --expect compares against the public key your
      app embeds; --token verifies a real issued token; --server compares the
      fingerprint the deployed service reports. Exits 1 on any mismatch.

  vp run license issue --plan standard --to "Name" [--installation ID]
                        [--request-id UUID] [--paid --method "Bank transfer" --reference ID]
      Issue from the saved plan and record its ETB sale. Unpaid by default.
      Reuse --request-id when retrying. Plan terms cannot be overridden here.

  vp run license list
  vp run license inspect <token-or-payload>
  vp run license revoke <licenseId>
  vp run license activations <licenseId>
  vp run license deactivate <licenseId> --installation <installationId>
      Release a binding. Import accounts retain ownership; transferring them
      requires approved recovery rather than ordinary reactivation elsewhere.

  vp run license machines [--q <reference|machineId|installationId>] [--limit 25]
      The trial ledger. Search by the support reference a customer reads out,
      a machine id from an earlier answer, or an installation id from a log.
      "trial" is what the next registration from that machine would be told.

  vp run license clear <machineId>
      Give one machine its trial back. Grants exactly ONE more: the next run
      reads fresh, the one after it is spent again. Audited.

  vp run license imports-enable --entitlement imports --revision N
  vp run license imports-account <licenseId>
  vp run license imports-adopt <licenseId> --granted N --revision N --reason TEXT
  vp run license renew <licenseId> --plan ID --mode renewal|top_up|extension --request-id UUID
      Renewal extends time and adds units once; top_up adds units only;
      extension changes time only. Optional --paid --method TEXT --reference TEXT.
  vp run license replace-key <licenseId> --request-id UUID --reason TEXT
      Preserves the existing usage account and creates no sale.
  vp run license recovery-list
  vp run license recovery-approve <requestId> --revision N --mode restore|lost_history --reason TEXT
  vp run license recovery-reject <requestId> --revision N --reason TEXT
      Verify customer identity independently first. lost_history consumes the
      previously granted budget; restore requires a committed encrypted backup.
      These commands change the selected server. Always select --product and
      --env-file deliberately. No recovery action is implied by ordinary keygen.

  Service connection (all but keygen/inspect; keycheck only with --server):
      LICENSE_SERVER_URL, LICENSE_ADMIN_TOKEN

  Signing key (keygen, keycheck):
      LICENSE_SIGNING_KEY or LICENSE_SIGNING_KEY_FILE
`);
}

async function admin(path, options = {}) {
  path = path.replace(
    /^\/admin\/(licenses|machines)/,
    "/admin/products/" + encodeURIComponent(flag("product") || "default") + "/$1",
  );
  const base = env("LICENSE_SERVER_URL");
  const token = env("LICENSE_ADMIN_TOKEN");
  if (!base || !token) {
    console.error("Set LICENSE_SERVER_URL and LICENSE_ADMIN_TOKEN to talk to the service.");
    process.exit(1);
  }
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(
      `${response.status} ${payload.error ?? ""}: ${payload.message ?? "request failed"}`,
    );
    process.exit(1);
  }
  return payload;
}

async function keygen() {
  // Write where the deployment says the key lives, so `keygen` and the
  // service agree without anyone moving a file by hand.
  const local = selectedEnvironment;
  const keyPath =
    env("LICENSE_SIGNING_KEY_FILE") ??
    local.values.LICENSE_SIGNING_KEY_FILE ??
    environmentOptions.secretsDir.replaceAll("\\", "/").replace(/\/$/, "") + "/license-signing.key";
  if (env("LICENSE_SIGNING_KEY") || local.values.LICENSE_SIGNING_KEY)
    throw new Error(
      "An inline signing key is configured. Remove it explicitly before generating a file-based replacement.",
    );
  if (existsSync(keyPath) && flag("force") !== true) {
    console.error(`${keyPath} already exists. Pass --force to overwrite — this INVALIDATES every`);
    console.error("license ever signed with the old key. You almost never want that.");
    process.exit(1);
  }
  if (
    local.exists &&
    !(await confirmLocalUpdate(
      "Generate a signing key and update LICENSE_SIGNING_KEY_FILE in " +
        environmentOptions.file +
        "?",
      flag("yes") === true,
    ))
  )
    return;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privatePem, {
    encoding: "utf8",
    mode: 0o600,
    flag: flag("force") === true ? "w" : "wx",
  });
  await saveLocalEnv({ LICENSE_SIGNING_KEY_FILE: keyPath }, environmentOptions.file);
  console.log(`Private key written to ${keyPath} — keep it with the license service only.`);
  console.log("  Deploy it as LICENSE_SIGNING_KEY_FILE (or inline as LICENSE_SIGNING_KEY).\n");
  console.log(
    "Embed this PUBLIC key in your dependent app's trusted key set (not in this server's environment):\n",
  );
  console.log(JSON.stringify(publicPem));
  // The same value `keycheck` and the console's Settings page report later, so
  // this line is comparable against them without re-deriving anything.
  const digest = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  console.log(`\nFingerprint: ${digest.slice(0, 16).match(/.{2}/g).join(":")}`);
  console.log("Check it any time with: vp run license keycheck");
}

/**
 * The compiled keypair module.
 *
 * `keygen` deliberately stays dependency-free — generating a key must work on a
 * fresh clone before anything is built. `keycheck` needs the same validation
 * the server runs, and duplicating that here would let the two drift, which is
 * precisely the failure this command exists to detect.
 */
async function keypair() {
  try {
    return await import("../dist/src/keypair.js");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      console.error("Build the server first: vp run build");
      process.exit(1);
    }
    throw error;
  }
}

/** --expect takes a PEM directly or a path to one; a path is the common case. */
function readPublicKeyArgument(value) {
  const text = String(value);
  if (text.includes("-----BEGIN")) return text.replaceAll("\\n", "\n");
  try {
    return readFileSync(text, "utf8");
  } catch {
    console.error(`--expect is neither a PEM nor a readable file: ${text}`);
    process.exit(1);
  }
}

async function keycheck() {
  const { describeSigningKey, resolveSigningKey, fingerprintPublicKey, verifyLicenseToken } =
    await keypair();

  let info;
  try {
    info = describeSigningKey(resolveSigningKey(environment));
  } catch (error) {
    // The whole point of this command: say what is wrong in a sentence.
    console.error(`Signing key unusable: ${error.message}`);
    process.exit(1);
  }

  console.log(`Algorithm    ${info.keyType}`);
  console.log(`Fingerprint  ${info.fingerprint}`);
  console.log(`\n${info.publicKeyPem.trim()}\n`);

  // Each check below is independent, so one failure does not hide another.
  let failed = false;

  const expect = flag("expect");
  if (typeof expect === "string") {
    const expected = fingerprintPublicKey(readPublicKeyArgument(expect));
    if (expected === info.fingerprint) {
      console.log("--expect     matches this key.");
    } else {
      console.error("--expect     MISMATCH");
      console.error(`  this service signs with  ${info.fingerprint}`);
      console.error(`  your app expects         ${expected}`);
      console.error("  Tokens from this server will fail verification in your app.");
      failed = true;
    }
  }

  const token = flag("token");
  if (typeof token === "string") {
    const result = verifyLicenseToken(token, info.publicKeyPem);
    if (result.valid) {
      console.log("--token      verifies against this key.");
    } else {
      console.error(`--token      REJECTED: ${result.reason}`);
      failed = true;
    }
  }

  if (flag("server") !== undefined) {
    const config = await admin("/admin/products");
    const product = config.products.find((p) => p.id === (flag("product") || "default"));
    const active = product?.keys.find((k) => !k.retiredAt && !k.pending);
    const deployed = active ? fingerprintPublicKey(active.publicKeyPem) : undefined;
    if (!deployed) {
      console.error("--server     that service did not report a signing key (older version?).");
      failed = true;
    } else if (deployed === info.fingerprint) {
      const kid = active.kid ? ` (kid ${active.kid})` : "";
      console.log(`--server     ${env("LICENSE_SERVER_URL")} signs with this same key${kid}.`);
    } else {
      console.error("--server     MISMATCH");
      console.error(`  local key      ${info.fingerprint}`);
      console.error(`  deployed key   ${deployed}`);
      failed = true;
    }
  }

  if (failed) process.exit(1);
}

function inspect(input) {
  if (!input) {
    console.error("Pass a license token (or its payload half) to inspect.");
    process.exit(1);
  }
  const body = input.split(".")[0];
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    console.log(JSON.stringify(payload, null, 2));
    console.log("\n(decoded only — the app verifies the signature, this tool does not)");
  } catch {
    console.error("That does not decode as a license token.");
    process.exit(1);
  }
}

switch (command) {
  case "imports-enable": {
    const pid = encodeURIComponent(flag("product") || "default");
    await admin(`/admin/products/${pid}/import-policy`, {
      method: "PUT",
      body: JSON.stringify({
        entitlement: flag("entitlement", "imports"),
        revision: Number(flag("revision")),
      }),
    });
    console.log(
      "Import licensing enabled for future issuance. Existing licenses require explicit adoption.",
    );
    break;
  }
  case "imports-account": {
    console.log(
      JSON.stringify(
        await admin(`/admin/licenses/${encodeURIComponent(rest[0])}/import-account`),
        null,
        2,
      ),
    );
    break;
  }
  case "imports-adopt": {
    const requestId = flag("request-id") || randomUUID();
    console.log("Operation ID (reuse unchanged on retry): " + requestId);
    await admin(`/admin/licenses/${encodeURIComponent(rest[0])}/import-account`, {
      method: "POST",
      body: JSON.stringify({
        requestId,
        revision: Number(flag("revision")),
        granted: Number(flag("granted")),
        reason: flag("reason"),
      }),
    });
    console.log(
      "Legacy license adopted. The client must migrate verified surviving usage before using v5 grants.",
    );
    break;
  }
  case "renew": {
    const requestId = flag("request-id") || randomUUID();
    console.log("Purchase ID (reuse unchanged on retry): " + requestId);
    const body = {
      requestId,
      plan: flag("plan", "standard"),
      mode: flag("mode", "renewal"),
      ...(flag("paid")
        ? {
            payment: {
              date: new Date().toISOString().slice(0, 10),
              method: flag("method", ""),
              reference: flag("reference", ""),
            },
          }
        : {}),
    };
    const result = await admin(`/admin/licenses/${encodeURIComponent(rest[0])}/renew`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    console.log(
      `License ${result.licenseId}: ${result.account.granted} cumulative paid imports granted; sale ${result.sale.id} ${result.sale.status}.`,
    );
    break;
  }
  case "replace-key": {
    const requestId = flag("request-id") || randomUUID();
    console.log("Replacement ID (reuse unchanged on retry): " + requestId);
    const result = await admin(`/admin/licenses/${encodeURIComponent(rest[0])}/replace-key`, {
      method: "POST",
      body: JSON.stringify({ requestId, reason: flag("reason") }),
    });
    console.log("Replacement product key (keep private): " + result.key);
    break;
  }
  case "recovery-list": {
    const pid = encodeURIComponent(flag("product") || "default");
    console.log(JSON.stringify(await admin(`/admin/products/${pid}/recovery-requests`), null, 2));
    break;
  }
  case "recovery-approve": {
    const pid = encodeURIComponent(flag("product") || "default"),
      requestId = flag("request-id") || randomUUID();
    console.log("Approval ID (reuse unchanged on retry): " + requestId);
    await admin(`/admin/products/${pid}/recovery-requests/${encodeURIComponent(rest[0])}/approve`, {
      method: "POST",
      body: JSON.stringify({
        requestId,
        revision: Number(flag("revision")),
        mode: flag("mode"),
        reason: flag("reason"),
      }),
    });
    console.log(
      "Recovery approved for 24 hours. Customer must claim with the original installation credential and persisted challenge.",
    );
    break;
  }
  case "recovery-reject": {
    const pid = encodeURIComponent(flag("product") || "default"),
      requestId = flag("request-id") || randomUUID();
    console.log("Rejection ID (reuse unchanged on retry): " + requestId);
    await admin(`/admin/products/${pid}/recovery-requests/${encodeURIComponent(rest[0])}/reject`, {
      method: "POST",
      body: JSON.stringify({
        requestId,
        revision: Number(flag("revision")),
        reason: flag("reason"),
      }),
    });
    console.log("Recovery rejected. The request can no longer transfer this account.");
    break;
  }
  case "keygen":
    await keygen();
    break;
  case "keycheck":
    await keycheck();
    break;
  case "inspect":
    inspect(rest.find((argument) => !argument.startsWith("--")));
    break;
  case "issue": {
    for (const name of ["expires", "activations", "allowance", "entitlements"])
      if (flag(name) !== undefined)
        throw Error("Edit the plan first; issuance does not accept --" + name + ".");
    const requestId = flag("request-id") || randomUUID();
    console.log("Issuance request ID (reuse if retrying): " + requestId);
    const body = {
      requestId,
      plan: flag("plan", "standard"),
      issuedTo: flag("to", ""),
      subjectKind: flag("subject", "installation"),
      ...(flag("installation") ? { installationId: flag("installation") } : {}),
      ...(flag("paid")
        ? {
            payment: {
              date: new Date().toISOString().slice(0, 10),
              method: flag("method", ""),
              reference: flag("reference", ""),
            },
          }
        : {}),
    };
    const result = await admin("/admin/licenses", { method: "POST", body: JSON.stringify(body) });
    const entitlements = Object.entries(result.license.entitlements ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join(", ");
    console.log(
      `License ${result.license.id} (${result.license.plan}${entitlements ? `; ${entitlements}` : ""})`,
    );
    console.log(`Issued to: ${result.license.issuedTo || "(unnamed)"}`);
    console.log(
      "\nProduct key — keep it private; admins can recover it with configured encryption:\n",
    );
    console.log(`  ${result.key}`);
    break;
  }
  case "list": {
    const { licenses } = await admin("/admin/licenses");
    for (const license of licenses) {
      const entitlements = Object.entries(license.entitlements ?? {})
        .map(([name, value]) => `${name}=${value}`)
        .join(",");
      console.log(
        `${license.id}  ${license.status.padEnd(7)}  ${license.plan}  ${license.issuedTo}  ${entitlements}`,
      );
    }
    if (licenses.length === 0) console.log("(no licenses issued yet)");
    break;
  }
  case "revoke": {
    const id = rest.find((argument) => !argument.startsWith("--"));
    await admin(`/admin/licenses/${id}/revoke`, { method: "POST" });
    console.log(`Revoked ${id}.`);
    console.log("Installations learn of it on refresh; offline grants expire at their deadlines.");
    break;
  }
  case "activations": {
    const id = rest.find((argument) => !argument.startsWith("--"));
    const { activations } = await admin(`/admin/licenses/${id}/activations`);
    for (const activation of activations) {
      const state = activation.deactivatedAt ? `released ${activation.deactivatedAt}` : "active";
      console.log(`${activation.installationId}  ${activation.activatedAt}  ${state}`);
    }
    if (activations.length === 0) console.log("(never activated)");
    break;
  }
  case "deactivate": {
    const id = rest.find((argument) => !argument.startsWith("--"));
    const installationId = flag("installation");
    if (!id || typeof installationId !== "string") {
      console.error("Usage: license deactivate <licenseId> --installation <installationId>");
      process.exit(1);
    }
    await admin(`/admin/licenses/${id}/deactivate`, {
      method: "POST",
      body: JSON.stringify({ installationId }),
    });
    console.log(
      "Binding released. Import-account ownership remains; transfer requires approved recovery.",
    );
    break;
  }
  case "machines": {
    const query = flag("q");
    const limit = flag("limit");
    const search = new URLSearchParams();
    if (typeof query === "string") search.set("q", query);
    if (limit !== undefined) search.set("limit", String(Number(limit)));
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const { machines, total } = await admin(`/admin/machines${suffix}`);
    for (const machine of machines) {
      // The reference first: it is the only column a customer can read out, so
      // it is the one an operator is scanning for.
      console.log(
        `${machine.supportReference}  ${machine.id}  ${machine.trialState.padEnd(5)}  ` +
          `regs=${machine.registrationCount}  ${machine.signalKinds.join(",") || "(no signals)"}`,
      );
      console.log(
        `    installations: ${machine.installationIds.join(", ") || "(none)"}` +
          `${machine.clearedAt ? `  cleared ${machine.clearedAt}` : ""}` +
          `${machine.trialSpentReported ? "  client-reported spent" : ""}`,
      );
    }
    if (machines.length === 0) {
      console.log(query ? "(nothing matches that search)" : "(no machines registered yet)");
    } else if (machines.length < total) {
      console.log(`\n${machines.length} of ${total} — narrow with --q, or raise --limit.`);
    }
    break;
  }
  case "clear": {
    const id = rest.find((argument) => !argument.startsWith("--"));
    if (!id) {
      console.error("Usage: license clear <machineId>   (find one with: license machines --q …)");
      process.exit(1);
    }
    const { machine } = await admin(`/admin/machines/${id}/clear`, { method: "POST" });
    console.log(`Cleared ${machine.id} at ${machine.clearedAt}.`);
    console.log("That machine gets ONE more trial: the next run is fresh, the one after is not.");
    break;
  }
  default:
    usage();
    if (command) process.exit(1);
}
