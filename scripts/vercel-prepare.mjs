import { parseEnv } from "../dist/src/env.js";
import { initializeAppDatabase } from "../dist/src/maintenance.js";
import { validateVercelEnvironment } from "../dist/src/vercel-config.js";

const env = parseEnv(process.env);
validateVercelEnvironment(env);
// Only run against the explicitly selected environment database. Render is
// never contacted; select production or preview credentials deliberately.
const verification = new URL(env.LICENSE_BACKUP_VERIFY_DATABASE_URL);
const source = new URL(env.DATABASE_URL);
if (verification.pathname === source.pathname)
  throw Error("Verification must use a different database name, never the application database.");
await initializeAppDatabase({ env: { ...process.env, ...env } });
await initializeAppDatabase({
  env: {
    ...process.env,
    ...env,
    DATABASE_URL: verification.href,
    LICENSE_SEED_ADMIN_EMAIL: undefined,
    LICENSE_SEED_ADMIN_PASSWORD: undefined,
  },
});
console.log("Application and independent verification schemas initialized. No secrets printed.");
