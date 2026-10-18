import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import {
  ADMIN_FEATURES,
  USE_CASES,
  buildConfig,
  buildEnvLocal,
  buildPackageJson,
  parseAuthScope,
  toKeyPrefix,
  toPackageName,
  toProductName,
  type AuthScope,
  buildReadme,
  nextSteps,
  retargetDockerfileContents,
  retargetWorkflow,
} from "../packages/create-keyforge/src/generate.mjs";
import {
  PLATFORMS,
  PLATFORM_PATHS,
  platformFiles,
  platformKeeps,
} from "../packages/create-keyforge/src/platforms.mjs";
import { resolveTemplate, materializeTemplate } from "../packages/create-keyforge/src/template.mjs";
import { runtimeConfig } from "../packages/create-keyforge/src/toolchain.mjs";
import { configSchema, loadConfig } from "../src/config.js";
import {
  ADMIN_FEATURES as SERVER_ADMIN_FEATURES,
  resolveAdminFeatures,
} from "../src/permissions.js";

/**
 * The scaffolder writes the config a stranger's server boots on, so the
 * contract worth testing is not "the CLI ran" but "what it wrote is something
 * this server accepts". Every assertion below therefore runs the generated
 * output through the service's own schema, not a copy of it.
 */

const run = promisify(execFile);
test("the documented startup policy example loads independently of a live configuration", () => {
  const path = fileURLToPath(
    new URL("../docs/examples/keyforge.config.example.json", import.meta.url),
  );
  const example = loadConfig(path);
  assert.equal(example.branding.name, "Acme Licensing");
  assert.equal(example.key.prefix, "ACME");
  assert.ok(example.licenses.planPresets.standard);
  assert.deepEqual(example.signingKeys.retired, []);
});

test("local templates exclude environment variants and Vercel project credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kf-template-privacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    target = join(root, "target");
  await mkdir(join(source, ".vercel"), { recursive: true });
  await writeFile(join(source, ".env.vercel-staging.local"), "PRIVATE_TEST_SENTINEL");
  await writeFile(join(source, ".env.example"), "# Public example");
  await writeFile(join(source, ".vercel", "project.json"), "PRIVATE_TEST_SENTINEL");
  await materializeTemplate({ kind: "directory", path: source, label: source }, target);
  assert.equal(existsSync(join(target, ".env.vercel-staging.local")), false);
  assert.equal(existsSync(join(target, ".vercel")), false);
  assert.equal(existsSync(join(target, ".env.example")), true);
});
async function matchingFiles(pattern: string, directories: string[]): Promise<string[]> {
  const regex = new RegExp(pattern);
  const result: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && regex.test(await readFile(path, "utf8"))) result.push(path);
    }
  }
  for (const directory of directories) await walk(directory);
  return result.sort();
}

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO, "packages", "create-keyforge", "bin", "create-keyforge.mjs");

const SCOPES: AuthScope[] = ["core", "full", ["operators"], ["operators", "sessions", "bans"]];

test("every generated config is one the server accepts", () => {
  for (const useCase of USE_CASES) {
    for (const authScope of SCOPES) {
      const generated = buildConfig({
        productName: "Acme Photos",
        keyPrefix: "ACME",
        useCase: useCase.id,
        authScope,
      });
      const parsed = configSchema.safeParse(generated);
      assert.ok(
        parsed.success,
        `${useCase.id} + ${JSON.stringify(authScope)} produced an invalid config: ` +
          JSON.stringify(parsed.error?.issues),
      );
      // A default plan the issue form cannot find would be a broken console.
      const config = parsed.data;
      assert.ok(
        config.licenses.defaultPlan in config.licenses.planPresets,
        `${useCase.id}: defaultPlan is missing from planPresets`,
      );
      assert.ok(Object.keys(config.licenses.planPresets).length > 0);
      // And the scope the scaffolder wrote must resolve on the server side.
      assert.doesNotThrow(() => resolveAdminFeatures(config.auth.admin));
    }
  }
});

test("scaffolder and server agree on the admin feature names", () => {
  assert.deepEqual([...ADMIN_FEATURES].sort(), [...SERVER_ADMIN_FEATURES].sort());
});

test("--auth accepts scopes the server understands and rejects the rest", () => {
  assert.equal(parseAuthScope("core"), "core");
  assert.equal(parseAuthScope("full"), "full");
  assert.deepEqual(parseAuthScope("operators, bans"), ["operators", "bans"]);
  assert.deepEqual(parseAuthScope("bans,bans"), ["bans"]);
  assert.throws(() => parseAuthScope("owners"), /Unknown --auth feature/);
  assert.throws(() => parseAuthScope(""), /--auth needs a value/);
});

