import { resolveListenPort } from "./config.js";
import { createLicenseServer } from "./server.js";

const { app, config, database, signingKey, kid, env } = await createLicenseServer();
const port = resolveListenPort();
const host = env.LICENSE_HOST ?? "0.0.0.0";
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(
    signal,
    () =>
      void app.close().catch(() => {
        process.exitCode = 1;
      }),
  );
}

await app.listen({ port, host });
console.log(
  `${config.branding.name} license service listening on ${host}:${port} (${database.engine})`,
);
// Printed every boot so "which key is production actually signing with?" is
// answerable from the platform's log tail. The public half only.
console.log(
  `[license-server] signing key ${signingKey.keyType} ${signingKey.fingerprint} (kid ${kid})`,
);
if (!env.LICENSE_ADMIN_TOKEN) {
  console.warn("[license-server] LICENSE_ADMIN_TOKEN is not set — CLI admin access is disabled.");
}
if (!env.LICENSE_AUTH_SECRET) {
  console.warn("[license-server] LICENSE_AUTH_SECRET is not set — the admin console is disabled.");
}
