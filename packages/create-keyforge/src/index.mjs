import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCliArgs, USAGE } from "./args.mjs";
import {
  AUTH_SCOPES,
  DATABASES,
  USE_CASES,
  buildConfig,
  buildEnvExample,
  buildEnvLocal,
  buildPackageJson,
  buildReadme,
  retargetDockerfileContents,
  retargetWorkflow,
  retargetNpmCommands,
  retargetDocs,
  nextSteps,
  parseAuthScope,
  toKeyPrefix,
  toPackageName,
  toProductName,
} from "./generate.mjs";
import {
  DEFAULT_PLATFORM,
  PLATFORMS,
  PLATFORM_PATHS,
  getPlatform,
  platformFiles,
  platformKeeps,
  platformNotes,
} from "./platforms.mjs";
import { createPrompter } from "./prompts.mjs";
import { isEmptyDirectory, materializeTemplate, resolveTemplate, run } from "./template.mjs";
import {
  DEFAULT_PACKAGE_MANAGER,
  DEFAULT_RUNTIME,
  PACKAGE_MANAGERS,
  RUNTIMES,
  runtimeConfig,
  commands,
} from "./toolchain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const bold = (text) => (process.stdout.isTTY ? `\u001b[1m${text}\u001b[0m` : text);
const dim = (text) => (process.stdout.isTTY ? `\u001b[2m${text}\u001b[0m` : text);

async function version() {
  const pkg = JSON.parse(await readFile(resolve(HERE, "../package.json"), "utf8"));
  return pkg.version;
}

/** A 32-byte secret, base64url — long enough that nobody is tempted to shorten it. */
function secret() {
  return randomBytes(32).toString("base64url");
}

export async function main(argv = process.argv.slice(2), io = process.stdout) {
  const options = parseCliArgs(argv);
  if (options.help) {
    io.write(`${USAGE}\n`);
    return 0;
  }
  if (options.version) {
    io.write(`${await version()}\n`);
    return 0;
  }

  // Prompt only when there is a human on the other end who has not already
  // answered with flags or --yes.
  const interactive = !options.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const ask = createPrompter({ interactive });

  try {
    io.write(`\n${bold("create-keyforge")} ${dim(`v${await version()}`)}\n`);
    if (interactive) io.write("Use Up/Down to move, Enter to select, and Ctrl+C to cancel.\n");

    const directoryInput =
      options.directory ??
      (await ask.text("Where should we create your server?", "keyforge-server"));
    const directory = resolve(directoryInput);
    if (!options.force && !(await isEmptyDirectory(directory))) {
      throw new Error(
        `${directory} is not empty. Pick another directory, or pass --force to scaffold into it anyway.`,
      );
    }

    const directoryName = basename(directory);
    const productName =
      options.productName ??
      (await ask.text("What is your product called?", toProductName(directoryName)));
    const keyPrefix = await resolveKeyPrefix(options, ask, productName);
    const database =
      options.database ??
      (await ask.select("Where should KeyForge store its data?", DATABASES, "sqlite"));
    const useCase =
      options.useCase ??
      (await ask.select("Which license plans should we start with?", USE_CASES, "count"));
    const authScope =
      options.authScope ??
      parseAuthScope(
        await ask.select("What should administrators be able to manage?", AUTH_SCOPES, "core"),
      );
    const platform =
      options.platform ??
      (await ask.select("Where will you deploy this server?", PLATFORMS, DEFAULT_PLATFORM));
    const cpanelUser =
      platform === "cpanel"
        ? (options.cpanelUser ?? (await ask.text("cPanel account name", "")))
        : undefined;
    const packageManager =
      options.packageManager ??
      (await ask.select(
        "Which tool should manage this project's dependencies?",
        PACKAGE_MANAGERS,
        DEFAULT_PACKAGE_MANAGER,
      ));
    // Asked separately from the package manager because they are separate
    // choices: Bun installs happily against a Node runtime. Only one runtime
    // is offered today, so this is a no-op prompt until a second one lands --
    // but the answer is already carried everywhere it will be needed.
    const runtime =
      RUNTIMES.length > 1
        ? (options.runtime ?? (await ask.select("Runtime", RUNTIMES, DEFAULT_RUNTIME)))
        : (options.runtime ?? DEFAULT_RUNTIME);
    ask.close();

    const answers = {
      directory,
      packageName: toPackageName(directoryName),
      productName,
      keyPrefix,
      database,
      useCase,
      authScope,
      platform,
      cpanelUser,
      packageManager,
      runtime,
    };

    const template = await resolveTemplate(options.template);
    io.write(`\n${dim(`Fetching template from ${template.label}`)}\n`);
    // Every host manifest the template carries is dropped, then the chosen
    // target's own are written back — a project should describe one
    // deployment, and never inherit upstream's service names or home paths.
    const keeps = new Set(platformKeeps(answers));
    const populate = async (target) => {
      await materializeTemplate(template, target, {
        alsoPrune: PLATFORM_PATHS.filter((path) => !keeps.has(path)),
      });
      await writeProject(target, answers);
    };
    const exists = await stat(directory).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) {
      // Preserve the established merge behavior for an explicitly existing
      // directory (--force), including its Git metadata.
      await populate(directory);
    } else {
      // Vite+ on Windows can count slash-normalized paths at the same depth.
      // Prepare away from its package discovery, then expose only the root
      // manifest write. A directory rename does not rewrite ui/package.json.
      const cache = resolve(dirname(directory), "node_modules/.cache");
      await mkdir(cache, { recursive: true });
      const staging = await mkdtemp(resolve(cache, "create-keyforge-"));
      try {
        await populate(staging);
        await rename(staging, directory);
        writeFileSync(
          resolve(directory, "package.json"),
          await readFile(resolve(directory, "package.json")),
        );
      } finally {
        // Only this newly allocated staging directory, never the output app.
        await rm(staging, { recursive: true, force: true });
      }
    }

    if (options.install) {
      io.write(`${dim("Installing dependencies")}\n`);
      const [command, ...args] = commands(packageManager).install.split(" ");
      await run(command, args, { cwd: directory });
    }
    if (options.git) await initGit(directory);

    report(io, answers, {
      relativeDirectory: displayPath(directory),
      installed: options.install,
    });
    return 0;
  } finally {
    ask.close();
  }
}