test("derived names satisfy the schema they end up in", () => {
  const names = ["acme-licensing", "Acme Photos", "my_app", "zdevzone", "x", "…", "2026"];
  for (const name of names) {
    const productName = toProductName(name);
    const config = configSchema.parse(
      buildConfig({
        productName,
        keyPrefix: toKeyPrefix(productName),
        useCase: "count",
        authScope: "core",
      }),
    );
    assert.match(config.key.prefix, /^[A-Z0-9]{1,10}$/);
    assert.ok(config.branding.name.length >= 1 && config.branding.name.length <= 60);
    assert.match(toPackageName(name), /^[a-z0-9._-]+$/);
  }
});

test("generated env carries distinct real secrets, not placeholders", () => {
  const env = buildEnvLocal({
    productName: "Acme",
    database: "sqlite",
    packageManager: "npm" as const,
    adminToken: "a".repeat(43),
    authSecret: "b".repeat(43),
  });
  assert.match(env, /^LICENSE_ADMIN_TOKEN="a{43}"$/m);
  assert.match(env, /^LICENSE_AUTH_SECRET="b{43}"$/m);
  // The signing key is never invented here — keygen has to write it.
  assert.doesNotMatch(env, /^LICENSE_SIGNING_KEY=/m);
  assert.match(env, /^LICENSE_SIGNING_KEY_FILE=/m);
  assert.match(
    buildEnvLocal({
      productName: "Acme",
      database: "postgres",
      packageManager: "npm" as const,
      adminToken: "a",
      authSecret: "b",
    }),
    /^DATABASE_URL=postgres:/m,
  );
});

test("the generated package.json drops upstream's identity, keeps its scripts", async () => {
  const template = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
  const generated = buildPackageJson(template, {
    packageName: "acme-licensing",
    productName: "Acme Photos",
    packageManager: "npm" as const,
    runtime: "node" as const,
  }) as Record<string, unknown>;
  assert.equal(generated.name, "acme-licensing");
  assert.equal(generated.version, "0.1.0");
  assert.equal(generated.private, true);
  for (const field of ["repository", "bugs", "homepage", "author", "keywords"]) {
    assert.ok(!(field in generated), `${field} should not survive into a scaffolded project`);
  }
  assert.match(String((generated.scripts as Record<string, string>)["build:ui"]), /ui/);
  assert.deepEqual(generated.dependencies, template.dependencies);
  // Parsers that only upstream's scaffolder tests use do not travel.
  for (const name of ["yaml", "smol-toml"]) {
    assert.ok(name in template.devDependencies, `${name} should be a template devDependency`);
    assert.ok(
      !(name in (generated.devDependencies as Record<string, string>)),
      `${name} is only used by tests that are not scaffolded`,
    );
  }
});

test("server scaffolds do not build a pruned SDK workspace with any supported manager", async () => {
  const template = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
  for (const packageManager of ["vp", "npm", "pnpm", "yarn", "bun"] as const) {
    const pkg = buildPackageJson(template, {
      packageName: "acme",
      productName: "Acme",
      packageManager,
      runtime: "node",
    });
    for (const task of ["build", "typecheck"])
      assert.doesNotMatch(
        String((pkg.scripts as Record<string, string>)[task]),
        /packages\/keyforge-client/,
      );
  }
  assert.match(template.scripts.build, /packages\/keyforge-client/); // leave upstream untouched
});

/**
 * End to end against this very repository as the template: the same code path
 * a deployer takes, minus the download. Everything it writes has to satisfy
 * the server that will read it.
 */
