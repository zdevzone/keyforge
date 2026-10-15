/** https://www.postgresql.org/docs/current/libpq-envars.html
 * libpq CLI wiring: explicit target, no credential-bearing process arguments. */
export function postgresCliConnection(source: string, databaseOverride?: string) {
  const url = new URL(source);
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new Error("Expected a Postgres connection URL.");
  const database =
    databaseOverride ?? url.searchParams.get("dbname") ?? decodeURIComponent(url.pathname.slice(1));
  if (!database) throw new Error("A database name is required.");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.searchParams.get("host") ?? url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.searchParams.get("port") ?? (url.port || "5432"),
    PGUSER: url.searchParams.get("user") ?? decodeURIComponent(url.username),
    PGPASSWORD: url.searchParams.get("password") ?? decodeURIComponent(url.password),
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: "15",
    PGSSLMODE: url.searchParams.get("sslmode") ?? "verify-full",
    PGOPTIONS: url.searchParams.get("options") ?? "",
  };
  for (const field of ["sslcert", "sslkey", "sslrootcert", "sslcrl", "sslcrldir"]) {
    const value = url.searchParams.get(field);
    if (value) env[field.toUpperCase().replace(/^SSL/, "PGSSL")] = value;
  }
  return { database, env };
}
