import { writeFileSync } from "node:fs";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { cancel, isCancel, text } from "@clack/prompts";

const usage = `Create a KeyForge Node.js client starter.

  vp create keyforge-client -- <directory> [options]
  node packages/create-keyforge-client/bin/create-keyforge-client.mjs <directory> [options]

Options:
  --server-url <url>  Your KeyForge HTTPS origin (localhost HTTP for development)
  --product <id>      Product ID from the KeyForge console
  --yes, -y          Use defaults without prompting
  --help, -h         Show this help

This creates a separate starter; it never modifies an existing application.
Existing apps install @zdevzone/keyforge-client and supply their storage adapter.`;

function validOrigin(value) {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2), io = process.stdout) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "server-url": { type: "string" },
      product: { type: "string" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.write(usage + "\n");
    return 0;
  }
  if (positionals.length > 1) throw new Error("Choose a single new directory.");
  const interactive = !values.yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
  async function ask(message, initial, validate) {
    if (!interactive) {
      if (validate?.(initial)) throw new Error(validate(initial));
      return initial;
    }
    const result = await text({ message, defaultValue: initial, placeholder: initial, validate });
    if (isCancel(result)) {
      cancel("Setup cancelled. No project was created.");
      throw new Error("Setup cancelled.");
    }
    return result || initial;
  }
  const directory = resolve(
    positionals[0] ??
      (await ask("Where should we create your client starter?", "keyforge-client-app")),
  );
  const serverUrl =
    values["server-url"] ??
    (await ask("KeyForge server origin", "http://localhost:4100", (v) =>
      validOrigin(v)
        ? undefined
        : "Use an HTTPS origin, or localhost HTTP, without credentials or query parameters.",
    ));
  const productId =
    values.product ??
    (await ask("Product ID from the console", "default", (v) =>
      /^[a-zA-Z0-9_-]{1,80}$/.test(v) ? undefined : "Use the product ID shown in the console.",
    ));
  if (!validOrigin(serverUrl))
    throw new Error(
      "Use a valid HTTPS server origin, or localhost HTTP, without credentials or query parameters.",
    );
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(productId)) throw new Error("Invalid product ID.");
  try {
    if ((await readdir(directory)).length)
      throw new Error("The target directory is not empty. Choose a new directory.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  // Synchronous root manifest writes allow vp create to identify the new app.
  writeFileSync(
    resolve(directory, "package.json"),
    JSON.stringify(
      {
        name:
          basename(directory)
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-") || "keyforge-client-app",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          start: "node --env-file-if-exists=.env.local --import tsx src/index.ts",
          demo: "node --env-file-if-exists=.env.local --import tsx src/index.ts --demo",
          typecheck: "tsc --noEmit",
        },
        dependencies: { "@zdevzone/keyforge-client": "^0.1.0" },
        devDependencies: { "@types/node": "^24.19.2", tsx: "^4.23.15", typescript: "^7.0.2" },
        engines: { node: "^22.18.0 || ^24.11.0 || ^26.0.0" },
      },
      null,
      2,
    ) + "\n",
  );
  await cp(fileURLToPath(new URL("../template/", import.meta.url)), directory, { recursive: true });
  await writeFile(
    resolve(directory, ".gitignore"),
    "node_modules/\ndist/\n.env.local\n*.sqlite*\n",
  );
  await writeFile(
    resolve(directory, ".env.example"),
    `KEYFORGE_SERVER_URL=${new URL(serverUrl).origin}\nKEYFORGE_PRODUCT_ID=${productId}\nKEYFORGE_PUBLIC_KEYS_FILE=./public-keys.json\n# Opt in to Windows/Linux/macOS recognition hints; no raw identifiers are sent.\nKEYFORGE_DEVICE_SIGNALS=0\n# Set KEYFORGE_LICENSE_KEY only for the activate command. Never commit it.\n`,
  );
  io.write(
    `\nClient starter created in ${directory}.\n\nNext:\n  cd ${JSON.stringify(directory)}\n  vp install\n  Copy .env.example to .env.local and configure public-keys.json.\n  vp run demo             # explicit in-memory demonstration; status only\n  vp run typecheck\n\nImplement src/storage.ts before real activation or offline restart testing.\nThe SDK does not need server signing keys or administrator credentials.\n`,
  );
  return 0;
}