test("scaffolds a working project from a local template", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "keyforge-scaffold-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "acme-licensing");

  await run("node", [
    CLI,
    directory,
    "--template",
    REPO,
    "--db",
    "postgres",
    "--auth",
    "operators,sessions,bans",
    "--use-case",
    "time",
    "--no-git",
    "--yes",
  ]);

  // The service's own loader reads it, so an unparseable file fails here.
  const config = loadConfig(join(directory, "keyforge.config.json"));
  assert.equal(config.branding.name, "Acme Licensing");
  assert.equal(config.key.prefix, "ACME");
  assert.deepEqual(config.auth.admin, ["operators", "sessions", "bans"]);
  assert.equal(config.licenses.defaultPlan, "monthly");

  const env = await readFile(join(directory, ".env.local"), "utf8");
  const adminToken = env.match(/^LICENSE_ADMIN_TOKEN="(.+)"$/m)?.[1] ?? "";
  const authSecret = env.match(/^LICENSE_AUTH_SECRET="(.+)"$/m)?.[1] ?? "";
  assert.ok(adminToken.length >= 32, "admin token should be long");
  assert.notEqual(adminToken, authSecret, "each secret must be generated separately");
  assert.match(env, /^DATABASE_URL=postgres:/m);

  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert.equal(pkg.name, "acme-licensing");
  assert.equal(pkg.private, true);

  // Upstream's files that belong to upstream.
  for (const gone of [
    ".git",
    "dist",
    "packages",
    "test/client-sdk.test.ts",
    "test/release-packages.test.ts",
    "scripts/release-packages.mjs",
    ".github/workflows/release.yml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/codeql.yml",
    ".github/CODEOWNERS",
    "scripts/deploy-production.mjs",
    "test/deployment.test.ts",
    "render.staging.yaml",
    "examples/keyforge-node.ts",
    "keyforge.config.example.json",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    ".github/ISSUE_TEMPLATE",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/dependabot.yml",
  ]) {
    assert.equal(existsSync(join(directory, gone)), false, `${gone} should not be scaffolded`);
  }
  // ...and the ones the deployer still needs.
  for (const kept of [
    "src",
    "ui",
    "test",
    "LICENSE",
    "Dockerfile",
    "docs/keyforge.md",
    "docs/examples/keyforge.config.example.json",
  ]) {
    assert.ok(existsSync(join(directory, kept)), `${kept} should be scaffolded`);
  }
  const readme = await readFile(join(directory, "README.md"), "utf8");
  assert.match(readme, /Acme Licensing license service/);
  assert.match(readme, /docs\/keyforge\.md/);

  // Nothing scaffolded may reach into packages/, which is upstream-only: the
  // first `npm test` in a new project has to pass.
  assert.deepEqual(
    await matchingFiles("packages/create-keyforge", [
      join(directory, "test"),
      join(directory, "src"),
    ]),
    [],
    "scaffolded sources must not import packages/",
  );
  for (const upstreamReview of [
    "docs/studio-proof-contract.md",
    "docs/examples/studio-proof-contract",
    "test/integration-contract.test.ts",
  ])
    assert.equal(existsSync(join(directory, upstreamReview)), false, upstreamReview);

  // The generated secrets must be uncommittable by construction.
  await run("git", ["init", "--quiet"], { cwd: directory });
  await assert.rejects(
    run("git", ["check-ignore", "--quiet", ".env.example"], { cwd: directory }),
    ".env.example is meant to be committed",
  );
  await run("git", ["check-ignore", "--quiet", ".env.local"], { cwd: directory });
});

test("refuses to overwrite a directory that already has files", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "keyforge-scaffold-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(parent, "something.txt"), "already here");

  await assert.rejects(
    run("node", [CLI, parent, "--template", REPO, "--yes", "--no-git"]),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? "", /is not empty/);
      return true;
    },
  );
  assert.equal(existsSync(join(parent, "keyforge.config.json")), false);
});

test("rejects unknown flag values before touching the filesystem", async () => {
  for (const args of [
    ["--db", "mysql"],
    ["--use-case", "seats"],
    ["--key-prefix", "acme"],
  ]) {
    await assert.rejects(
      run("node", [CLI, "unused-directory", ...args, "--yes"]),
      (error: Error & { stderr?: string }) => {
        assert.match(error.stderr ?? "", /create-keyforge: /);
        return true;
      },
    );
  }
  assert.equal(existsSync(join(REPO, "unused-directory")), false);
});

/**
 * The path every real user takes: fetch a tarball over the network, unpack it,
 * prune what belongs to upstream. Served from a local socket rather than
 * mocked, so the fetch, the pipe to disk, the `tar` invocation, and
 * --strip-components are all genuinely exercised.
 */
test("downloads, unpacks and prunes a repository tarball", async (t) => {
  const staging = await mkdtemp(join(tmpdir(), "keyforge-tarball-"));
  t.after(() => rm(staging, { recursive: true, force: true }));

  const root = join(staging, "keyforge-main");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "keyforge", version: "1.0.0", scripts: { start: "node ." } }),
  );
  await writeFile(join(root, "README.md"), "# Keyforge\n\nUpstream documentation.\n");
  await writeFile(join(root, "src", "index.ts"), "export {};\n");
  await writeFile(join(root, "dist", "index.js"), "// upstream build output\n");
  await writeFile(join(root, "SECURITY.md"), "Report to upstream.\n");
  await writeFile(join(root, "keyforge.config.example.json"), "{}\n");
  const tarball = join(staging, "keyforge-main.tar.gz");
  await run("tar", ["-czf", tarball, "-C", staging, "keyforge-main"]);

  const server = createServer((request, response) => {
    if (request.url === "/zdevzone/keyforge/tar.gz/main") {
      response.writeHead(200, { "content-type": "application/gzip" });
      createReadStream(tarball).pipe(response);
      return;
    }
    response.writeHead(404).end("Not Found");
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise((closed) => server.close(closed)));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const directory = join(staging, "downloaded");
  await run("node", [CLI, directory, "--yes", "--no-git"], {
    env: { ...process.env, KEYFORGE_TEMPLATE_ORIGIN: origin },
  });

  // The tarball's top-level directory is stripped, not scaffolded.
  assert.equal(existsSync(join(directory, "keyforge-main")), false);
  assert.ok(existsSync(join(directory, "src", "index.ts")));
  assert.equal(existsSync(join(directory, "dist")), false);
  assert.equal(existsSync(join(directory, "SECURITY.md")), false);
  assert.equal(existsSync(join(directory, "keyforge.config.example.json")), false);
  assert.match(await readFile(join(directory, "docs", "keyforge.md"), "utf8"), /Upstream doc/);
  assert.equal(loadConfig(join(directory, "keyforge.config.json")).branding.name, "Downloaded");

  // A ref that does not exist says so, instead of leaving a half-written tree.
  const missing = join(staging, "missing-ref");
  await assert.rejects(
    run("node", [CLI, missing, "--template", "zdevzone/keyforge#nope", "--yes", "--no-git"], {
      env: { ...process.env, KEYFORGE_TEMPLATE_ORIGIN: origin },
    }),
    (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? "", /was not found/);
      return true;
    },
  );
});