async function resolveKeyPrefix(options, ask, productName) {
  if (options.keyPrefix) return options.keyPrefix;
  const suggestion = toKeyPrefix(productName);
  for (;;) {
    const answer = (
      await ask.text("License key prefix (1–10 letters or digits)", suggestion)
    ).toUpperCase();
    if (/^[A-Z0-9]{1,10}$/.test(answer)) return answer;
    if (!ask.interactive) return suggestion;
    process.stdout.write("  1-10 uppercase letters or digits, e.g. ACME.\n");
  }
}

/**
 * Read the copied Dockerfile, retarget it, write it back. Split from the pure
 * transform so the transform stays testable without a filesystem.
 */
async function retargetDockerfile(path, answers) {
  await retargetTextFile(path, answers, retargetDockerfileContents);
}

/**
 * Read, transform, write back. A missing file is not a failure: not every
 * template carries a Dockerfile or a workflow.
 */
async function retargetTextFile(path, answers, transform) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await writeFile(path, transform(contents, answers.packageManager, answers));
}

/**
 * Turn the freshly copied template into this deployer's project: their config,
 * their secrets, their package name, their README. Upstream's README is kept
 * as reference documentation rather than deleted.
 */
async function writeProject(directory, answers) {
  const at = (...parts) => resolve(directory, ...parts);

  await writeFile(at("keyforge.config.json"), `${JSON.stringify(buildConfig(answers), null, 2)}\n`);
  await writeFile(
    at(".env.local"),
    buildEnvLocal({ ...answers, adminToken: secret(), authSecret: secret() }),
  );
  await writeFile(at(".env.example"), buildEnvExample(answers));

  const templatePackage = JSON.parse(await readFile(at("package.json"), "utf8"));
  // Vite+ detects the generated root from synchronous package.json writes.
  // Promise-based writes are not consistently reported by its Windows tracer.
  writeFileSync(
    at("package.json"),
    `${JSON.stringify(buildPackageJson(templatePackage, answers), null, 2)}\n`,
  );

  await mkdir(at("secrets"), { recursive: true, mode: 0o700 });
  for (const name of ["data", "backup"])
    await writeFile(
      at("secrets", name + ".keyring.json"),
      JSON.stringify({ active: "initial", keys: { initial: randomBytes(32).toString("hex") } }) +
        "\n",
      { mode: 0o600 },
    );
  for (const file of ["package.json", "ui/package.json"]) {
    const path = at(file);
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" && file === "ui/package.json") continue;
      throw error;
    }
    for (const group of [pkg.dependencies, pkg.devDependencies])
      if (group) {
        if (group["vite-plus"] === "catalog:") group["vite-plus"] = "1.1.0";
        if (group.vite === "catalog:") group.vite = "npm:@voidzero-dev/vite-plus-core@1.1.0";
      }
    if (file !== "package.json") {
      delete pkg.devEngines;
      pkg.scripts = retargetNpmCommands(JSON.stringify(pkg.scripts), answers.packageManager);
      pkg.scripts = JSON.parse(pkg.scripts);
    }
    writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  }
  await writeFile(
    at("pnpm-workspace.yaml"),
    "packages:\n  - ui\nallowBuilds:\n  better-sqlite3: true\n  esbuild: true\n  msgpackr-extract: false\noverrides:\n  effect: 3.22.2\n  vite@*: npm:@voidzero-dev/vite-plus-core@1.1.0\n",
  );

  // The file Vite+, Fly, Render, nvm and most CI actions all read. One line,
  // and it stops the runtime version from being something each host guesses.
  await writeFile(at(".node-version"), `${runtimeConfig(answers.runtime).version}\n`);

  // The Dockerfile is copied from the template, not generated, and it names npm
  // three times. Left alone, a pnpm or Bun project would ship an image built by
  // a manager it does not use.
  await retargetDockerfile(at("Dockerfile"), answers);

  // Same trap, different file: the workflow names npm directly, and a project
  // would only discover it on its first push.
  await retargetTextFile(at(".github", "workflows", "ci.yml"), answers, retargetWorkflow);

  // AGENTS.md is how a coding agent learns to work in this project. Leaving it
  // full of npm would have an agent install with the wrong manager on its first
  // task -- the most quietly destructive of these, because nobody reads it.
  await retargetTextFile(at("AGENTS.md"), answers, retargetNpmCommands);

  // The reference docs are this project's documentation now, not upstream's, so
  // their commands must be this project's too. docs/keyforge.md is deliberately
  // excluded: it is kept verbatim as upstream's own README.
  for (const doc of [
    "api.md",
    "cli.md",
    "deploy.md",
    "backups.md",
    "verify-token.md",
    "dependent-app-integration.md",
    "dependent-app-ai-context.md",
    "integration-review.md",
    "cpanel-guide.md",
    "configuration.md",
  ]) {
    await retargetTextFile(at("docs", doc), answers, retargetDocs);
  }

  // Upstream's README becomes reference documentation rather than vanishing:
  // it is the best writing about the service the deployer now owns.
  await mkdir(at("docs"), { recursive: true });
  await rename(at("README.md"), at("docs", "keyforge.md"));
  await writeFile(at("README.md"), buildReadme(answers));

  // The example config is upstream's illustration; this project has a real one now.
  await rm(at("keyforge.config.example.json"), { force: true });

  for (const [path, contents] of Object.entries(platformFiles(answers))) {
    await mkdir(dirname(at(path)), { recursive: true });
    await writeFile(at(path), contents);
    // Scripts are the deployment definition on hosts with no manifest format;
    // one that is not executable is a papercut on the first attempt.
    if (path.endsWith(".sh")) await chmod(at(path), 0o755);
  }
}

