import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

// @ts-expect-error Maintainer tooling is plain ESM, consumed directly by Node.
import { deployProduction, deployPreview } from "../scripts/deploy-production.mjs";
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
  assert.equal(workflow.jobs.publish.environment.name, "npm");
  assert.equal(workflow.jobs.publish.environment.deployment, false);
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
function deploymentFixture(production = true) {
  const branch = production ? "main" : "dev";
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "zdevzone/keyforge",
    GITHUB_REF: "refs/heads/" + branch,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: sha,
    GITHUB_TOKEN: "github-test",
    VERCEL_TOKEN: "vercel-test",
    VERCEL_PROJECT_ID: "prj_test",
    VERCEL_TEAM_ID: "team_test",
    VERCEL_AUTOMATION_BYPASS_SECRET: "test-preview-access",
    VERCEL_PRODUCTION_URL: "https://production.example.test",
    VERCEL_PREVIEW_URL: "https://dev.example.test",
  };
  const replies = new Map<string, unknown>([
    ["/git/ref/heads/" + branch, { object: { sha } }],
    [
      `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
      {
        workflow_runs: [
          { id: 42, event: "push", head_branch: branch, head_sha: sha, conclusion: "success" },
        ],
      },
    ],
    [
      "/actions/runs/42/jobs?per_page=100",
      { jobs: [{ name: "CI passed", conclusion: "success" }] },
    ],
    [`/git/commits/${sha}`, { tree: { sha: tree } }],
    [`/git/commits/${stagedSha}`, { tree: { sha: tree } }],
    [
      "/v9/projects/prj_test",
      {
        id: "prj_test",
        name: "keyforge",
        link: {
          type: "github",
          org: "zdevzone",
          repo: "keyforge",
          repoId: 123,
          productionBranch: "main",
        },
      },
    ],
    [
      "/v9/projects/prj_test/domains",
      {
        domains: [
          { name: "production.example.test", verified: true },
          { name: "dev.example.test", gitBranch: "dev", verified: true },
        ],
      },
    ],
    [
      "/v6/deployments?projectId=prj_test&state=READY&limit=100",
      {
        deployments: [
          {
            id: "dpl_preview",
            projectId: "prj_test",
            url: "preview-check.vercel.app",
            meta: { githubCommitRef: "dev", githubCommitSha: stagedSha },
          },
        ],
      },
    ],
    ["/v13/deployments", { id: "dpl_test" }],
    ["/deployments", { id: 77 }],
    ["/deployments/77/statuses", {}],
    [
      "/v13/deployments/dpl_test",
      {
        id: "dpl_test",
        projectId: "prj_test",
        url: "release-check.vercel.app",
        target: production ? "production" : null,
        readyState: "READY",
        meta: { githubCommitSha: sha, githubCommitRef: branch },
      },
    ],
    ["/v10/projects/prj_test/promote/dpl_test", {}],
    ["/v4/aliases/production.example.test", { projectId: "prj_test", deploymentId: "dpl_test" }],
    ["/v4/aliases/dev.example.test", { projectId: "prj_test", deploymentId: "dpl_test" }],
    ...[
      "https://preview-check.vercel.app",
      "https://release-check.vercel.app",
      env.VERCEL_PRODUCTION_URL,
      env.VERCEL_PREVIEW_URL,
    ].map((url) => [url + "/healthz", { ok: true }] as [string, unknown]),
  ]);
  const posts: { path: string; body: unknown }[] = [];
  const request = async (url: string | URL, options: RequestInit = {}) => {
    const parsed = new URL(url);
    parsed.searchParams.delete("teamId");
    const path = parsed
      .toString()
      .replace("https://api.github.com/repos/zdevzone/keyforge", "")
      .replace("https://api.vercel.com", "");
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
    {
      path: "/v13/deployments",
      body: {
        name: "keyforge",
        project: "prj_test",
        target: "production",
        autoAssignCustomDomains: false,
        gitSource: { type: "github", repoId: 123, ref: "main", sha },
        meta: { keyforgeWorkflow: "github-actions", keyforgeCommit: sha },
      },
    },
    { path: "/v10/projects/prj_test/promote/dpl_test", body: {} },
  ]);
});

test("production fails closed before deployment for wrong branch, missing CI, project, staging or domain mismatch", async () => {
  for (const variant of [
    "branch",
    "credentials",
    "event",
    "ci",
    "gate",
    "tree",
    "staging",
    "domain",
    "repo",
  ]) {
    const f = deploymentFixture();
    if (variant === "branch") f.env.GITHUB_REF = "refs/heads/dev";
    if (variant === "credentials") f.env.VERCEL_TOKEN = "";
    if (variant === "event") f.env.GITHUB_EVENT_NAME = "workflow_run";
    if (variant === "ci")
      f.replies.set(`/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`, {
        workflow_runs: [],
      });
    if (variant === "gate") f.replies.set("/actions/runs/42/jobs?per_page=100", { jobs: [] });
    if (variant === "tree")
      f.replies.set(`/git/commits/${stagedSha}`, { tree: { sha: "d".repeat(40) } });
    if (variant === "staging")
      f.replies.set("/v6/deployments?projectId=prj_test&state=READY&limit=100", {
        deployments: [],
      });
    if (variant === "domain") f.replies.set("/v9/projects/prj_test/domains", { domains: [] });
    if (variant === "repo")
      f.replies.set("/v9/projects/prj_test", {
        id: "prj_test",
        link: { type: "github", org: "other", repo: "repo" },
      });
    await assert.rejects(deployProduction(f.env, f), Error, variant);
    assert.equal(f.posts.length, 0, variant);
  }
});

test("failed health, wrong source or Vercel failure never promotes or creates a duplicate deployment", async () => {
  for (const variant of ["health", "failed", "sha", "project"]) {
    const f = deploymentFixture();
    const ready = f.replies.get("/v13/deployments/dpl_test") as Record<string, unknown>;
    if (variant === "health")
      f.replies.set("https://release-check.vercel.app/healthz", { ok: false });
    else
      f.replies.set("/v13/deployments/dpl_test", {
        ...ready,
        ...(variant === "failed"
          ? { readyState: "ERROR" }
          : variant === "sha"
            ? { meta: { githubCommitSha: stagedSha } }
            : { projectId: "prj_other" }),
      });
    await assert.rejects(deployProduction(f.env, f));
    assert.equal(f.posts.length, 1);
  }
});

test("preview deploys only dev with preview settings and never promotes production", async () => {
  const f = deploymentFixture(false);
  await deployPreview(f.env, f);
  assert.equal(f.posts.length, 3);
  assert.equal((f.posts[1].body as Record<string, unknown>).ref, sha);
  assert.equal(
    (f.posts[2].body as Record<string, unknown>).environment_url,
    f.env.VERCEL_PREVIEW_URL,
  );
  const body = f.posts[0].body as Record<string, any>;
  assert.equal(body.target, undefined);
  assert.equal(body.gitSource.ref, "dev");
  assert.equal(body.gitSource.sha, sha);
  const wrong = deploymentFixture(false);
  wrong.env.GITHUB_REF = "refs/heads/feature";
  await assert.rejects(deployPreview(wrong.env, wrong));
  assert.equal(wrong.posts.length, 0);
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
      assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch", "workflow_run"]);
      assert.equal(workflow.jobs.production.environment.name, "production");
      assert.equal(workflow.jobs.production.environment.url, "${{ vars.VERCEL_PRODUCTION_URL }}");
      assert.equal(workflow.jobs.preview.environment.name, "preview");
      assert.equal(workflow.jobs.preview.environment.deployment, false);
      assert.equal(workflow.jobs.preview.permissions.deployments, "write");
      assert.equal(workflow.jobs.production.permissions.deployments, undefined);
      assert.equal(workflow.jobs.preview.environment.url, "${{ vars.VERCEL_PREVIEW_URL }}");
      assert.match(workflow.jobs.production.if, /workflow_dispatch/);
      assert.match(workflow.jobs.production.if, /refs\/heads\/main/);
      assert.match(workflow.jobs.preview.if, /workflow_run.event == 'push'/);
      assert.match(workflow.jobs.preview.if, /head_repository.full_name == 'zdevzone\/keyforge'/);
      assert.match(workflow.jobs.preview.if, /head_branch == 'dev'/);
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

test("a healthy old domain cannot make a new release pass before alias assignment", async () => {
  for (const production of [true, false]) {
    const f = deploymentFixture(production);
    f.replies.set("/v4/aliases/" + (production ? "production" : "dev") + ".example.test", {
      projectId: "prj_test",
      deploymentId: "dpl_old",
    });
    await assert.rejects(
      (production ? deployProduction : deployPreview)(f.env, f),
      /Domain has not switched/,
    );
    assert.equal(f.posts.filter((item) => item.path === "/v13/deployments").length, 1);
  }
});

test("automatic Preview records dev's deployed SHA rather than workflow_run's main context", async () => {
  const f = deploymentFixture(false);
  await deployPreview(
    {
      ...f.env,
      GITHUB_EVENT_NAME: "workflow_run",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: stagedSha,
      DEPLOY_SHA: sha,
    },
    f,
  );
  assert.equal((f.posts[1].body as Record<string, unknown>).ref, sha);
});