test("understands the template shorthands people actually type", async () => {
  for (const source of [
    "zdevzone/keyforge",
    "github:zdevzone/keyforge",
    "https://github.com/zdevzone/keyforge",
    "https://github.com/zdevzone/keyforge.git",
    "git@github.com:zdevzone/keyforge.git",
  ]) {
    const template = await resolveTemplate(source);
    assert.equal(template.kind, "repository");
    assert.deepEqual(
      { owner: template.owner, repo: template.repo, ref: template.ref },
      { owner: "zdevzone", repo: "keyforge", ref: "main" },
    );
  }
  const pinned = await resolveTemplate("zdevzone/keyforge#v2.1.0");
  assert.equal(pinned.kind === "repository" && pinned.ref, "v2.1.0");

  const local = await resolveTemplate(REPO);
  assert.equal(local.kind, "directory");
  await assert.rejects(resolveTemplate("./no/such/directory"), /is not a directory/);
});

/**
 * Deployment manifests. A manifest a host cannot parse is worse than none —
 * the deployer finds out from a failed deploy — so every generated file is put
 * through a real parser here, for both database choices.
 */
test("every deployment manifest parses and belongs to the project", () => {
  for (const database of ["sqlite", "postgres"] as const) {
    for (const platform of PLATFORMS) {
      const answers = {
        platform: platform.id,
        packageManager: "npm" as const,
        runtime: "node" as const,
        packageName: "acme-licensing",
        productName: "Acme Photos",
        database,
      };
      for (const [path, body] of Object.entries(platformFiles(answers))) {
        if (path.endsWith(".yml") || path.endsWith(".yaml")) {
          assert.doesNotThrow(() => parseYaml(body), `${path} (${database}) is not valid YAML`);
        } else if (path.endsWith(".toml")) {
          assert.doesNotThrow(() => parseToml(body), `${path} (${database}) is not valid TOML`);
        } else if (path.endsWith(".json")) {
          assert.doesNotThrow(() => JSON.parse(body), `${path} (${database}) is not valid JSON`);
        }
        // Upstream's identity must not ride along into someone else's deploy.
        assert.doesNotMatch(
          body,
          /license-server-v1|zdevzone/,
          `${path} carries upstream identity`,
        );
        // Railway is the exception: its config names no service — the project
        // and service names live in Railway's own dashboard.
        if (path !== "railway.json") {
          assert.match(body, /acme-licensing/, `${path} should name the scaffolded project`);
        }
        // Secrets are set on the host, never written into a committed file.
        assert.doesNotMatch(body, /LICENSE_SIGNING_KEY\s*[:=]\s*["']?-----BEGIN/);
      }
    }
  }
});

test("render's blueprint tracks the database choice", () => {
  const base = {
    platform: "render" as const,
    packageName: "acme",
    productName: "Acme",
    packageManager: "npm" as const,
    runtime: "node" as const,
  };
  const sqlite = parseYaml(platformFiles({ ...base, database: "sqlite" })["render.yaml"]);
  const postgres = parseYaml(platformFiles({ ...base, database: "postgres" })["render.yaml"]);

  const service = sqlite.services[0];
  assert.equal(service.plan, "free");
  assert.equal(service.healthCheckPath, "/healthz");
  assert.ok(!("databases" in sqlite), "sqlite blueprint should not provision Postgres");
  const keys = (blueprint: any) => blueprint.services[0].envVars.map((v: any) => v.key);
  assert.ok(keys(sqlite).includes("LICENSE_DB_PATH"));

  // Postgres wires the connection string from a provisioned database instead.
  assert.equal(postgres.databases[0].name, "acme-db");
  assert.ok(!keys(postgres).includes("LICENSE_DB_PATH"));
  const url = postgres.services[0].envVars.find((v: any) => v.key === "DATABASE_URL");
  assert.equal(url.fromDatabase.name, "acme-db");
  // Every secret is declared but not valued.
  for (const key of ["LICENSE_SIGNING_KEY", "LICENSE_AUTH_SECRET"]) {
    const entry = postgres.services[0].envVars.find((v: any) => v.key === key);
    assert.equal(entry.sync, false);
    assert.equal(entry.value, undefined);
  }
});

test("fly mounts a volume only when the ledger is a file", () => {
  const base = {
    platform: "fly" as const,
    packageName: "acme-licensing",
    productName: "Acme",
    packageManager: "npm" as const,
    runtime: "node" as const,
  };
  const sqlite = parseToml(platformFiles({ ...base, database: "sqlite" })["fly.toml"]) as any;
  const postgres = parseToml(platformFiles({ ...base, database: "postgres" })["fly.toml"]) as any;

  assert.equal(sqlite.app, "acme-licensing");
  assert.equal(sqlite.http_service.internal_port, 8080);
  assert.equal(sqlite.env.LICENSE_PORT, "8080");
  assert.equal(sqlite.http_service.checks[0].path, "/healthz");
  // A volume, and a db path inside it — otherwise the ledger dies with the machine.
  assert.equal(sqlite.mounts.destination, "/data");
  assert.match(sqlite.env.LICENSE_DB_PATH, /^\/data\//);
  assert.equal(postgres.mounts, undefined, "postgres needs no volume");
});

test("scaffolding writes one platform's files and drops the rest", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "keyforge-deploy-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const scaffold = async (name: string, args: string[]) => {
    const directory = join(parent, name);
    const { stdout } = await run("node", [
      CLI,
      directory,
      "--template",
      REPO,
      "--no-git",
      "--yes",
      ...args,
    ]);
    return { directory, stdout };
  };

  const { directory: render } = await scaffold("render", ["--deploy", "render"]);
  assert.ok(existsSync(join(render, "render.yaml")));
  for (const other of [
    "fly.toml",
    "railway.json",
    ".cpanel.yml",
    "docker-compose.yml",
    "deploy",
    ".agents",
  ]) {
    assert.equal(
      existsSync(join(render, other)),
      false,
      `${other} should not survive --deploy render`,
    );
  }
  // Several hosts build from it, and it is how anyone runs this locally.
  assert.ok(existsSync(join(render, "Dockerfile")), "the Dockerfile survives every target");

  const { directory: local } = await scaffold("local", []);
  for (const path of PLATFORM_PATHS) {
    assert.equal(
      existsSync(join(local, path)),
      false,
      `${path} should not survive the local default`,
    );
  }

  const { directory: koyeb } = await scaffold("koyeb", ["--deploy", "koyeb"]);
  const script = join(koyeb, "deploy", "koyeb.sh");
  assert.ok(existsSync(script));
  if (process.platform !== "win32")
    assert.ok(statSync(script).mode & 0o111, "the deploy script must be executable");

  const { directory: cpanel } = await scaffold("cpanel", [
    "--deploy",
    "cpanel",
    "--cpanel-user",
    "bob",
  ]);
  const yml = await readFile(join(cpanel, ".cpanel.yml"), "utf8");
  assert.match(yml, /CPANEL_USER="bob"/);
  assert.doesNotMatch(yml, /zdevzone/);
  // cPanel is the one target upstream's deployment notes still apply to.
  assert.deepEqual(
    platformKeeps({
      platform: "cpanel",
      packageName: "x",
      productName: "x",
      database: "sqlite",
      packageManager: "npm",
      runtime: "node",
    }),
    [".agents"],
  );
  assert.ok(existsSync(join(cpanel, ".agents")));
});

/**
 * The existing platform test reads `.cpanel.yml` and asserts it carries no
 * upstream name. That was the file that had the bug, but it is one file out of
 * ninety: a community template, a workflow or a config that names Keyforge's
 * repo or mailbox would ship into every scaffolded project and nothing would
 * notice. So sweep the whole tree instead of the file we happen to remember.
 *
 * Upstream's repo URL is deliberate attribution in the generated README and
 * the preserved upstream guide, and the public KeyForge source/download page
 * (and its browser assertion).
 * It must not leak into deployment configuration or contact addresses.
 */
test("upstream's identity does not travel into a scaffolded project", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "keyforge-leak-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = join(parent, "acme");

  await run("node", [CLI, directory, "--template", REPO, "--yes", "--no-git"]);

  const matches = async (pattern: string) => {
    return (await matchingFiles(pattern, [directory]))
      .map((path) => path.slice(directory.length + 1).replaceAll("\\", "/"))
      .sort();
  };

  assert.deepEqual(
    // The published SDK scope is a dependency identity, not deployer metadata.
    await matches("(?<!@)zdevzone"),
    [
      "README.md",
      "docs/getting-started.md",
      "docs/keyforge.md",
      "docs/publishing.md",
      "scripts/console-smoke.mjs",
      "ui/.impeccable/surfaces/welcome.md",
      "ui/src/docs/catalog.ts",
      "ui/src/pages/Welcome.tsx",
    ],
    "upstream attribution belongs only in the README and public documentation/source surfaces",
  );

  // A contact address is never attribution -- it would route a stranger's
  // users, or their vulnerability reports, to upstream's mailbox.
  assert.deepEqual(
    await matches("@zdevzone\\.com"),
    [],
    "upstream's contact addresses must not be scaffolded",
  );
});

