import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

// @ts-expect-error Plain ESM generator is consumed directly by Node.
import { main as createClientStarter } from "../packages/create-keyforge-client/src/index.mjs";
// The generator is plain ESM; exercise the real prompt library with terminal
// input rather than a second implementation of arrow-key behavior.
// @ts-expect-error Plain ESM package deliberately has no TypeScript build.
import { createPrompter } from "../packages/create-keyforge/src/prompts.mjs";

test("generator prompts use defaults without touching a pipe", async () => {
  const ask = createPrompter({ interactive: false });
  assert.equal(await ask.text("Directory", "server"), "server");
  assert.equal(await ask.select("Database", [], "sqlite"), "sqlite");
  assert.equal(await ask.confirm("Install?", false), false);
  ask.close();
});

test("client starter validates configuration and preserves existing applications", async () => {
  const root = await mkdtemp(join(tmpdir(), "keyforge-client-starter-"));
  const directory = join(root, "client");
  const output = { write() {} };
  await assert.rejects(
    createClientStarter(
      [directory, "--yes", "--server-url", "https://user:secret@example.com"],
      output,
    ),
    /origin/,
  );
  await createClientStarter(
    [directory, "--yes", "--server-url", "https://licenses.example.com", "--product", "studio"],
    output,
  );
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies["@zdevzone/keyforge-client"], "^0.1.0");
  assert.match(
    await readFile(join(directory, ".env.example"), "utf8"),
    /KEYFORGE_PRODUCT_ID=studio/,
  );
  assert.match(await readFile(join(directory, "src/storage.ts"), "utf8"), /throw new Error/);
  assert.match(
    await readFile(join(directory, "src/index.ts"), "utf8"),
    /demo && action !== "status"/,
  );
  await writeFile(join(directory, "keep.txt"), "Existing application");
  await assert.rejects(createClientStarter([directory, "--yes"], output), /not empty/);
  assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "Existing application");
  const empty = join(root, "empty");
  await mkdir(empty);
  await assert.rejects(
    createClientStarter([empty, "--yes", "--product", "bad\nLICENSE_ADMIN_TOKEN=anything"], output),
    /product ID/,
  );
});

test(
  "arrow keys select a choice and Ctrl+C cancels without hanging",
  { timeout: 5000 },
  async () => {
    for (const cancel of [false, true]) {
      const input = new PassThrough();
      const output = new PassThrough();
      Object.assign(input, { isTTY: true, setRawMode() {} });
      Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
      output.resume();
      const ask = createPrompter({ interactive: true, input, output });
      const result = ask.select(
        "Database",
        [
          { id: "sqlite", title: "SQLite" },
          { id: "postgres", title: "PostgreSQL" },
        ],
        "sqlite",
      );
      setTimeout(() => {
        input.write(cancel ? "\u0003" : "\u001b[B");
        if (!cancel) input.write("\r");
      }, 30);
      if (cancel) await assert.rejects(result, /cancelled/);
      else assert.equal(await result, "postgres");
      ask.close();
      input.destroy();
      output.destroy();
    }
  },
);
