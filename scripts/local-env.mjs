import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";

export async function readLocalEnv(file = ".env.local") {
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
export async function saveLocalEnv(settings, file = ".env.local") {
  const encode = (value) => {
    const quote = value.includes("'") ? '"' : "'";
    if (value.includes(quote))
      throw new Error(
        "Environment values containing both quote characters need explicit manual configuration.",
      );
    return quote + value + quote;
  };
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
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}