test("an ephemeral host plus a file ledger is called out, and only then", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "keyforge-warn-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const warned = await run("node", [
    CLI,
    join(parent, "sqlite"),
    "--template",
    REPO,
    "--deploy",
    "render",
    "--db",
    "sqlite",
    "--no-git",
    "--yes",
  ]);
  assert.match(warned.stdout, /no persistent disk/);

  const quiet = await run("node", [
    CLI,
    join(parent, "postgres"),
    "--template",
    REPO,
    "--deploy",
    "render",
    "--db",
    "postgres",
    "--no-git",
    "--yes",
  ]);
  assert.doesNotMatch(quiet.stdout, /no persistent disk/);
});

/**
 * Compose files are validated by Compose itself where it is installed — YAML
 * that parses can still be a schema Compose rejects, and the deployer finds
 * that out at `docker compose up`. Skipped rather than failed when the CLI is
 * absent; CI has it.
 */
test("the generated compose file is one Compose accepts", async (t) => {
  try {
    await run("docker", ["compose", "version"]);
  } catch {
    t.skip("docker CLI not available");
    return;
  }
  const parent = await mkdtemp(join(tmpdir(), "keyforge-compose-"));
  t.after(() => rm(parent, { recursive: true, force: true }));

  for (const database of ["sqlite", "postgres"] as const) {
    const directory = join(parent, database);
    await mkdir(directory, { recursive: true });
    const answers = {
      platform: "docker" as const,
      packageManager: "npm" as const,
      runtime: "node" as const,
      packageName: "acme-licensing",
      productName: "Acme Photos",
      database,
    };
    await writeFile(
      join(directory, "docker-compose.yml"),
      platformFiles(answers)["docker-compose.yml"],
    );
    await run("docker", ["compose", "config"], {
      cwd: directory,
      // LICENSE_SIGNING_KEY is declared required (:?); supply anything.
      env: { ...process.env, LICENSE_SIGNING_KEY: "test-key" },
    });
  }
});

