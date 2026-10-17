import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

// @ts-expect-error Maintainer tooling is plain ESM.
import { deployProduction } from "../scripts/deploy-production.mjs";

const sha = "a".repeat(40);
const stagedSha = "b".repeat(40);
const tree = "c".repeat(40);
function fixture() {
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
  const f = fixture();
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
    const f = fixture();
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
    const f = fixture();
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
