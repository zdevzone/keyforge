import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

// @ts-expect-error Maintainer tooling is plain ESM, consumed directly by Node.
import { deployProduction } from "../scripts/deploy-production.mjs";
// @ts-expect-error Release tooling is plain ESM, consumed directly by Node.
import * as releases from "../scripts/release-packages.mjs";

const { assertReleaseContext, publishArchives, releasePackages } = releases;

const root = fileURLToPath(new URL("..", import.meta.url));
async function fixture(options: { channel?: string; betaId?: string } = {}) {
  await mkdir(join(root, ".artifacts"), { recursive: true });
  const directory = await mkdtemp(join(root, ".artifacts/release-test-"));
  const packages = new Map<
    string,
    {
      name: string;
      version: string;
      repository: { url: string };
      exports?: Record<string, Record<string, string>>;
      bin?: Record<string, string>;
      keyforgeRelease?: { channel: string; sourceSha: string };
      keyforgeSdkVersion?: string;
    }
  >();
  const integrities = new Map<string, string>();
  const archives = new Map<string, string>();
  const published = new Set<string>();
  const calls: string[] = [];
  for (const [folder, name] of releasePackages as string[][]) {
    const pkg = JSON.parse(await readFile(join(root, "packages", folder, "package.json"), "utf8"));
    pkg.version = releases.releaseVersion(pkg.version, options);
    const filename = name.replace(/^@/, "").replaceAll("/", "-") + "-" + pkg.version + ".tgz";
    const bytes = Buffer.from(name + pkg.version);
    await writeFile(join(directory, filename), bytes);
    packages.set(name, pkg);
    archives.set(filename, name);
    integrities.set(name, "sha512-" + createHash("sha512").update(bytes).digest("base64"));
  }
  const execute = async (command: string, args: string[]) => {
    if (command === "tar") {
      const pkg = packages.get(archives.get(basename(args[1]))!)!;
      return {
        stdout:
          args[0] === "-xOf"
            ? JSON.stringify(pkg)
            : [
                "package/package.json",
                ...Object.values(pkg.exports ?? {})
                  .flatMap((entry) => Object.values(entry))
                  .map((path) => "package/" + path.slice(2)),
                ...Object.values(pkg.bin ?? {}).map(
                  (path) => "package/" + path.replace(/^\.\//, ""),
                ),
              ].join("\n"),
      };
    }
    assert.equal(command, "npm");
    assert.equal(args[0], "publish");
    assert.ok(args.includes("--provenance"));
    const name = archives.get(basename(args[1]))!;
    calls.push(name);
    published.add(name);
    return { stdout: "" };
  };
  const request = async (url: string) => {
    const name = decodeURIComponent(new URL(url).pathname.slice(1).split("/")[0]);
    return published.has(name)
      ? new Response(
          JSON.stringify({
            name,
            version: packages.get(name)!.version,
            dist: { integrity: integrities.get(name) },
          }),
        )
      : new Response("not found", { status: 404 });
  };
  return {
    directory,
    packages,
    integrities,
    published,
    calls,
    execute,
    request,
    wait: async () => {},
  };
}

test("release publishes SDK before both CLIs and resumes only identical published archives", async () => {
  const f = await fixture();
  await publishArchives(f.directory, f);
  assert.deepEqual(f.calls, [
    "@zdevzone/keyforge-client",
    "create-keyforge",
    "create-keyforge-client",
  ]);
  f.calls.length = 0;
  f.published.delete("create-keyforge-client");
  await publishArchives(f.directory, f);
  assert.deepEqual(f.calls, ["create-keyforge-client"]);
});

test("version conflicts and registry failures abort before publishing any package", async () => {
  const f = await fixture();
  f.published.add("create-keyforge-client");
  f.integrities.set("create-keyforge-client", "sha512-different");
  await assert.rejects(publishArchives(f.directory, f), /different contents/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    publishArchives(f.directory, {
      ...f,
      request: async () => new Response("unavailable", { status: 503 }),
    }),
    /HTTP 503/,
  );
  assert.deepEqual(f.calls, []);
});

test("failed SDK publishing or visibility prevents either CLI from publishing", async () => {
  const f = await fixture();
  await assert.rejects(
    publishArchives(f.directory, {
      ...f,
      execute: async (command: string, args: string[]) => {
        if (command === "npm") throw new Error("publish denied");
        return f.execute(command, args);
      },
    }),
    /publish denied/,
  );
  assert.deepEqual(f.calls, []);
  await assert.rejects(
    publishArchives(f.directory, {
      ...f,
      request: async () => new Response("not found", { status: 404 }),
    }),
    /not visible/,
  );
  assert.deepEqual(f.calls, ["@zdevzone/keyforge-client"]);
});

test("release refuses incomplete archives before any registry or publish operation", async () => {
  const f = await fixture();
  await assert.rejects(
    publishArchives(f.directory, {
      ...f,
      execute: async (command: string, args: string[]) =>
        args[0] === "-tzf" ? { stdout: "package/package.json\n" } : f.execute(command, args),
    }),
    /Missing export/,
  );
  assert.deepEqual(f.calls, []);
});

test("release workflow is opt-in, checks first, and limits OIDC to the publish job", async () => {
  const workflow = parse(await readFile(join(root, ".github/workflows/release.yml"), "utf8"));
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(workflow.jobs.checks.if, /github.repository == 'zdevzone\/keyforge'/);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.channel.options, ["stable", "beta"]);
  assert.equal(workflow.jobs.publish.needs, "checks");
  assert.match(workflow.jobs.publish.if, /!inputs.dry_run/);
  assert.equal(workflow.jobs.publish.environment, "npm");
  assert.equal(workflow.jobs.publish.permissions["id-token"], "write");
  assert.equal(workflow.jobs.checks.permissions.actions, "read");
  const runSteps = workflow.jobs.checks.steps
    .map((step: { run?: string }) => step.run ?? "")
    .join("\n");
  for (const command of [
    "check",
    "build:all",
    "test",
    "test:packages",
    "test:console",
    "test:issuance",
    "test:docs",
  ])
    assert.ok(runSteps.includes("vp run " + command));
  const context = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "zdevzone/keyforge",
    GITHUB_REF: "refs/heads/main",
  };
  assert.doesNotThrow(() => assertReleaseContext(context));
  for (const changes of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REPOSITORY: "someone/fork" },
    { GITHUB_REF: "refs/heads/other" },
  ])
    assert.throws(() => assertReleaseContext({ ...context, ...changes }));
});

