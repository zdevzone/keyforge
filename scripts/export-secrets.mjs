import { resolve } from "node:path";

import {
  confirmLocalUpdate,
  localEnvironmentOptions,
  readLocalEnv,
  writeEnvironment,
} from "./local-env.mjs";
import { portableEnvironment } from "./portable-environment.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: vp run secrets:export [--env-file PATH] --output PATH [--yes]\nWrite existing server settings and inline key material to a private deployment file. Source files and keys are retained; values are never printed.",
  );
  process.exit(0);
}
const { file } = localEnvironmentOptions(args);
const index = args.indexOf("--output");
const output = index < 0 ? undefined : args[index + 1];
if (!output || output.startsWith("--"))
  throw Error("Use --output PATH for a private, ignored deployment environment file.");
if (resolve(file) === resolve(output))
  throw Error("Use a separate output file; the source configuration and key files are retained.");
const source = await readLocalEnv(file);
if (!source.exists) throw Error("The selected source environment file does not exist.");
const settings = await portableEnvironment(source.values);
if (
  (await readLocalEnv(output)).exists &&
  !(await confirmLocalUpdate(
    "Replace " + output + " with this environment's settings?",
    args.includes("--yes"),
  ))
)
  process.exit(0);
await writeEnvironment(settings, output);
console.log(
  "Saved portable server settings to " +
    output +
    ". Values were not printed; source files and keys were retained. Configure provider access separately.",
);
