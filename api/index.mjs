import { createLicenseServer } from "../dist/src/server.js";

let boot;
export default async function handler(request, response) {
  try {
    const { app } = await (boot ??= createLicenseServer(true)
      .then(async (server) => {
        await server.app.ready();
        return server;
      })
      .catch((error) => {
        boot = undefined;
        throw error;
      }));
    app.server.emit("request", request, response);
  } catch {
    // Configuration and connection errors may contain credentials. Do not
    // include the caught exception in a public response or deployment logs.
    response.writeHead(503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "10",
    });
    response.end(
      JSON.stringify({
        error: "service_unavailable",
        message:
          "The service could not initialize. Check server configuration and database connectivity.",
      }),
    );
  }
}
