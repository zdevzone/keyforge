import { readFileSync } from "node:fs";

import SQLite from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import pg from "pg";

import type { Database } from "./schema.js";

/**
 * Connection setup for the two supported engines.
 *
 * SQLite is the default: one file, no server, fine for the scale most vendors
 * ever reach. Postgres is for deployments that need durability or more than
 * one process — selected purely by DATABASE_URL, so switching engines is a
 * config change rather than a code change.
 */

export type Engine = "sqlite" | "postgres";

export interface DatabaseHandle {
  db: Kysely<Database>;
  engine: Engine;
  /** The SQLite file path — needed for online backups; null on Postgres. */
  sqlitePath: string | null;
  /** The underlying better-sqlite3 handle, for the backup API. */
  sqlite: SQLite.Database | null;
  close: () => Promise<void>;
}

export interface ConnectOptions {
  /** postgres://… selects Postgres; absent means SQLite. */
  url?: string;
  /** SQLite file (or ":memory:"). Ignored when a Postgres URL is given. */
  sqlitePath?: string;
}

export function isPostgresUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^postgres(ql)?:\/\//.test(url);
}

/** Hosts where an unencrypted connection never leaves the machine. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", ""]);

export interface PostgresPoolOptions {
  /** The URL with its TLS parameters removed — see resolvePostgresOptions. */
  connectionString: string;
  ssl: pg.PoolConfig["ssl"];
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

/**
 * TLS parameters stripped from the URL before pg parses it.
 *
 * This is not tidiness. pg builds its config as
 * `Object.assign({}, config, parse(connectionString))`
 * (`pg/lib/connection-parameters.js`), so anything parsed out of the URL
 * *overrides* what is passed alongside it: leaving `sslmode=require` in place
 * would silently discard the decision made below and hand the choice back to
 * the driver's version-dependent default. Removing the parameter is what makes
 * the explicit `ssl` object authoritative — and it also stops pg emitting its
 * sslmode deprecation warning on every boot.
 */
const TLS_PARAMS = ["sslmode", "ssl", "sslnegotiation", "uselibpqcompat", "channel_binding"];
/** File-backed TLS material: honoured, but read here rather than by pg. */
const TLS_FILE_PARAMS = { sslrootcert: "ca", sslcert: "cert", sslkey: "key" } as const;

/**
 * Decide how to connect to a Postgres URL. Pulled out as a pure function
 * because the two decisions it makes are worth testing without a database.
 *
 * **TLS is resolved here rather than inferred by the driver.** A URL ending in
 * `?sslmode=require` — what Neon, Supabase and most managed providers hand you
 * — means fully verified TLS under pg 8 and, from pg 9, encrypted-but-
 * unverified: the same string, a weaker guarantee, after a dependency bump.
 * This database holds operator credentials, so the decision is pinned here
 * instead: anything remote gets its certificate verified against the system
 * CA unless the URL explicitly opts out. Stating it also silences pg's
 * deprecation warning, which would otherwise print on every boot.
 *
 * `sslmode=disable` and `no-verify` are honoured as written — a self-signed
 * certificate or a private network is a legitimate choice, and one worth
 * having to write down.
 */
export function resolvePostgresOptions(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): PostgresPoolOptions {
  const parsed = safeParseUrl(url);
  const sslmode = parsed?.searchParams.get("sslmode")?.toLowerCase();
  const host = parsed?.hostname.toLowerCase() ?? "";
  const remote = !LOOPBACK.has(host);

  // Certificates and keys named in the URL are still honoured; they are read
  // here so that stripping the TLS parameters loses nothing.
  const material: { ca?: string; cert?: string; key?: string } = {};
  for (const [param, field] of Object.entries(TLS_FILE_PARAMS)) {
    const path = parsed?.searchParams.get(param);
    if (path) material[field] = readFileSync(path, "utf8");
  }

  let ssl: pg.PoolConfig["ssl"];
  if (sslmode === "disable") {
    ssl = false;
  } else if (sslmode === "no-verify" || sslmode === "allow" || sslmode === "prefer") {
    // Encrypted, unverified: the deployer said so explicitly.
    ssl = { rejectUnauthorized: false, ...material };
  } else if (sslmode || remote || Object.keys(material).length > 0) {
    ssl = { rejectUnauthorized: true, ...material };
  } else {
    // Loopback with nothing specified: plain local Postgres, as before.
    ssl = false;
  }

  // Hand pg a URL with no TLS parameters left in it, so the decision above is
  // the one that survives. Everything else about the URL is untouched.
  let connectionString = url;
  if (parsed) {
    for (const param of [...TLS_PARAMS, ...Object.keys(TLS_FILE_PARAMS)]) {
      parsed.searchParams.delete(param);
    }
    connectionString = parsed.toString();
  }

  // Two pools live in one process (ledger and operator accounts), so pg's
  // default of 10 each is 20 connections per instance — careless against a
  // database with a connection budget, and most of them idle.
  const configured = Number(env.LICENSE_DB_POOL_MAX);
  const max = Number.isInteger(configured) && configured > 0 ? configured : 5;

  return {
    connectionString,
    ssl,
    max,
    // A serverless database closes idle connections itself; releasing them
    // first is tidier than discovering they are gone.
    idleTimeoutMillis: 30_000,
    // A suspended compute takes a moment to wake — wait, but not forever.
    connectionTimeoutMillis: 15_000,
  };
}

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The one place a Postgres pool is created, for the ledger and for the auth
 * database alike.
 *
 * The error listener is not decoration. `pg.Pool` is an EventEmitter that
 * emits `error` when an *idle* client fails, and an EventEmitter with no
 * error listener throws — which takes the process down. Managed databases
 * close idle connections as a matter of routine (a serverless compute
 * suspends after a few minutes), so without this a quiet night is enough to
 * kill the service. The pool has already discarded the client by then; the
 * next query opens a fresh one, so logging and continuing is the whole fix.
 */
export function createPostgresPool(url: string, env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const pool = new pg.Pool(resolvePostgresOptions(url, env));
  pool.on("error", (error) => {
    console.warn(`[license-server] idle Postgres client dropped: ${error.message}`);
  });
  return pool;
}

export function connectDatabase(options: ConnectOptions = {}): DatabaseHandle {
  if (isPostgresUrl(options.url)) {
    const pool = createPostgresPool(options.url);
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return {
      db,
      engine: "postgres",
      sqlitePath: null,
      sqlite: null,
      close: async () => {
        await db.destroy();
      },
    };
  }

  const path = options.sqlitePath ?? "licenses.sqlite";
  const sqlite = new SQLite(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return {
    db,
    engine: "sqlite",
    sqlitePath: path,
    sqlite,
    close: async () => {
      await db.destroy();
    },
  };
}

/** Portable "does this table exist" check, used by the migration runner. */
export async function tableExists(
  db: Kysely<Database>,
  engine: Engine,
  table: string,
): Promise<boolean> {
  if (engine === "postgres") {
    const result = await sql<{ exists: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ${table}
      ) AS exists
    `.execute(db);
    return result.rows[0]?.exists === true;
  }
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.execute(db);
  return result.rows.length > 0;
}

/** Portable column list for a table, used to detect pre-entitlements schemas. */
export async function tableColumns(
  db: Kysely<Database>,
  engine: Engine,
  table: string,
): Promise<Set<string>> {
  if (engine === "postgres") {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${table}
    `.execute(db);
    return new Set(result.rows.map((row) => row.column_name));
  }
  const result = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(
    db,
  );
  return new Set(result.rows.map((row) => row.name));
}