/**
 * Package manager and runtime — M11.
 *
 * The scaffolder used to hard-code `npm` into the README, the next-steps list
 * and every platform manifest, so a team on pnpm or Bun got a project whose
 * documentation was wrong for them in a dozen places.
 */

const MANAGERS = ["vp", "npm", "pnpm", "yarn", "bun"] as const;

function toolchainAnswers(packageManager: (typeof MANAGERS)[number]) {
  return {
    directory: "/tmp/acme",
    relativeDirectory: "acme",
    packageName: "acme-licensing",
    productName: "Acme",
    keyPrefix: "ACME",
    database: "sqlite" as const,
    useCase: "count" as const,
    authScope: "core" as const,
    platform: "render" as const,
    packageManager,
    runtime: "node" as const,
    installed: false,
  };
}

/**
 * The rule most likely to be broken by copying an npm example.
 *
 * `npm run license issue --plan pro` silently succeeds and issues a license on
 * the default plan, to nobody, with no entitlements — npm swallows the flags,
 * so the fix is `npm run license -- issue …`. pnpm, Yarn and Bun pass flags
 * straight through, and telling their users to write `--` would be teaching a
 * workaround for a bug they do not have.
 */
test("the `--` separator appears for npm and for nobody else", () => {
  for (const manager of MANAGERS) {
    const answers = toolchainAnswers(manager);
    const emitted = [buildReadme(answers), nextSteps(answers).join("\n")].join("\n");
    const separators = emitted.match(/\brun \S+ -- /g) ?? [];
    if (manager === "npm") {
      assert.ok(separators.length > 0, "npm output must use the -- separator");
    } else {
      assert.deepEqual(separators, [], `${manager} does not need npm's -- separator`);
    }
  }
});

