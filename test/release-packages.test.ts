import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

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
