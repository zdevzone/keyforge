import { createHash, randomBytes } from "node:crypto";

import type { Kysely } from "kysely";

import type { Entitlements } from "./config.js";
import {
  connectDatabase,
  type ConnectOptions,
  type DatabaseHandle,
  type Engine,
} from "./database.js";
import { migrateToLatest } from "./migrations.js";
import type { Database } from "./schema.js";

export type LicenseServerStatus = "active" | "revoked";

export interface LicenseRow {
  id: string;
  keyHash: string;
  plan: string;
  /**
   * What this license entitles its holder to — freeform, vendor-defined
   * key/value pairs (a count allowance, feature flags, a tier). The server
   * signs them into tokens; only the consuming app interprets them.
   */
  entitlements: Entitlements;
  issuedTo: string;
  status: LicenseServerStatus;
  activationLimit: number;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  licenseId: string | null;
  detail: Record<string, unknown>;
}

export interface KeyFormat {
  prefix: string;
  alphabet: string;
  groupLength: number;
  groups: number;
}

/**
 * The product key a customer receives. Grouped and, by default, unambiguous —
 * the default alphabet drops 0/O and 1/I, because keys get read out over the
 * phone. Format is deployment-configurable; validation never depends on it
 * (keys are looked up by hash of the whole string).
 */
export const DEFAULT_KEY_FORMAT: KeyFormat = {
  prefix: "KEY",
  alphabet: "23456789ABCDEFGHJKLMNPQRSTUVWXYZ",
  groupLength: 5,
  groups: 4,
};

export function generateProductKey(format: KeyFormat = DEFAULT_KEY_FORMAT): string {
  const length = format.groupLength * format.groups;
  const bytes = randomBytes(length);
  let raw = "";
  for (const byte of bytes) raw += format.alphabet[byte % format.alphabet.length];
  const pattern = new RegExp(`.{1,${format.groupLength}}`, "g");
  const groups = raw.match(pattern) ?? [];
  return `${format.prefix}-${groups.slice(0, format.groups).join("-")}`;
}

/**
 * Keys are stored hashed, like passwords: the ledger leaking must not hand out
 * every customer's key. The key itself is shown exactly once, at issue time.
 */
export function hashProductKey(key: string): string {
  return createHash("sha256").update(key.trim().toUpperCase()).digest("hex");
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as T) : fallback;
  } catch {
    // A malformed row should not take the whole listing down with it.
    return fallback;
  }
}

export class LicenseDatabase {
  private readonly handle: DatabaseHandle;

  private constructor(handle: DatabaseHandle) {
    this.handle = handle;
  }

  /**
   * Connect and bring the schema up to date. Async because Postgres cannot be
   * anything else; SQLite deployments pay only a microscopic cost for it.
   */
  static async open(options: ConnectOptions = {}): Promise<LicenseDatabase> {
    const handle = connectDatabase(options);
    try {
      await migrateToLatest(handle.db, handle.engine);
      return new LicenseDatabase(handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  get db(): Kysely<Database> {
    return this.handle.db;
  }

  get sqlitePath(): string | null {
    return this.handle.sqlitePath;
  }

  get engine(): Engine {
    return this.handle.engine;
  }

  async appendAudit(entry: {
    actor: string;
    action: string;
    licenseId?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.db
      .insertInto("audit_log")
      .values({
        at: new Date().toISOString(),
        actor: entry.actor,
        action: entry.action,
        license_id: entry.licenseId ?? null,
        detail: JSON.stringify(entry.detail ?? {}),
      })
      .execute();
  }

  /** Newest first, keyed by id so "load more" pages stay stable under writes. */
  async listAudit(
    options: { limit?: number; before?: number; licenseId?: string } = {},
  ): Promise<AuditRow[]> {
    let query = this.db.selectFrom("audit_log").selectAll() as any;
    if (options.before !== undefined) query = query.where("id", "<", options.before);
    if (options.licenseId) query = query.where("license_id", "=", options.licenseId);
    const rows = await query
      .orderBy("id", "desc")
      .limit(options.limit ?? 50)
      .execute();
    return (
      rows as Array<{
        id: number | string;
        at: string;
        actor: string;
        action: string;
        license_id: string | null;
        detail: string;
      }>
    ).map((row) => ({
      id: Number(row.id),
      at: row.at,
      actor: row.actor,
      action: row.action,
      licenseId: row.license_id,
      detail: parseJson<Record<string, unknown>>(row.detail, {}),
    }));
  }

  async backupTo(destPath: string): Promise<void> {
    if (!this.handle.sqlite) {
      throw new Error("Online backup is only available on SQLite deployments.");
    }
    await this.handle.sqlite.backup(destPath);
  }

  get supportsBackup(): boolean {
    return this.handle.sqlite !== null;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
