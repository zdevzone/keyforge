/** One database selection policy shared by the process and administrative tools. */
export function resolveRuntime(env: NodeJS.ProcessEnv = process.env) {
  const url = env.DATABASE_URL || undefined;
  if (url && !/^postgres(ql)?:\/\//.test(url)) throw new Error("DATABASE_URL must be Postgres.");
  const sqlitePath = env.LICENSE_DB_PATH || "licenses.sqlite";
  return {
    url,
    sqlitePath,
    authDbPath: sqlitePath,
    engine: url ? ("postgres" as const) : ("sqlite" as const),
  };
}
