import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { sql, type Kysely } from "kysely";

import type { LicenseDatabase } from "./db.js";
import type { Database } from "./schema.js";

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export type RecordValue = { id: string; revision?: number };
export class Records {
  constructor(public db: Kysely<Database>) {}
  async get<T extends RecordValue>(scope: string, kind: string, id: string): Promise<T | null> {
    const row = await this.db
      .selectFrom("platform_records")
      .selectAll()
      .where("scope", "=", scope)
      .where("kind", "=", kind)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? ({ ...JSON.parse(row.data), revision: row.revision } as T) : null;
  }
  async list<T extends RecordValue>(scope: string, kind: string): Promise<T[]> {
    const rows = await this.db
      .selectFrom("platform_records")
      .selectAll()
      .where("scope", "=", scope)
      .where("kind", "=", kind)
      .orderBy("id")
      .execute();
    return rows.map((row) => ({ ...JSON.parse(row.data), revision: row.revision }) as T);
  }
  async put<T extends RecordValue>(scope: string, kind: string, value: T, expected?: number) {
    const prior = await this.get(scope, kind, value.id);
    if (expected !== undefined && prior?.revision !== expected)
      throw new DomainError("revision_conflict", "This record changed. Reload before saving.", 409);
    const revision = (prior?.revision ?? 0) + 1;
    await this.db
      .insertInto("platform_records")
      .values({
        scope,
        kind,
        id: value.id,
        data: JSON.stringify({ ...value, revision }),
        revision,
      })
      .onConflict((oc) =>
        oc.columns(["scope", "kind", "id"]).doUpdateSet({
          data: JSON.stringify({ ...value, revision }),
          revision,
        }),
      )
      .execute();
    return revision;
  }
}
/** Serialize decisions and writes across processes. SQLite acquires its write lock
 * before any reads; Postgres uses a transaction-scoped lock safe with poolers. */
export async function atomic<T>(
  database: LicenseDatabase,
  work: (records: Records) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await database.db.transaction().execute(async (trx) => {
        if (database.engine === "postgres")
          await sql`SELECT pg_advisory_xact_lock(4919071114)`.execute(trx);
        else await trx.updateTable("platform_lock").set({ value: 0 }).where("id", "=", 1).execute();
        return work(new Records(trx));
      });
    } catch (error) {
      if (attempt >= 6 || !/SQLITE_BUSY|database is locked/.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
export interface KeyRing {
  active: string;
  keys: Record<string, string>;
}
export class Vault {
  constructor(public ring?: KeyRing) {
    if (
      ring &&
      (!ring.keys[ring.active] || Object.values(ring.keys).some((k) => !/^[0-9a-f]{64}$/i.test(k)))
    )
      throw new Error("Encryption key ring requires an active id and 32-byte hexadecimal keys.");
  }
  encrypt(value: string, context: string): string {
    if (!this.ring)
      throw new DomainError(
        "encryption_unconfigured",
        "Configure LICENSE_DATA_KEYRING before storing keys.",
        503,
      );
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(this.ring.keys[this.ring.active], "hex"),
      iv,
    );
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return JSON.stringify({
      kid: this.ring.active,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
  }
  decrypt(value: string, context: string): string {
    const box = JSON.parse(value);
    const key = this.ring?.keys[box.kid];
    if (!key)
      throw new DomainError(
        "encryption_key_missing",
        "The encryption key required by this record is unavailable.",
        503,
      );
    const cipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "hex"),
      Buffer.from(box.iv, "base64"),
    );
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([cipher.update(Buffer.from(box.data, "base64")), cipher.final()]).toString(
      "utf8",
    );
  }
}