test("beta versions and branches are isolated from stable releases", async () => {
  const options = { channel: "beta", betaId: "123.1" };
  assert.equal(releases.releaseVersion("0.1.1", options), "0.1.1-beta.123.1");
  const beta = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "zdevzone/keyforge",
    GITHUB_REF: "refs/heads/dev",
    RELEASE_CHANNEL: "beta",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };
  assert.deepEqual(releases.releaseOptions(beta), options);
  assert.doesNotThrow(() => assertReleaseContext(beta));
  assert.throws(() => assertReleaseContext({ ...beta, GITHUB_REF: "refs/heads/main" }));
  assert.throws(() => assertReleaseContext({ ...beta, RELEASE_CHANNEL: "stable" }));
  assert.throws(() => releases.releaseOptions({ RELEASE_CHANNEL: "other" }));
  assert.throws(() => releases.releaseOptions({ RELEASE_CHANNEL: "beta" }));
  const f = await fixture(options);
  const tags: string[] = [];
  await publishArchives(f.directory, {
    ...f,
    ...options,
    execute: async (command: string, args: string[]) => {
      if (command === "npm") tags.push(args[args.indexOf("--tag") + 1]);
      return f.execute(command, args);
    },
  });
  assert.deepEqual(tags, ["beta", "beta", "beta"]);
});

