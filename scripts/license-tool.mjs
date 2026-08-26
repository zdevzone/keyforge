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
 * LICENSE_SIGNING_KEY_FILE (default ./license-signing.key), which is
 * gitignored — move it somewhere safer than a working copy.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [, , command, ...rest] = process.argv;

function env(name) {
  const value = process.env[name];
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

  npm run license -- keygen [--force]
      Generate the Ed25519 signing keypair. Prints the public key to embed in
      server/license.ts; writes LICENSE_SIGNING_KEY_FILE (default
      ./license-signing.key) — KEEP PRIVATE, gitignored.

  npm run license -- keycheck [--expect <pem-or-file>] [--token <token>] [--server]
      Validate the signing key this deployment is configured with and print its
      public half and fingerprint. --expect compares against the public key your
      app embeds; --token verifies a real issued token; --server compares the
      fingerprint the deployed service reports. Exits 1 on any mismatch.

  npm run license -- issue [--plan standard] [--to "Name"] [--activations 1]
                        [--expires 2027-12-31] [--allowance 200000]
                        [--entitlements '{"seats":5,"pro":true}']
      Create a license on the service and print its product key — shown once,
      stored only as a hash. --allowance is sugar for an "allowance"
      entitlement; a plan preset on the server may supply defaults.

  npm run license -- list
  npm run license -- inspect <token-or-payload>
  npm run license -- revoke <licenseId>
  npm run license -- activations <licenseId>
  npm run license -- deactivate <licenseId> --installation <installationId>
      Release a binding so the customer can activate elsewhere (transfer).

  Service connection (all but keygen/inspect; keycheck only with --server):
      LICENSE_SERVER_URL, LICENSE_ADMIN_TOKEN

  Signing key (keygen, keycheck):
      LICENSE_SIGNING_KEY or LICENSE_SIGNING_KEY_FILE
`);
}

async function admin(path, options = {}) {
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

function keygen() {
  // Write where the deployment says the key lives, so `keygen` and the
  // service agree without anyone moving a file by hand.
  const keyPath = env("LICENSE_SIGNING_KEY_FILE") ?? "license-signing.key";
  if (existsSync(keyPath) && flag("force") !== true) {
    console.error(`${keyPath} already exists. Pass --force to overwrite — this INVALIDATES every`);
    console.error("license ever signed with the old key. You almost never want that.");
    process.exit(1);
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, privatePem, "utf8");
  console.log(`Private key written to ${keyPath} — keep it with the license service only.`);
  console.log("  Deploy it as LICENSE_SIGNING_KEY_FILE (or inline as LICENSE_SIGNING_KEY).\n");
  console.log("Paste this as LICENSE_PUBLIC_KEY in server/license.ts:\n");
  console.log(JSON.stringify(publicPem));
  // The same value `keycheck` and the console's Settings page report later, so
  // this line is comparable against them without re-deriving anything.
  const digest = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
  console.log(`\nFingerprint: ${digest.slice(0, 16).match(/.{2}/g).join(":")}`);
  console.log("Check it any time with: npm run license -- keycheck");
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
      console.error("Build the server first: npm run build");
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
    info = describeSigningKey(resolveSigningKey(process.env));
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
    const config = await admin("/admin/config");
    const deployed = config.signingKey?.fingerprint;
    if (!deployed) {
      console.error("--server     that service did not report a signing key (older version?).");
      failed = true;
    } else if (deployed === info.fingerprint) {
      console.log(`--server     ${env("LICENSE_SERVER_URL")} signs with this same key.`);
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
  case "keygen":
    keygen();
    break;
  case "keycheck":
    await keycheck();
    break;
  case "inspect":
    inspect(rest.find((argument) => !argument.startsWith("--")));
    break;
  case "issue": {
    const body = {
      issuedTo: flag("to", ""),
      expiresAt: flag("expires", null),
    };
    const plan = flag("plan");
    if (typeof plan === "string") body.plan = plan;
    const activations = flag("activations");
    if (activations !== undefined) body.activationLimit = Number(activations);
    const allowance = flag("allowance");
    if (allowance !== undefined) body.allowance = Number(allowance);
    const entitlementsFlag = flag("entitlements");
    if (typeof entitlementsFlag === "string") {
      try {
        body.entitlements = JSON.parse(entitlementsFlag);
      } catch {
        console.error("--entitlements must be a JSON object, e.g. '{\"seats\":5}'.");
        process.exit(1);
      }
    }
    const result = await admin("/admin/licenses", { method: "POST", body: JSON.stringify(body) });
    const entitlements = Object.entries(result.license.entitlements ?? {})
      .map(([name, value]) => `${name}=${value}`)
      .join(", ");
    console.log(
      `License ${result.license.id} (${result.license.plan}${entitlements ? `; ${entitlements}` : ""})`,
    );
    console.log(`Issued to: ${result.license.issuedTo || "(unnamed)"}`);
    console.log("\nProduct key — shown once, store it now:\n");
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
    const { license } = await admin(`/admin/licenses/${id}/revoke`, { method: "POST" });
    console.log(`Revoked ${license.id} at ${license.revokedAt}.`);
    console.log("Installations learn of it on their next refresh; imports stop there.");
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
    console.log("Binding released. The key can now activate on another installation.");
    break;
  }
  default:
    usage();
    if (command) process.exit(1);
}
