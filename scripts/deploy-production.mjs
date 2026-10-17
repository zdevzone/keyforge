import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "zdevzone/keyforge";
const shaPattern = /^[a-f0-9]{40}$/;

export async function deployProduction(
  env,
  { request = fetch, wait = (ms) => new Promise((done) => setTimeout(done, ms)) } = {},
) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Production requires main");
  const sha = env.GITHUB_SHA;
  assert.match(sha ?? "", shaPattern);
  for (const key of [
    "GITHUB_TOKEN",
    "RENDER_API_KEY",
    "RENDER_STAGING_SERVICE_ID",
    "RENDER_PRODUCTION_SERVICE_ID",
  ])
    assert.ok(env[key], `Configure ${key} in the production environment`);
  const staging = env.RENDER_STAGING_SERVICE_ID;
  const production = env.RENDER_PRODUCTION_SERVICE_ID;
  assert.match(staging, /^srv-[a-zA-Z0-9]+$/);
  assert.match(production, /^srv-[a-zA-Z0-9]+$/);
  assert.notEqual(staging, production, "Staging and production must be separate services");
  async function json(origin, path, token, body) {
    const response = await request(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: "Bearer " + token,
        accept: "application/json",
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    // Never log response bodies: provider errors may contain configuration.
    assert.ok(response.ok, `Deployment API request failed: HTTP ${response.status}`);
    return response.json();
  }
  const github = (path) =>
    json(`https://api.github.com/repos/${repository}`, path, env.GITHUB_TOKEN);
  const render = (path, body) =>
    json("https://api.render.com/v1/services/", path, env.RENDER_API_KEY, body);
  const head = await github("/git/ref/heads/main");
  assert.equal(head.object.sha, sha, "main advanced; rerun on its current commit");
  const runs = await github(
    `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  const ci = runs.workflow_runs.find((run) => run.head_branch === "main" && run.head_sha === sha);
  assert.equal(ci?.conclusion, "success", "Wait for successful main CI before deploying");
  const jobs = await github(`/actions/runs/${ci.id}/jobs?per_page=100`);
  assert.ok(
    jobs.jobs.some((job) => job.name === "CI passed" && job.conclusion === "success"),
    "CI gate did not pass",
  );
  const source = await github(`/git/commits/${sha}`);
  const stagingService = await render(staging);
  const productionService = await render(production);
  for (const [service, branch] of [
    [stagingService, "dev"],
    [productionService, "main"],
  ]) {
    assert.equal(service.branch, branch, `Render service must use ${branch}`);
    assert.ok(
      [`https://github.com/${repository}`, `https://github.com/${repository}.git`].includes(
        service.repo,
      ),
      "Render must deploy the public KeyForge repository",
    );
  }
  assert.ok(
    productionService.autoDeployTrigger === "off" ||
      (!productionService.autoDeployTrigger && productionService.autoDeploy === "no"),
    "Disable production auto-deploy in Render first",
  );
  let tested = false;
  let cursor = "";
  for (let page = 0; page < 10 && !tested; page++) {
    const deployments = await render(
      `${staging}/deploys?limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
    );
    assert.ok(Array.isArray(deployments), "Unexpected Render deployment list");
    for (const { deploy } of deployments) {
      if (deploy.status !== "live") continue;
      assert.match(deploy.commit?.id ?? "", shaPattern);
      const staged = await github(`/git/commits/${deploy.commit.id}`);
      if (staged.tree.sha === source.tree.sha) {
        tested = true;
        break;
      }
    }
    if (deployments.length < 100) break;
    const next = deployments.at(-1)?.cursor;
    assert.ok(next && next !== cursor, "Cannot paginate Render deployments safely");
    cursor = next;
  }
  assert.ok(
    tested,
    "No live staging deployment matches this source tree; deploy and test dev first",
  );
  // Recheck main immediately before the only mutation; never deploy a moving branch.
  assert.equal(
    (await github("/git/ref/heads/main")).object.sha,
    sha,
    "main advanced during validation",
  );
  const deployment = await render(`${production}/deploys`, {
    commitId: sha,
    clearCache: "do_not_clear",
  });
  assert.match(deployment.id ?? "", /^dep-[a-zA-Z0-9]+$/);
  console.log(`Deploying approved commit ${sha}; Render deployment ${deployment.id}`);
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await render(`${production}/deploys/${deployment.id}`);
    if (result.status === "live") {
      assert.equal(result.commit?.id, sha, "Render deployed a different commit");
      const url = new URL("/healthz", productionService.serviceDetails.url);
      assert.equal(url.protocol, "https:");
      let healthy = false;
      for (let check = 0; check < 6; check++) {
        try {
          const health = await request(url, {
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
          });
          healthy = health.ok && (await health.json()).ok === true;
        } catch {
          /* A newly live service can take a few seconds to answer. */
        }
        if (healthy) break;
        await wait(5000);
      }
      assert.ok(
        healthy,
        "Deployment is live but health verification failed; inspect Render before retrying",
      );
      console.log("Production deployment and health check passed.");
      return;
    }
    assert.ok(
      !["build_failed", "update_failed", "pre_deploy_failed", "canceled", "deactivated"].includes(
        result.status,
      ),
      `Render deployment ended: ${result.status}`,
    );
    await wait(10_000);
  }
  throw new Error(
    "Timed out waiting for Render; inspect the existing deployment before starting another",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  deployProduction(process.env).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