test("registry processing can take minutes without republishing", async () => {
  const f = await fixture();
  let misses = 0;
  await publishArchives(f.directory, {
    ...f,
    request: async (url: string) => {
      if (f.calls.length === 1 && misses++ < 30) return new Response("processing", { status: 404 });
      return f.request(url);
    },
  });
  assert.equal(f.calls.length, 3);
  assert.ok(misses > 6);
});

test("rerunning a publish job preserves checked beta versions and rejects unrelated artifacts", () => {
  const packed = { channel: "beta", betaId: "123.1", sourceSha: "a".repeat(40) };
  const current = { ...packed, betaId: "123.2" };
  assert.deepEqual(releases.assertPackedContext(packed, current), packed);
  for (const change of [
    { channel: "stable" },
    { betaId: "124.1" },
    { betaId: "123.3" },
    { sourceSha: "b".repeat(40) },
  ])
    assert.throws(() => releases.assertPackedContext({ ...packed, ...change }, current));
});

test("stable SDK/client archives can be reused across server source updates", async () => {
  const f = await fixture();
  const options = { channel: "stable", sourceSha: "a".repeat(40) };
  const server = f.packages.get("create-keyforge")!;
  server.keyforgeRelease = options;
  const original = await releases.inspectArchives(f.directory, f.execute, options);
  const next = { ...options, sourceSha: "b".repeat(40) };
  await assert.rejects(releases.inspectArchives(f.directory, f.execute, next));
  server.keyforgeRelease = next;
  const updated = await releases.inspectArchives(f.directory, f.execute, next);
  for (const name of ["@zdevzone/keyforge-client", "create-keyforge-client"])
    assert.deepEqual(
      updated.find((item: { name: string }) => item.name === name),
      original.find((item: { name: string }) => item.name === name),
    );
});

