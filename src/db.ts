import { createHash, randomBytes, randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";

import { type Entitlements } from "./config.js";
import {
  connectDatabase,
  type ConnectOptions,
  type DatabaseHandle,
  type Engine,
} from "./database.js";
import { migrateToLatest } from "./migrations.js";
import type { Database } from "./schema.js";

/**
 * The vendor's ledger: which keys exist, what they entitle, where each one is
 * activated, which installations exist, and what operators did. This is the
 * source of truth for activation, limits, transfers and revocation — and for
 * nothing else. Usage (how much of an entitlement a customer has consumed)
 * never comes here; the vendor's own app is authoritative for that, by design.
 *
 * Runs on SQLite or Postgres through Kysely; see database.ts for selection.
 */

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

export interface ActivationRow {
  licenseId: string;
  installationId: string;
  activatedAt: string;
  deactivatedAt: string | null;
}

/**
 * One installed copy of the app, licensed or not. The installer registers
 * every install, so this table is the census the activations table alone
 * cannot be: installs vs. licenses actually issued.
 */
export interface InstallationRow {
  installationId: string;
  registeredAt: string;
  lastSeenAt: string;
  appVersion: string;
  platform: string;
  userName: string;
  userEmail: string;
  licenseId: string | null;
}

/**
 * One admin action, as it happened: who (operator email, or "cli" for the
 * bearer token, which names no one), what, to which license. Append-only —
 * there is deliberately no update or delete path.
 */
export interface AuditRow {
  id: number;
  at: string;
  actor: string;
  action: string;
  licenseId: string | null;
  detail: Record<string, unknown>;
}

export type LiveLicenseStatus = "active" | "expired" | "revoked";

export interface LicenseQuery {
  /** Substring match against issued_to, plan, or id. */
  q?: string;
  status?: LiveLicenseStatus;
  /** Absent limit returns everything — the CLI's list depends on that. */
  limit?: number;
  offset?: number;
  now?: Date;
}

export interface LicensePage {
  licenses: LicenseRow[];
  /** Row count for the q + status scope, for pagination. */
  total: number;
  /** Per-status counts over the q scope (ignoring the status filter). */
  counts: Record<LiveLicenseStatus, number>;
}

export interface InstallationQuery {
  /** Substring match against installation id, user name, email, or platform. */
  q?: string;
  /** true = only installs holding a license; false = only unlicensed. */
  licensed?: boolean;
  limit?: number;
  offset?: number;
}

export interface InstallationPage {
  installations: InstallationRow[];
  total: number;
  counts: { total: number; licensed: number; unlicensed: number; licensesIssued: number };
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

/** One entitlement key as it actually appears across the ledger. */
export interface EntitlementUsage {
  name: string;
  /** Every JS type observed for this key. More than one is a bug worth seeing. */
  types: string[];
  licenseCount: number;
  /** Licenses that are neither revoked nor expired. */
  activeLicenseCount: number;
  plans: string[];
  values: { value: string; count: number }[];
  /** Distinct values beyond those listed, so a capped list never reads as whole. */
  moreValues: number;
}

export interface EntitlementCatalog {
  catalog: EntitlementUsage[];
  licensesScanned: number;
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

/** Postgres returns bigint counts as strings; SQLite returns numbers. */
function toCount(value: unknown): number {
  return Number(value ?? 0);
}

/**
 * Case-insensitive substring match that means the same thing on both engines.
 * SQLite's LIKE ignores ASCII case, Postgres' does not — searching "acme"
 * would silently find nothing on Postgres — so both sides are lowered here
 * rather than relying on either engine's default.
 */
function matches(eb: any, column: string, needle: string) {
  return eb(sql`lower(${sql.ref(column)})`, "like", `%${needle.toLowerCase()}%`);
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
    await migrateToLatest(handle.db, handle.engine);
    return new LicenseDatabase(handle);
  }

  get db(): Kysely<Database> {
    return this.handle.db;
  }

  get engine(): Engine {
    return this.handle.engine;
  }

  /** Live status computed in SQL, so filtering and counting stay in the database. */
  private liveStatus(nowIso: string) {
    return sql<LiveLicenseStatus>`CASE
      WHEN status = 'revoked' THEN 'revoked'
      WHEN expires_at IS NOT NULL AND expires_at < ${nowIso} THEN 'expired'
      ELSE 'active'
    END`;
  }

  private toLicense(row: {
    id: string;
    key_hash: string;
    plan: string;
    entitlements: string;
    issued_to: string;
    status: string;
    activation_limit: number;
    issued_at: string;
    expires_at: string | null;
    revoked_at: string | null;
  }): LicenseRow {
    return {
      id: row.id,
      keyHash: row.key_hash,
      plan: row.plan,
      entitlements: parseJson<Entitlements>(row.entitlements, {}),
      issuedTo: row.issued_to,
      status: row.status as LicenseServerStatus,
      activationLimit: Number(row.activation_limit),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    };
  }

  async createLicense(input: {
    plan: string;
    entitlements?: Entitlements;
    issuedTo?: string;
    activationLimit?: number;
    expiresAt?: string | null;
    keyFormat?: KeyFormat;
  }): Promise<{ license: LicenseRow; key: string }> {
    const key = generateProductKey(input.keyFormat);
    const id = randomUUID();
    await this.db
      .insertInto("licenses")
      .values({
        id,
        key_hash: hashProductKey(key),
        plan: input.plan,
        entitlements: JSON.stringify(input.entitlements ?? {}),
        issued_to: input.issuedTo ?? "",
        status: "active",
        activation_limit: input.activationLimit ?? 1,
        issued_at: new Date().toISOString(),
        expires_at: input.expiresAt ?? null,
        revoked_at: null,
      })
      .execute();
    const license = await this.getLicense(id);
    if (!license) throw new Error("License insert did not persist");
    return { license, key };
  }

  async getLicense(id: string): Promise<LicenseRow | null> {
    const row = await this.db
      .selectFrom("licenses")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.toLicense(row) : null;
  }

  async findByKey(key: string): Promise<LicenseRow | null> {
    const row = await this.db
      .selectFrom("licenses")
      .selectAll()
      .where("key_hash", "=", hashProductKey(key))
      .executeTakeFirst();
    return row ? this.toLicense(row) : null;
  }

  async listLicenses(query: LicenseQuery = {}): Promise<LicensePage> {
    const nowIso = (query.now ?? new Date()).toISOString();
    const needle = query.q?.trim() || null;
    const search = (eb: any) =>
      eb.or([
        matches(eb, "issued_to", needle as string),
        matches(eb, "plan", needle as string),
        matches(eb, "id", needle as string),
      ]);

    // Counts cover the search scope but ignore the status filter, so the
    // console's summary cards stay stable while the user switches tabs.
    let countQuery = this.db
      .selectFrom("licenses")
      .select((eb) => [this.liveStatus(nowIso).as("live_status"), eb.fn.countAll().as("n")])
      .groupBy("live_status") as any;
    if (needle) countQuery = countQuery.where(search);
    const counts: Record<LiveLicenseStatus, number> = { active: 0, expired: 0, revoked: 0 };
    for (const row of (await countQuery.execute()) as Array<{
      live_status: LiveLicenseStatus;
      n: unknown;
    }>) {
      counts[row.live_status] = toCount(row.n);
    }

    let rowsQuery = this.db.selectFrom("licenses").selectAll() as any;
    if (needle) rowsQuery = rowsQuery.where(search);
    if (query.status) rowsQuery = rowsQuery.where(this.liveStatus(nowIso), "=", query.status);
    rowsQuery = rowsQuery.orderBy("issued_at", "desc");
    if (query.limit !== undefined) {
      rowsQuery = rowsQuery.limit(query.limit).offset(query.offset ?? 0);
    }
    const rows = await rowsQuery.execute();

    let total = counts.active + counts.expired + counts.revoked;
    if (query.status) {
      let totalQuery = this.db
        .selectFrom("licenses")
        .select((eb) => eb.fn.countAll().as("n")) as any;
      if (needle) totalQuery = totalQuery.where(search);
      totalQuery = totalQuery.where(this.liveStatus(nowIso), "=", query.status);
      total = toCount((await totalQuery.executeTakeFirst())?.n);
    }

    return {
      licenses: (rows as Parameters<LicenseDatabase["toLicense"]>[0][]).map((row) =>
        this.toLicense(row),
      ),
      total,
      counts,
    };
  }

  /**
   * Support edits: transfer to a new name, extend or clear expiry, change the
   * seat limit, adjust entitlements. A field left undefined stays as it is;
   * `expiresAt: null` clears the expiry. Status and the key hash are
   * deliberately not editable — revocation has its own verb, and a key can
   * never be re-pointed.
   */
  async updateLicense(
    id: string,
    input: {
      issuedTo?: string;
      activationLimit?: number;
      expiresAt?: string | null;
      entitlements?: Entitlements;
    },
  ): Promise<LicenseRow | null> {
    const patch: Record<string, unknown> = {};
    if (input.issuedTo !== undefined) patch.issued_to = input.issuedTo;
    if (input.activationLimit !== undefined) patch.activation_limit = input.activationLimit;
    if (input.expiresAt !== undefined) patch.expires_at = input.expiresAt;
    if (input.entitlements !== undefined) patch.entitlements = JSON.stringify(input.entitlements);
    if (Object.keys(patch).length > 0) {
      await this.db
        .updateTable("licenses")
        .set(patch as never)
        .where("id", "=", id)
        .execute();
    }
    return this.getLicense(id);
  }

  async revokeLicense(id: string): Promise<LicenseRow | null> {
    await this.db
      .updateTable("licenses")
      .set({ status: "revoked", revoked_at: new Date().toISOString() })
      .where("id", "=", id)
      .execute();
    return this.getLicense(id);
  }

  async listActivations(licenseId: string): Promise<ActivationRow[]> {
    const rows = await this.db
      .selectFrom("activations")
      .selectAll()
      .where("license_id", "=", licenseId)
      .orderBy("activated_at")
      .execute();
    return rows.map((row) => ({
      licenseId: row.license_id,
      installationId: row.installation_id,
      activatedAt: row.activated_at,
      deactivatedAt: row.deactivated_at,
    }));
  }

  async activeActivationCount(licenseId: string): Promise<number> {
    const row = await this.db
      .selectFrom("activations")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("license_id", "=", licenseId)
      .where("deactivated_at", "is", null)
      .executeTakeFirst();
    return toCount(row?.n);
  }

  async getActivation(licenseId: string, installationId: string): Promise<ActivationRow | null> {
    const row = await this.db
      .selectFrom("activations")
      .selectAll()
      .where("license_id", "=", licenseId)
      .where("installation_id", "=", installationId)
      .executeTakeFirst();
    if (!row) return null;
    return {
      licenseId: row.license_id,
      installationId: row.installation_id,
      activatedAt: row.activated_at,
      deactivatedAt: row.deactivated_at,
    };
  }

  /** Insert a fresh binding, or clear the deactivation on a returning one. */
  async bindActivation(licenseId: string, installationId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("activations")
      .values({
        license_id: licenseId,
        installation_id: installationId,
        activated_at: now,
        deactivated_at: null,
      })
      .onConflict((oc) =>
        oc.columns(["license_id", "installation_id"]).doUpdateSet({
          activated_at: now,
          deactivated_at: null,
        }),
      )
      .execute();
  }

  async releaseActivation(licenseId: string, installationId: string): Promise<void> {
    await this.db
      .updateTable("activations")
      .set({ deactivated_at: new Date().toISOString() })
      .where("license_id", "=", licenseId)
      .where("installation_id", "=", installationId)
      .where("deactivated_at", "is", null)
      .execute();
  }

  private toInstallation(row: {
    installation_id: string;
    registered_at: string;
    last_seen_at: string;
    app_version: string;
    platform: string;
    user_name: string;
    user_email: string;
    license_id: string | null;
  }): InstallationRow {
    return {
      installationId: row.installation_id,
      registeredAt: row.registered_at,
      lastSeenAt: row.last_seen_at,
      appVersion: row.app_version,
      platform: row.platform,
      userName: row.user_name,
      userEmail: row.user_email,
      licenseId: row.license_id,
    };
  }

  /**
   * Insert a fresh install, or refresh a returning one. Re-registration (a
   * reinstall) updates whatever the installer sent and bumps last_seen, but an
   * empty field never erases what an earlier registration reported.
   */
  async registerInstallation(input: {
    installationId: string;
    appVersion?: string;
    platform?: string;
    userName?: string;
    userEmail?: string;
  }): Promise<InstallationRow> {
    const now = new Date().toISOString();
    const keep = (column: string, incoming: string) =>
      incoming === "" ? sql.raw(column) : sql`${incoming}`;
    await this.db
      .insertInto("installations")
      .values({
        installation_id: input.installationId,
        registered_at: now,
        last_seen_at: now,
        app_version: input.appVersion ?? "",
        platform: input.platform ?? "",
        user_name: input.userName ?? "",
        user_email: input.userEmail ?? "",
        license_id: null,
      })
      .onConflict((oc) =>
        oc.column("installation_id").doUpdateSet({
          last_seen_at: now,
          app_version: keep("installations.app_version", input.appVersion ?? "") as never,
          platform: keep("installations.platform", input.platform ?? "") as never,
          user_name: keep("installations.user_name", input.userName ?? "") as never,
          user_email: keep("installations.user_email", input.userEmail ?? "") as never,
        }),
      )
      .execute();
    const row = await this.db
      .selectFrom("installations")
      .selectAll()
      .where("installation_id", "=", input.installationId)
      .executeTakeFirstOrThrow();
    return this.toInstallation(row);
  }

  /**
   * Called on activation. An installation that skipped the installer's
   * registration (an old build, a blocked request) still earns a census row
   * here rather than staying invisible.
   */
  async linkInstallationToLicense(installationId: string, licenseId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .insertInto("installations")
      .values({
        installation_id: installationId,
        registered_at: now,
        last_seen_at: now,
        app_version: "",
        platform: "",
        user_name: "",
        user_email: "",
        license_id: licenseId,
      })
      .onConflict((oc) =>
        oc.column("installation_id").doUpdateSet({ license_id: licenseId, last_seen_at: now }),
      )
      .execute();
  }

  /** Refresh check-ins keep last_seen honest without touching anything else. */
  async touchInstallation(installationId: string): Promise<void> {
    await this.db
      .updateTable("installations")
      .set({ last_seen_at: new Date().toISOString() })
      .where("installation_id", "=", installationId)
      .execute();
  }

  async listInstallations(query: InstallationQuery = {}): Promise<InstallationPage> {
    const needle = query.q?.trim() || null;
    const search = (eb: any) =>
      eb.or([
        matches(eb, "installation_id", needle as string),
        matches(eb, "user_name", needle as string),
        matches(eb, "user_email", needle as string),
        matches(eb, "platform", needle as string),
      ]);

    let censusQuery = this.db
      .selectFrom("installations")
      .select((eb) => [
        eb.fn.countAll().as("total"),
        eb.fn.sum(sql<number>`CASE WHEN license_id IS NOT NULL THEN 1 ELSE 0 END`).as("licensed"),
      ]) as any;
    if (needle) censusQuery = censusQuery.where(search);
    const census = await censusQuery.executeTakeFirst();
    const censusTotal = toCount(census?.total);
    const licensed = toCount(census?.licensed);

    const issued = await this.db
      .selectFrom("licenses")
      .select((eb) => eb.fn.countAll().as("n"))
      .executeTakeFirst();

    let rowsQuery = this.db.selectFrom("installations").selectAll() as any;
    if (needle) rowsQuery = rowsQuery.where(search);
    if (query.licensed !== undefined) {
      rowsQuery = query.licensed
        ? rowsQuery.where("license_id", "is not", null)
        : rowsQuery.where("license_id", "is", null);
    }
    rowsQuery = rowsQuery.orderBy("registered_at", "desc");
    if (query.limit !== undefined) {
      rowsQuery = rowsQuery.limit(query.limit).offset(query.offset ?? 0);
    }
    const rows = await rowsQuery.execute();

    let total = censusTotal;
    if (query.licensed !== undefined) {
      let totalQuery = this.db
        .selectFrom("installations")
        .select((eb) => eb.fn.countAll().as("n")) as any;
      if (needle) totalQuery = totalQuery.where(search);
      totalQuery = query.licensed
        ? totalQuery.where("license_id", "is not", null)
        : totalQuery.where("license_id", "is", null);
      total = toCount((await totalQuery.executeTakeFirst())?.n);
    }

    return {
      installations: (rows as Parameters<LicenseDatabase["toInstallation"]>[0][]).map((row) =>
        this.toInstallation(row),
      ),
      total,
      counts: {
        total: censusTotal,
        licensed,
        unlicensed: censusTotal - licensed,
        licensesIssued: toCount(issued?.n),
      },
    };
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

  /**
   * Every entitlement key the ledger actually contains, with how it is used.
   *
   * Entitlements are free-form by design — `Record<string, number|string|bool>`
   * — which means nothing stops `seats` on one license and `seat` or `Seats` on
   * the next. The app enforcing `seats` ignores the others silently, so the
   * license looks issued and the customer is missing what they paid for. This
   * is the query that makes that visible.
   *
   * Aggregated in JS rather than SQL: SQLite's `json_each` and Postgres's
   * `jsonb_each` are different functions with different semantics, and one code
   * path correct on both beats two that drift — the same reasoning that keeps
   * ordering out of SQL in src/replica.ts. It reads one narrow projection of
   * the licenses table, not whole rows.
   */
  async entitlementCatalog(options: { valueLimit?: number } = {}): Promise<EntitlementCatalog> {
    const valueLimit = options.valueLimit ?? 10;
    const rows = await this.db
      .selectFrom("licenses")
      .select(["plan", "status", "entitlements", "expires_at"])
      .execute();

    const now = new Date();
    const entries = new Map<
      string,
      {
        types: Set<string>;
        licenseCount: number;
        activeLicenseCount: number;
        plans: Set<string>;
        values: Map<string, number>;
      }
    >();

    for (const row of rows) {
      const entitlements = parseJson<Entitlements>(row.entitlements as string, {});
      // "Active" here matches what the API reports, expiry included — an
      // entitlement only present on expired licenses is not in play any more.
      const expired = row.expires_at !== null && new Date(row.expires_at as string) < now;
      const live = row.status === "active" && !expired;

      for (const [name, value] of Object.entries(entitlements)) {
        let entry = entries.get(name);
        if (!entry) {
          entry = {
            types: new Set(),
            licenseCount: 0,
            activeLicenseCount: 0,
            plans: new Set(),
            values: new Map(),
          };
          entries.set(name, entry);
        }
        entry.types.add(typeof value);
        entry.licenseCount += 1;
        if (live) entry.activeLicenseCount += 1;
        entry.plans.add(String(row.plan));
        const rendered = String(value);
        entry.values.set(rendered, (entry.values.get(rendered) ?? 0) + 1);
      }
    }

    const catalog = [...entries.entries()]
      .map(([name, entry]) => {
        const sorted = [...entry.values.entries()].sort(
          (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
        );
        return {
          name,
          types: [...entry.types].sort(),
          licenseCount: entry.licenseCount,
          activeLicenseCount: entry.activeLicenseCount,
          plans: [...entry.plans].sort(),
          values: sorted.slice(0, valueLimit).map(([value, count]) => ({ value, count })),
          // Stated rather than implied: a truncated list that looks complete is
          // worse than one that says how much it is hiding.
          moreValues: Math.max(0, sorted.length - valueLimit),
        };
      })
      // Byte-wise, so the order is identical on both engines regardless of the
      // database's collation.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return { catalog, licensesScanned: rows.length };
  }

  /**
   * Write a consistent snapshot to destPath via SQLite's online backup API —
   * safe under WAL and concurrent writes, unlike copying the file. Postgres
   * deployments back up with their own tooling (pg_dump), so this refuses
   * rather than pretending.
   */
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
