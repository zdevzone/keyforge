import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "zdevzone/keyforge";
const shaPattern = /^[a-f0-9]{40}$/;

/** Deploy only protected, CI-tested source. Server secrets stay in Vercel. */
export async function deployVercel(
  env,
  { request = fetch, wait = (ms) => new Promise((done) => setTimeout(done, ms)) } = {},
) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_REPOSITORY, repository);
  const production = env.DEPLOY_ENV === "production";
  assert.ok(production || env.DEPLOY_ENV === "preview", "Choose production or preview");
  const branch = production ? "main" : "dev";
  if (env.GITHUB_EVENT_NAME === "workflow_run") {
    assert.ok(!production, "Production requires manual dispatch");
  } else {
    assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
    assert.equal(env.GITHUB_REF, "refs/heads/" + branch);
  }
  const sha = env.DEPLOY_SHA || env.GITHUB_SHA;
  assert.match(sha ?? "", shaPattern);
  for (const key of [
    "GITHUB_TOKEN",
    "VERCEL_TOKEN",
    "VERCEL_PROJECT_ID",
    "VERCEL_TEAM_ID",
    "VERCEL_AUTOMATION_BYPASS_SECRET",
    "VERCEL_PRODUCTION_URL",
    "VERCEL_PREVIEW_URL",
  ])
    assert.ok(env[key], `Configure ${key} in the deployment environment`);
  assert.match(env.VERCEL_PROJECT_ID, /^prj_[a-zA-Z0-9]+$/);
  assert.match(env.VERCEL_TEAM_ID, /^team_[a-zA-Z0-9]+$/);
  const origin = (value) => {
    const url = new URL(value);
    assert.ok(url.protocol === "https:" && !url.username && !url.password);
    assert.equal(url.href, url.origin + "/", "Configure an HTTPS origin without a path");
    return url.origin;
  };
  const productionURL = origin(env.VERCEL_PRODUCTION_URL);
  const previewURL = origin(env.VERCEL_PREVIEW_URL);
  assert.notEqual(productionURL, previewURL);
  async function json(base, path, token, body, method = body ? "POST" : "GET") {
    const response = await request(base + path, {
      method,
      headers: {
        authorization: "Bearer " + token,
        accept: "application/json",
        ...(body && { "content-type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    // Provider errors can contain configuration; never print response bodies.
    assert.ok(response.ok, `Deployment API request failed: HTTP ${response.status}`);
    return response.json();
  }
  const github = (path) =>
    json(`https://api.github.com/repos/${repository}`, path, env.GITHUB_TOKEN);
  const vercel = (path, body) =>
    json(
      "https://api.vercel.com",
      path + (path.includes("?") ? "&" : "?") + "teamId=" + env.VERCEL_TEAM_ID,
      env.VERCEL_TOKEN,
      body,
    );
  async function currentHead() {
    assert.equal(
      (await github("/git/ref/heads/" + branch)).object.sha,
      sha,
      `${branch} advanced; deploy its current commit`,
    );
  }
  await currentHead();
  const runs = await github(
    `/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&per_page=100`,
  );
  const ci = runs.workflow_runs.find(
    (run) => run.head_branch === branch && run.head_sha === sha && run.event === "push",
  );
  assert.equal(ci?.conclusion, "success", "Wait for successful branch CI before deploying");
  const jobs = await github(`/actions/runs/${ci.id}/jobs?per_page=100`);
  assert.ok(
    jobs.jobs.some((job) => job.name === "CI passed" && job.conclusion === "success"),
    "CI gate did not pass",
  );
  const project = await vercel("/v9/projects/" + env.VERCEL_PROJECT_ID);
  assert.equal(project.id, env.VERCEL_PROJECT_ID);
  assert.equal(project.link?.type, "github");
  assert.equal(project.link?.org, "zdevzone");
  assert.equal(project.link?.repo, "keyforge");
  assert.equal(project.link?.productionBranch, "main");
  assert.ok(project.link.repoId, "Connect the public GitHub repository in Vercel");
  const domains = await vercel(`/v9/projects/${project.id}/domains`);
  for (const [url, gitBranch] of [
    [productionURL, null],
    [previewURL, "dev"],
  ]) {
    const domain = domains.domains.find((d) => d.name === new URL(url).hostname);
    assert.ok(domain?.verified, "Verify the configured deployment domains in Vercel");
    assert.equal(domain.gitBranch ?? null, gitBranch, "Domain points at the wrong branch");
  }
  function deploymentURL(deployment) {
    assert.equal(deployment.projectId, project.id, "Deployment belongs to a different project");
    assert.match(deployment.url ?? "", /^[a-z0-9-]+\.vercel\.app$/i);
    return "https://" + deployment.url;
  }
  async function healthy(url, protectedPreview = true) {
    for (let check = 0; check < 6; check++) {
      try {
        const response = await request(url + "/healthz", {
          headers: protectedPreview
            ? { "x-vercel-protection-bypass": env.VERCEL_AUTOMATION_BYPASS_SECRET }
            : {},
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok && (await response.json()).ok === true) return;
      } catch {
        /* Wait briefly for a newly ready deployment. */
      }
      await wait(5000);
    }
    throw Error("Deployment health verification failed. Inspect Vercel before retrying.");
  }
  if (production) {
    const source = await github(`/git/commits/${sha}`);
    const list = await vercel(`/v6/deployments?projectId=${project.id}&state=READY&limit=100`);
    let staged;
    for (const deployment of list.deployments) {
      if (
        deployment.target === "production" ||
        deployment.meta?.githubCommitRef !== "dev" ||
        !shaPattern.test(deployment.meta?.githubCommitSha ?? "")
      )
        continue;
      const commit = await github(`/git/commits/${deployment.meta.githubCommitSha}`);
      if (commit.tree.sha === source.tree.sha) {
        staged = deployment;
        break;
      }
    }
    assert.ok(staged, "No ready dev Preview matches this source tree; deploy and test dev first");
    await healthy(deploymentURL(staged));
  }
  await currentHead();
  const deployment = await vercel("/v13/deployments", {
    name: project.name,
    project: project.id,
    ...(production && { target: "production", autoAssignCustomDomains: false }),
    gitSource: { type: "github", repoId: project.link.repoId, ref: branch, sha },
    meta: { keyforgeWorkflow: "github-actions", keyforgeCommit: sha },
  });
  assert.match(deployment.id ?? "", /^dpl_[a-zA-Z0-9]+$/);
  console.log(`Building ${branch} commit ${sha}; Vercel deployment ${deployment.id}`);
  let ready;
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await vercel("/v13/deployments/" + deployment.id);
    assert.ok(
      !["ERROR", "CANCELED", "BLOCKED"].includes(result.readyState),
      `Vercel deployment ended: ${result.readyState}`,
    );
    if (result.readyState === "READY") {
      ready = result;
      break;
    }
    await wait(10_000);
  }
  assert.ok(ready, "Timed out waiting for Vercel; inspect the existing deployment before retrying");
  assert.equal(ready.meta?.githubCommitSha, sha, "Vercel built a different commit");
  assert.equal(ready.meta?.githubCommitRef, branch, "Vercel built a different branch");
  assert.equal(ready.target === "production", production, "Vercel used a different environment");
  const builtURL = deploymentURL(ready);
  await healthy(builtURL);
  await currentHead();
  if (production) await vercel(`/v10/projects/${project.id}/promote/${ready.id}`, {});
  // Preview branch domains are assigned by Vercel; production promotion assigns
  // only Production domains, never the domains attached to dev.
  const publicURL = production ? productionURL : previewURL;
  let assigned = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const alias = await vercel("/v4/aliases/" + new URL(publicURL).hostname);
    assert.equal(alias.projectId, project.id, "Alias belongs to a different project");
    if (alias.deploymentId === ready.id) {
      assigned = true;
      break;
    }
    await wait(5000);
  }
  assert.ok(
    assigned,
    "Domain has not switched to the new deployment; inspect Vercel before retrying",
  );
  await healthy(publicURL, !production);
  const result = {
    deploymentId: ready.id,
    commit: sha,
    branch,
    url: production ? productionURL : previewURL,
  };
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `Vercel ${env.DEPLOY_ENV}: [${result.url}](${result.url})\n\nCommit: \`${sha}\` · Deployment: \`${ready.id}\`\n`,
    );
  console.log(`Verified Vercel ${env.DEPLOY_ENV}: ${result.url}`);
  return result;
}

export const deployProduction = (env, options) =>
  deployVercel({ ...env, DEPLOY_ENV: "production" }, options);
export const deployPreview = (env, options) =>
  deployVercel({ ...env, DEPLOY_ENV: "preview" }, options);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  deployVercel(process.env).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
