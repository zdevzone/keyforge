import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";

export function localEnvironmentOptions(args) {
  const option = (name) => {
    const index = args.indexOf("--" + name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw Error("--" + name + " requires a path.");
    return value;
  };
  const selected = option("env-file");
  return {
    file: selected || ".env",
    explicit: Boolean(selected),
    // A named environment owns its keys; it must not silently reuse local keys.
    secretsDir: option("secrets-dir") || (selected ? join(dirname(selected), "keys") : "./secrets"),
  };
}

function encode(value) {
  const quote = value.includes("'") ? '"' : "'";
  if (value.includes(quote))
    throw new Error(
      "Environment values containing both quote characters need explicit manual configuration.",
    );
  return quote + value + quote;
}

async function writeAtomic(source, file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

/** Replace a complete environment atomically, including multiline PEM values. */
export async function writeEnvironment(settings, file) {
  await writeAtomic(
    Object.entries(settings)
      .map(([key, value]) => key + "=" + encode(value))
      .join("\n") + "\n",
    file,
  );
}

export async function readLocalEnv(file = ".env") {
  try {
    const source = await readFile(file, "utf8");
    return { exists: true, source, values: parseEnv(source) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { exists: false, source: "", values: {} };
  }
}
export async function confirmLocalUpdate(message, yes = false) {
  if (yes) return true;
  if (!process.stdin.isTTY)
    throw new Error(
      "Interactive confirmation required. Review the configuration, then rerun with --yes to confirm.",
    );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(?:y|yes)?$/i.test((await prompt.question(message + " [Y/n] ")).trim());
  } finally {
    prompt.close();
  }
}
/** Preserve comments and unrelated variables; never print secret values. */
export async function saveLocalEnv(settings, file = ".env") {
  const { source } = await readLocalEnv(file);
  const remaining = new Map(Object.entries(settings));
  const lines = source.split(/\r?\n/).flatMap((line) => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (!key || !Object.hasOwn(settings, key)) return [line];
    if (!remaining.has(key)) return [];
    remaining.delete(key);
    return [key + "=" + encode(settings[key])];
  });
  for (const [key, value] of remaining) lines.push(key + "=" + encode(value));
  await writeAtomic(lines.join("\n").replace(/\n*$/, "\n"), file);
}