test("no scaffolded output tells a non-npm project to run npm", () => {
  for (const manager of MANAGERS) {
    if (manager === "npm") continue;
    const answers = toolchainAnswers(manager);
    const surfaces: [string, string][] = [
      ["README", buildReadme(answers)],
      ["next steps", nextSteps(answers).join("\n")],
      ["render.yaml", platformFiles(answers)["render.yaml"]],
      [".cpanel.yml", platformFiles({ ...answers, platform: "cpanel" })[".cpanel.yml"]],
    ];
    for (const [label, text] of surfaces) {
      // `npm create keyforge` is how the scaffolder itself is invoked and is
      // correct whatever the project then uses, so it is not a leak.
      const leaks = (text.match(/\bnpm (?!create)\S*/g) ?? []).filter(Boolean);
      assert.deepEqual(leaks, [], `${manager}: ${label} still says ${leaks.join(", ")}`);
    }
  }
});

/**
 * The scripts are the subtle one. `build:ui` is `npm --prefix ui run build`,
 * so on a pnpm project it would keep working — npm ships with Node — while
 * quietly installing ui/ with npm and leaving two lockfiles in one repository.
 */
test("template scripts are retargeted, so ui/ is not installed by a second manager", async () => {
  const template = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
  for (const manager of MANAGERS) {
    const scripts = buildPackageJson(template, toolchainAnswers(manager)).scripts as Record<
      string,
      string
    >;
    for (const [name, value] of Object.entries(scripts)) {
      if (manager === "npm") continue;
      assert.doesNotMatch(value, /\bnpm\b/, `${manager}: script ${name} still shells out to npm`);
    }
    // The directory has to survive the rewrite; dropping `--prefix ui` would
    // silently build the server twice and never build the console.
    if (manager !== "npm") assert.match(scripts["build:ui"], /\bui\b/);
  }
});

/**
 * "download" needs npm 11+; npm 10 rejects the field outright and `npm install`
 * exits 1 before any code runs. It has taken this repository's CI down twice,
 * and `vp migrate` writes it by default — so a scaffolder must never hand it
 * to a new project.
 */
test("generated devEngines never uses onFail download", async () => {
  const template = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
  for (const manager of MANAGERS) {
    const pkg = buildPackageJson(template, toolchainAnswers(manager)) as Record<string, never>;
    const engines = pkg.devEngines as unknown as {
      packageManager: { name: string; onFail: string };
      runtime: { onFail: string };
    };
    assert.equal(engines.packageManager.name, manager === "vp" ? "pnpm" : manager);
    assert.equal(engines.packageManager.onFail, "warn");
    assert.equal(engines.runtime.onFail, "warn");
    assert.match(
      String(pkg.packageManager),
      new RegExp(`^${manager === "vp" ? "pnpm" : manager}@\\d`),
    );
  }
});

test("the Dockerfile is retargeted, and refuses rather than shipping a wrong one", async () => {
  const dockerfile = await readFile(join(REPO, "Dockerfile"), "utf8");
  for (const manager of MANAGERS) {
    if (manager === "npm") continue;
    const out = retargetDockerfileContents(dockerfile, { packageManager: manager });
    // No *project* dependency install may use npm. Bootstrapping Bun with
    // `npm install -g` is a deliberate exception: npm is the only manager the
    // node:22 base image has, so it is what fetches the one we want.
    const projectInstalls = (out.match(/^RUN npm .*$/gm) ?? []).filter(
      (line) => !/npm install -g/.test(line),
    );
    assert.deepEqual(projectInstalls, [], `${manager}: an npm install survived`);
    assert.doesNotMatch(out, /package-lock\.json/, `${manager}: still copies npm's lockfile`);
  }
  // A template whose install lines moved must fail the scaffold, not quietly
  // produce an image built by the wrong manager.
  assert.throws(
    () =>
      retargetDockerfileContents(
        dockerfile.replace("# KEYFORGE_TOOLCHAIN_TEMPLATE", "# unknown template"),
        {
          packageManager: "pnpm",
        },
      ),
    /no longer has the toolchain marker/,
  );
});

test("the runtime version is stated once and agrees everywhere", () => {
  const answers = toolchainAnswers("npm");
  const blueprint = parseYaml(platformFiles(answers)["render.yaml"]) as {
    services: { envVars: { key: string; value: unknown }[] }[];
  };
  const nodeVersion = blueprint.services[0].envVars.find((entry) => entry.key === "NODE_VERSION");
  assert.equal(String(nodeVersion?.value), runtimeConfig(answers.runtime).version);
});

