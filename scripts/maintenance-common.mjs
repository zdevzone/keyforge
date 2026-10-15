import { createConnection } from "node:net";
export function flags(args = process.argv.slice(2)) {
  const read = (name) => {
    const i = args.indexOf("--" + name);
    return i < 0 ? undefined : args[i + 1];
  };
  return { has: (name) => args.includes("--" + name), read };
}
export async function requireOffline(flag) {
  if (!flag) throw Error("Stop every Keyforge instance, then pass --maintenance.");
  const port = Number(process.env.LICENSE_PORT || process.env.PORT || 4100);
  const listening = await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (listening)
    throw Error("A server is listening on port " + port + ". Stop it before maintenance.");
}
export function maintenanceOptions(flag) {
  const scope = flag.read("scope") || "app";
  if (!["app", "schema", "database"].includes(scope))
    throw Error("Use --scope app, schema or database.");
  return {
    scope,
    confirmation: flag.read("confirm"),
    adminURL: flag.read("admin-url") || process.env.LICENSE_DATABASE_ADMIN_URL,
  };
}