async function initGit(directory) {
  try {
    await run("git", ["init", "--quiet"], { cwd: directory, stdio: "ignore" });
    await run("git", ["add", "-A"], { cwd: directory, stdio: "ignore" });
    await run("git", ["commit", "--quiet", "-m", "Scaffold license server with create-keyforge"], {
      cwd: directory,
      stdio: "ignore",
    });
  } catch {
    // A missing git, or an unconfigured user.email, is not worth failing a
    // scaffold over — the files are already on disk.
  }
}

/** A path worth printing: relative when it is short, absolute when it is not. */
function displayPath(directory) {
  const rel = relative(process.cwd(), directory);
  if (!rel) return ".";
  return rel.startsWith("..") ? directory : rel;
}

function report(io, answers, context) {
  const scope = Array.isArray(answers.authScope) ? answers.authScope.join(", ") : answers.authScope;
  io.write(
    `\n${bold(answers.productName)} license service scaffolded in ${context.relativeDirectory}\n`,
  );
  io.write(
    `${dim(
      [
        `  database        ${answers.database}`,
        `  licensing model ${answers.useCase}`,
        `  key prefix      ${answers.keyPrefix}-XXXXX-XXXXX-XXXXX-XXXXX`,
        `  admin features  ${scope}`,
        `  deploy target   ${getPlatform(answers.platform).title}`,
        `  package manager ${answers.packageManager}`,
        `  runtime         ${answers.runtime}`,
      ].join("\n"),
    )}\n`,
  );
  io.write(`\n${bold("Next")}\n`);
  for (const step of nextSteps({ ...answers, ...context })) {
    io.write(`  ${step}\n`);
  }
  // Warnings print last, where they are still on screen when the scaffolder
  // exits — an ephemeral free tier losing a licence ledger is worth the space.
  const notes = platformNotes(answers);
  if (notes.length > 0) {
    io.write(`\n${bold("Worth knowing")}\n`);
    for (const note of notes) io.write(`  ! ${note}\n`);
  }
  io.write(
    `\n${dim(".env.local holds generated secrets — it is gitignored; set the same variables on your host.")}\n\n`,
  );
}