// Keep upstream-only deployment checks in the file legacy scaffolders already prune.
const sha = "a".repeat(40);
const stagedSha = "b".repeat(40);
const tree = "c".repeat(40);
function deploymentFixture() {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "zdevzone/keyforge",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: sha,
    GITHUB_TOKEN: "github-test",
    RENDER_API_KEY: "render-test",
    RENDER_STAGING_SERVICE_ID: "srv-stage",
    RENDER_PRODUCTION_SERVICE_ID: "srv-prod",
  };
  const replies = new Map<string, unknown>([
    ["/git/ref/heads/main", { object: { sha } }],
    [
      `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
      { workflow_runs: [{ id: 42, head_branch: "main", head_sha: sha, conclusion: "success" }] },
    ],
    [
      "/actions/runs/42/jobs?per_page=100",
      { jobs: [{ name: "CI passed", conclusion: "success" }] },
    ],
    [`/git/commits/${sha}`, { tree: { sha: tree } }],
    [`/git/commits/${stagedSha}`, { tree: { sha: tree } }],
    ["srv-stage", { branch: "dev", repo: "https://github.com/zdevzone/keyforge" }],
    [
      "srv-prod",
      {
        branch: "main",
        repo: "https://github.com/zdevzone/keyforge",
        autoDeployTrigger: "off",
        serviceDetails: { url: "https://example.onrender.com" },
      },
    ],
    ["srv-stage/deploys?limit=100", [{ deploy: { status: "live", commit: { id: stagedSha } } }]],
    ["srv-prod/deploys", { id: "dep-tested" }],
    ["srv-prod/deploys/dep-tested", { status: "live", commit: { id: sha } }],
    ["/healthz", { ok: true }],
  ]);
  const posts: { path: string; body: unknown }[] = [];
  const request = async (url: string | URL, options: RequestInit = {}) => {
    const path = String(url)
      .replace("https://api.github.com/repos/zdevzone/keyforge", "")
      .replace("https://api.render.com/v1/services/", "")
      .replace("https://example.onrender.com", "");
    if (options.method === "POST") posts.push({ path, body: JSON.parse(String(options.body)) });
    assert.ok(replies.has(path), `Unexpected request ${path}`);
    return Response.json(replies.get(path));
  };
  return { env, replies, posts, request, wait: async () => {} };
}

test("production requires green CI and staged source contents, then pins the deployment commit", async () => {
  const f = deploymentFixture();
  await deployProduction(f.env, f);
  assert.deepEqual(f.posts, [
    { path: "srv-prod/deploys", body: { commitId: sha, clearCache: "do_not_clear" } },
  ]);
});

test("production fails closed before deployment for wrong branch, missing CI, staging mismatch, or auto-deploy", async () => {
  for (const variant of [
    "branch",
    "credentials",
    "same-service",
    "ci",
    "gate",
    "tree",
    "staging",
    "auto",
    "repo",
  ]) {
    const f = deploymentFixture();
    if (variant === "branch") f.env.GITHUB_REF = "refs/heads/dev";
    if (variant === "credentials") f.env.RENDER_API_KEY = "";
    if (variant === "same-service") f.env.RENDER_STAGING_SERVICE_ID = "srv-prod";
    if (variant === "ci")
      f.replies.set(`/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`, {
        workflow_runs: [],
      });
    if (variant === "gate") f.replies.set("/actions/runs/42/jobs?per_page=100", { jobs: [] });
    if (variant === "tree")
      f.replies.set(`/git/commits/${stagedSha}`, { tree: { sha: "d".repeat(40) } });
    if (variant === "staging")
      f.replies.set("srv-stage/deploys?limit=100", [{ deploy: { status: "build_failed" } }]);
    if (variant === "auto")
      f.replies.set("srv-prod", {
        branch: "main",
        repo: "https://github.com/zdevzone/keyforge",
        autoDeployTrigger: "commit",
      });
    if (variant === "repo")
      f.replies.set("srv-stage", { branch: "dev", repo: "https://github.com/other/repo" });
    await assert.rejects(deployProduction(f.env, f), Error, variant);
    assert.equal(f.posts.length, 0, variant);
  }
});

test("failed health or Render deployment never triggers a second deployment", async () => {
  for (const path of ["/healthz", "srv-prod/deploys/dep-tested"]) {
    const f = deploymentFixture();
    f.replies.set(path, path === "/healthz" ? { ok: false } : { status: "build_failed" });
    await assert.rejects(deployProduction(f.env, f));
    assert.equal(f.posts.length, 1);
  }
});

test("workflows pin actions, protect credentials, and gate all existing CI jobs", async () => {
  for (const name of ["ci", "release", "codeql", "deploy-production"]) {
    const workflow = parse(
      await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
    );
    assert.deepEqual(workflow.permissions, { contents: "read" });
    for (const job of Object.values(workflow.jobs) as {
      steps: { uses?: string; with?: Record<string, unknown> }[];
    }[])
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
        if (step.uses?.startsWith("actions/checkout@"))
          assert.equal(step.with?.["persist-credentials"], false);
      }
    assert.ok(!workflow.on.pull_request_target);
    if (name === "ci") {
      assert.deepEqual(workflow.on.push.branches, ["main", "dev"]);
      assert.equal(workflow.jobs.gate.if, "always()");
      assert.deepEqual(
        workflow.jobs.gate.needs.sort(),
        Object.keys(workflow.jobs)
          .filter((key) => key !== "gate")
          .sort(),
      );
    }
    if (name === "deploy-production") {
      assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
      assert.equal(workflow.jobs.deploy.environment, "production");
    }
  }
  const staging = parse(await readFile(new URL("../render.staging.yaml", import.meta.url), "utf8"));
  const production = parse(await readFile(new URL("../render.yaml", import.meta.url), "utf8"));
  assert.equal(staging.services[0].branch, "dev");
  assert.equal(staging.services[0].autoDeployTrigger, "checksPass");
  assert.equal(production.services[0].autoDeployTrigger, "off");
  assert.deepEqual(
    staging.services[0].envVars.find((item: { key: string }) => item.key === "DATABASE_URL"),
    { key: "DATABASE_URL", sync: false },
  );
});