test("Render self-host templates retain the Vite+ build while CI verifies Vercel without credentials", async () => {
  const blueprint = parseYaml(await readFile(join(REPO, "render.yaml"), "utf8"));
  const workflow = parseYaml(await readFile(join(REPO, ".github/workflows/ci.yml"), "utf8"));
  const service = blueprint.services[0];
  const build = workflow.jobs.vercel.steps.find(
    (step: { name?: string }) =>
      step.name === "Build with Vercel configuration without deployment credentials",
  );
  assert.match(build.run, /bash scripts\/vercel-install.sh/);
  assert.match(build.run, /vp run build:all/);
  assert.match(build.run, /node --check api\/index.mjs/);
  assert.doesNotMatch(build.run, /secrets\.|VERCEL_TOKEN/);
  assert.equal(build.env.NODE_ENV, "production");
  assert.match(service.buildCommand, /VP_VERSION=1\.1\.0/);
  assert.match(service.buildCommand, /NODE_ENV=development vp install --frozen-lockfile/);
  assert.match(service.buildCommand, /vp run build:all$/);
  assert.doesNotMatch(service.buildCommand, /yarn|npm|\bui install\b/);
  assert.equal(service.startCommand, "node dist/src/index.js");
  const node = service.envVars.find((entry: { key: string }) => entry.key === "NODE_VERSION");
  assert.equal(String(node.value), (await readFile(join(REPO, ".node-version"), "utf8")).trim());
  assert.ok(!service.envVars.some((entry: { key: string }) => entry.key === "LICENSE_PORT"));

  const generated = parseYaml(platformFiles(toolchainAnswers("vp"))["render.yaml"]).services[0];
  assert.equal(
    generated.buildCommand.replace("--no-frozen-lockfile", "--frozen-lockfile"),
    service.buildCommand,
  );
  assert.equal(generated.startCommand, service.startCommand);
});

/**
 * Rewriting `npm ci` to `pnpm install` is not enough on its own, and reading
 * the diff will not tell you: the base image is `node:22`, which ships npm and
 * corepack and nothing else. Without a preparation step the image dies at the
 * first install with `pnpm: not found`, after the rewrite has made every line
 * look correct.
 */
test("the image is given the package manager it is told to use", async () => {
  const dockerfile = await readFile(join(REPO, "Dockerfile"), "utf8");
  for (const manager of MANAGERS) {
    if (manager === "npm") continue;
    const out = retargetDockerfileContents(dockerfile, { packageManager: manager });
    const stages = out.split(/(?=^FROM )/m);
    for (const stage of stages) {
      const installs = /^RUN vp (install|pm)/m.test(stage);
      const prepared = /^RUN (corepack enable|npm install -g)/m.test(stage);
      const name = stage.split("\n")[0].trim();
      if (installs) {
        assert.ok(prepared, `${manager}: "${name}" installs but never gets ${manager}`);
      } else {
        // The runtime stage copies node_modules in; adding a package manager
        // there would only make the shipped image bigger.
        assert.ok(!prepared, `${manager}: "${name}" does not install, so it needs no manager`);
      }
    }
  }
});

/**
 * The leak reading the generated project caught that the tests had not: the CI
 * workflow is copied from the template and names npm in every step, so a pnpm
 * project's first push would install with the wrong manager and ignore its own
 * lockfile. `actions/setup-node` provides npm and corepack, not pnpm.
 */
test("the generated CI workflow uses the project's own package manager", async () => {
  const workflow = await readFile(join(REPO, ".github/workflows/ci.yml"), "utf8");
  const original = parseYaml(workflow);
  assert.match(retargetWorkflow(workflow, "npm"), /setup-vp/);
  for (const manager of MANAGERS)
    assert.doesNotMatch(retargetWorkflow(workflow, manager), /test:packages/);

  for (const manager of MANAGERS) {
    if (manager === "npm") continue;
    const out = retargetWorkflow(workflow, manager);

    // Malformed YAML would be worse than the npm it replaces, and inserting a
    // step next to setup-node's `with:` block is exactly how that happens.
    const parsed = parseYaml(out) as {
      jobs: Record<
        string,
        { steps: { name?: string; uses?: string; run?: string; with?: unknown }[] }
      >;
    };
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      const setup = job.steps.find((step) => String(step.uses ?? "").includes("setup-node"));
      if (!setup) continue;
      assert.deepEqual(
        setup.with,
        original.jobs[jobName].steps.find((step: { uses?: string }) =>
          String(step.uses ?? "").includes("setup-node"),
        ).with,
        `${jobName}: setup-node lost its inputs`,
      );
      const prepared = job.steps.some((step) =>
        /corepack enable|npm install -g/.test(step.run ?? ""),
      );
      assert.ok(prepared, `${jobName}: never puts ${manager} on the runner`);
    }

    const leftovers = (out.match(/run: npm .*/g) ?? []).filter(
      (line) => !/npm install -g/.test(line),
    );
    assert.deepEqual(leftovers, [], `${manager}: CI still runs ${leftovers.join(", ")}`);
  }
});
