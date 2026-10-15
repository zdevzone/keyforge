import { createHash, randomBytes, randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";

import { type Entitlements } from "./config.js";
import {
  connectDatabase,
  type ConnectOptions,
  type DatabaseHandle,
  type Engine,
} from "./database.js";
import {
  newSupportReference,
  normalizeSignals,
  pickMatch,
  trialVerdict,
  MAX_GROUPS_PER_HASH,
  type MachineSignal,
  type SignalKind,
} from "./machines.js";
import { migrateToLatest } from "./migrations.js";
import type { Database } from "./schema.js";
import {
  newSupportRequestId,
  type NormalizedSupportRequest,
  type SupportCategory,
  type SupportUrgency,
} from "./support.js";

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

export interface SupportRequestRow {
  id: string;
  clientRequestId: string;
  licenseId: string;
  installationId: string;
  category: SupportCategory;
  urgency: SupportUrgency;
  subject: string;
  message: string;
  reporterName: string | null;
  appVersion: string | null;
  platform: string | null;
  status: "queued";
  clientCreatedAt: string;
  receivedAt: string;
  updatedAt: string;
}

/** Inbox rows deliberately omit the message; it is fetched only on detail. */
export type SupportRequestSummary = Omit<SupportRequestRow, "message">;

export interface SupportRequestQuery {
  category?: SupportCategory;
  urgency?: SupportUrgency;
  limit?: number;
  offset?: number;
}

export interface SupportRequestPage {
  requests: SupportRequestSummary[];
  total: number;
}

export type IngestSupportRequestResult =
  | { outcome: "created" | "replayed"; request: SupportRequestRow }
  | { outcome: "conflict" }
  | { outcome: "rate_limited"; retryAfter: number };

class SupportQuotaExceeded extends Error {
  constructor(readonly retryAfter: number) {
    super("Support request quota exceeded.");
  }
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

/** One machine in the trial ledger, as the support console shows it. */
export interface MachineGroupRow {
  id: string;
  supportReference: string;
  firstRegisteredAt: string;
  lastRegisteredAt: string;
  registrationCount: number;
  recheckCount: number;
  trialSpentReported: boolean;
  clearedAt: string | null;
  /**
   * What a registration matching this group would be told *right now*.
   *
   * Derived, not stored — the verdict only exists at registration time. The
   * console needs it because an operator who has just cleared a machine has no
   * other way to see that the clear landed, or that the customer has since used
   * it up.
   */
  trialState: "fresh" | "spent";
  installationIds: string[];
  signalKinds: SignalKind[];
}

export interface MachineQuery {
  /** Substring match against support reference, group id, or installation id. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface MachinePage {
  machines: MachineGroupRow[];
  total: number;
}

/** What a registration learned about the machine that made it. */
export interface TrialRegistration {
  group: MachineGroupRow;
  verdict: "fresh" | "spent";
  /** False when the group was created by this very call. */
  matched: boolean;
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

function mapSupportRequest(row: Database["support_requests"]): SupportRequestRow {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    licenseId: row.license_id,
    installationId: row.installation_id,
    category: row.category as SupportCategory,
    urgency: row.urgency as SupportUrgency,
    subject: row.subject,
    message: row.message,
    reporterName: row.reporter_name,
    appVersion: row.app_version,
    platform: row.platform,
    status: "queued",
    clientCreatedAt: row.client_created_at,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

function mapSupportRequestSummary(
  row: Omit<Database["support_requests"], "message">,
): SupportRequestSummary {
  return {
    id: row.id,
    clientRequestId: row.client_request_id,
    licenseId: row.license_id,
    installationId: row.installation_id,
    category: row.category as SupportCategory,
    urgency: row.urgency as SupportUrgency,
    subject: row.subject,
    reporterName: row.reporter_name,
    appVersion: row.app_version,
    platform: row.platform,
    status: "queued",
    clientCreatedAt: row.client_created_at,
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  };
}

function sameSupportContent(row: SupportRequestRow, request: NormalizedSupportRequest): boolean {
  return (
    row.category === request.category &&
    row.urgency === request.urgency &&
    row.subject === request.subject &&
    row.message === request.message &&
    row.reporterName === request.reporterName &&
    row.appVersion === request.appVersion &&
    row.platform === request.platform &&
    row.clientCreatedAt === request.clientCreatedAt
  );
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

  get sqlitePath(): string | null {
    return this.handle.sqlitePath;
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

  /**
   * Insert one support request and charge its fixed-window quota atomically.
   * Exact or conflicting duplicates never touch the quota, including when two
   * instances race on the same client UUID.
   */
  async ingestSupportRequest(input: {
    licenseId: string;
    installationId: string;
    request: NormalizedSupportRequest;
    now: Date;
    maxRequests: number;
    windowMs: number;
  }): Promise<IngestSupportRequestResult> {
    const windowStart = new Date(Math.floor(input.now.getTime() / input.windowMs) * input.windowMs);
    const retryAfter = Math.max(
      1,
      Math.ceil((windowStart.getTime() + input.windowMs - input.now.getTime()) / 1_000),
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.db.transaction().execute(async (trx) => {
          const findExisting = async () => {
            const row = await trx
              .selectFrom("support_requests")
              .selectAll()
              .where("license_id", "=", input.licenseId)
              .where("installation_id", "=", input.installationId)
              .where("client_request_id", "=", input.request.clientRequestId)
              .executeTakeFirst();
            return row ? mapSupportRequest(row) : null;
          };

          const receivedAt = input.now.toISOString();
          const inserted = await trx
            .insertInto("support_requests")
            .values({
              id: newSupportRequestId(input.now.getTime()),
              client_request_id: input.request.clientRequestId,
              license_id: input.licenseId,
              installation_id: input.installationId,
              category: input.request.category,
              urgency: input.request.urgency,
              subject: input.request.subject,
              message: input.request.message,
              reporter_name: input.request.reporterName,
              app_version: input.request.appVersion,
              platform: input.request.platform,
              status: "queued",
              client_created_at: input.request.clientCreatedAt,
              received_at: receivedAt,
              updated_at: receivedAt,
            })
            .onConflict((conflict) =>
              conflict.columns(["license_id", "installation_id", "client_request_id"]).doNothing(),
            )
            .returningAll()
            .executeTakeFirst();

          if (!inserted) {
            const raced = await findExisting();
            if (!raced || !sameSupportContent(raced, input.request)) {
              return { outcome: "conflict" as const };
            }
            return { outcome: "replayed" as const, request: raced };
          }

          const bucket = await sql<{ request_count: number | string }>`
          INSERT INTO support_rate_limit_buckets
            (license_id, installation_id, window_start, request_count)
          VALUES (
            ${input.licenseId}, ${input.installationId},
            ${windowStart.toISOString()}, 1
          )
          ON CONFLICT (license_id, installation_id, window_start)
          DO UPDATE SET request_count = support_rate_limit_buckets.request_count + 1
          WHERE support_rate_limit_buckets.request_count < ${input.maxRequests}
          RETURNING request_count
        `.execute(trx);
          if (bucket.rows.length === 0) throw new SupportQuotaExceeded(retryAfter);
          return { outcome: "created" as const, request: mapSupportRequest(inserted) };
        });
      } catch (error) {
        if (error instanceof SupportQuotaExceeded) {
          return { outcome: "rate_limited", retryAfter: error.retryAfter };
        }
        const code =
          typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
        if (this.engine === "sqlite" && code === "SQLITE_BUSY" && attempt < 2) {
          // Two processes can begin deferred SQLite transactions together and
          // deadlock while upgrading to the writer lock. One rolls back; a
          // short whole-transaction retry then observes the committed row.
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }
        throw error;
      }
    }
    throw new Error("Support ingestion retry budget exhausted.");
  }

  /** Operator inbox. Message bodies stay out of list reads and list responses. */
  async listSupportRequests(query: SupportRequestQuery = {}): Promise<SupportRequestPage> {
    const filters = (qb: any) => {
      let filtered = qb;
      if (query.category) filtered = filtered.where("category", "=", query.category);
      if (query.urgency) filtered = filtered.where("urgency", "=", query.urgency);
      return filtered;
    };

    const totalQuery = filters(
      this.db.selectFrom("support_requests").select((eb) => eb.fn.countAll().as("n")),
    );
    const total = toCount((await totalQuery.executeTakeFirst())?.n);

    let rowsQuery = filters(
      this.db
        .selectFrom("support_requests")
        .select([
          "id",
          "client_request_id",
          "license_id",
          "installation_id",
          "category",
          "urgency",
          "subject",
          "reporter_name",
          "app_version",
          "platform",
          "status",
          "client_created_at",
          "received_at",
          "updated_at",
        ]),
    ).orderBy("received_at", "desc");
    if (query.limit !== undefined) {
      rowsQuery = rowsQuery.limit(query.limit).offset(query.offset ?? 0);
    }
    const rows = await rowsQuery.execute();
    return {
      requests: rows.map((row: Omit<Database["support_requests"], "message">) =>
        mapSupportRequestSummary(row),
      ),
      total,
    };
  }

  async getSupportRequest(id: string): Promise<SupportRequestRow | null> {
    const row = await this.db
      .selectFrom("support_requests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapSupportRequest(row) : null;
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

  // ------------------------------------------------------------ trial ledger --

  /**
   * Record a registration and say whether this machine's trial is already gone.
   *
   * The verdict is read from the ledger's state *before* this call is counted,
   * so the first registration of a machine is always `fresh` and the second is
   * `spent`. Everything else here is bookkeeping for the support console.
   */
  async recordTrialRegistration(input: {
    installationId: string;
    machineSignals?: unknown;
    trialSpent?: boolean;
    recheck?: boolean;
    now?: Date;
  }): Promise<TrialRegistration> {
    const nowIso = (input.now ?? new Date()).toISOString();
    const signals = normalizeSignals(input.machineSignals);

    const matchedId = signals.length
      ? await this.findMatchingGroup(signals)
      : await this.findGroupByInstallation(input.installationId);
    // A group reached through the installation id is a filing cabinet, not a
    // match: signal-less registrations are always fresh, because the client
    // told us nothing that could identify the machine.
    const matched = signals.length > 0 && matchedId !== null;

    const existing = matchedId ? await this.readGroupState(matchedId) : null;
    const verdict = trialVerdict(matched ? existing : null);

    const groupId = matchedId ?? (await this.createGroup(nowIso));
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("machine_groups")
        .set({
          last_registered_at: nowIso,
          registration_count: sql`registration_count + 1` as never,
          ...(input.recheck === true ? { recheck_count: sql`recheck_count + 1` as never } : {}),
          // Sticky: a client that once reported a spent trial is evidence
          // forever, and a later registration that omits the flag is not a
          // retraction. Support evidence only — never read for the verdict.
          ...(input.trialSpent === true ? { trial_spent_reported: 1 } : {}),
        })
        .where("id", "=", groupId)
        .execute();

      for (const signal of signals) {
        await trx
          .insertInto("machine_signals")
          .values({
            group_id: groupId,
            kind: signal.kind,
            hash: signal.hash,
            first_seen_at: nowIso,
            last_seen_at: nowIso,
          })
          .onConflict((oc) =>
            oc.columns(["group_id", "kind", "hash"]).doUpdateSet({ last_seen_at: nowIso }),
          )
          .execute();
      }

      if (input.installationId) {
        await trx
          .insertInto("machine_installations")
          .values({
            group_id: groupId,
            installation_id: input.installationId,
            first_seen_at: nowIso,
          })
          .onConflict((oc) => oc.columns(["group_id", "installation_id"]).doNothing())
          .execute();
      }
    });

    const group = await this.getMachine(groupId);
    if (!group) throw new Error("Machine group did not persist");
    return { group, verdict, matched };
  }

  /**
   * The group these signals belong to, or null.
   *
   * Two passes on purpose. The first counts how many distinct groups each hash
   * appears in and drops the ones over MAX_GROUPS_PER_HASH — an identifier
   * shared by a cloned VM image or an OEM batch is not evidence of anything,
   * and left in it would fuse every install that has it into one machine. The
   * second scores what survives by distinct *kind*, which is what
   * src/machines.ts decides on.
   */
  private async findMatchingGroup(signals: MachineSignal[]): Promise<string | null> {
    const hashes = [...new Set(signals.map((signal) => signal.hash))];
    const rows = await this.db
      .selectFrom("machine_signals")
      .select(["group_id", "kind", "hash"])
      .where("hash", "in", hashes)
      .execute();

    const groupsPerHash = new Map<string, Set<string>>();
    for (const row of rows) {
      const seen = groupsPerHash.get(row.hash) ?? new Set<string>();
      seen.add(row.group_id);
      groupsPerHash.set(row.hash, seen);
    }

    // Only an exact (kind, hash) pair counts. The same hash arriving under a
    // different kind is a client bug or a probe, not corroboration.
    const wanted = new Set(signals.map((signal) => `${signal.kind}:${signal.hash}`));
    const kindsByGroup = new Map<string, Set<string>>();
    for (const row of rows) {
      if ((groupsPerHash.get(row.hash)?.size ?? 0) > MAX_GROUPS_PER_HASH) continue;
      if (!wanted.has(`${row.kind}:${row.hash}`)) continue;
      const kinds = kindsByGroup.get(row.group_id) ?? new Set<string>();
      kinds.add(row.kind);
      kindsByGroup.set(row.group_id, kinds);
    }
    if (kindsByGroup.size === 0) return null;

    const ages = await this.db
      .selectFrom("machine_groups")
      .select(["id", "first_registered_at"])
      .where("id", "in", [...kindsByGroup.keys()])
      .execute();

    return (
      pickMatch(
        ages.map((row) => ({
          groupId: row.id,
          matchingKinds: kindsByGroup.get(row.id)?.size ?? 0,
          firstRegisteredAt: row.first_registered_at,
        })),
      )?.groupId ?? null
    );
  }

  /**
   * Where a signal-less registration files itself.
   *
   * Not a match — it never changes the verdict — but without it every
   * registration from an installation that reports no signals would mint
   * another group, and the support console would fill with single-use rows.
   */
  private async findGroupByInstallation(installationId: string): Promise<string | null> {
    if (!installationId) return null;
    const row = await this.db
      .selectFrom("machine_installations")
      .select("group_id")
      .where("installation_id", "=", installationId)
      .orderBy("first_seen_at", "asc")
      .executeTakeFirst();
    return row?.group_id ?? null;
  }

  private async readGroupState(
    id: string,
  ): Promise<{ clearedAtCount: number | null; registrationCount: number } | null> {
    const row = await this.db
      .selectFrom("machine_groups")
      .select(["cleared_at_count", "registration_count"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      clearedAtCount: row.cleared_at_count === null ? null : Number(row.cleared_at_count),
      registrationCount: Number(row.registration_count),
    };
  }

  /**
   * A new machine, with a reference short enough to read down a phone line.
   *
   * Six characters collide about as often as never, but "about as often as
   * never" times every install is not zero, and the column is UNIQUE — so the
   * insert is retried rather than trusted.
   */
  private async createGroup(nowIso: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = `grp_${randomBytes(6).toString("hex")}`;
      try {
        await this.db
          .insertInto("machine_groups")
          .values({
            id,
            support_reference: newSupportReference(),
            first_registered_at: nowIso,
            last_registered_at: nowIso,
            registration_count: 0,
            recheck_count: 0,
            trial_spent_reported: 0,
            cleared_at: null,
            cleared_at_count: null,
          })
          .execute();
        return id;
      } catch (error) {
        if (attempt === 4) throw error;
      }
    }
    throw new Error("Could not allocate a machine support reference");
  }

  async getMachine(id: string): Promise<MachineGroupRow | null> {
    const row = await this.db
      .selectFrom("machine_groups")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return (await this.decorateMachines([row]))[0];
  }

  /**
   * Support's way in. `q` matches the reference the customer reads out, the
   * group id an operator copied from a previous answer, or an installation id
   * out of a log — whichever of the three they happen to be holding.
   */
  async listMachines(query: MachineQuery = {}): Promise<MachinePage> {
    const needle = query.q?.trim() || null;
    let ids: string[] | null = null;
    if (needle) {
      const hits = await this.db
        .selectFrom("machine_installations")
        .select("group_id")
        .where((eb) => matches(eb, "installation_id", needle))
        .execute();
      ids = [...new Set(hits.map((hit) => hit.group_id))];
    }
    const search = (eb: any) =>
      eb.or([
        matches(eb, "support_reference", needle as string),
        matches(eb, "id", needle as string),
        ...(ids && ids.length ? [eb("id", "in", ids)] : []),
      ]);

    let totalQuery = this.db
      .selectFrom("machine_groups")
      .select((eb) => eb.fn.countAll().as("n")) as any;
    if (needle) totalQuery = totalQuery.where(search);
    const total = toCount((await totalQuery.executeTakeFirst())?.n);

    let rowsQuery = this.db.selectFrom("machine_groups").selectAll() as any;
    if (needle) rowsQuery = rowsQuery.where(search);
    rowsQuery = rowsQuery.orderBy("first_registered_at", "desc");
    if (query.limit !== undefined) {
      rowsQuery = rowsQuery.limit(query.limit).offset(query.offset ?? 0);
    }
    return { machines: await this.decorateMachines(await rowsQuery.execute()), total };
  }

  /**
   * Attach each group's installation ids and signal kinds.
   *
   * Two extra queries for the whole page rather than an aggregate in SQL:
   * string_agg and group_concat are spelled differently on the two engines, and
   * a support listing is not the place to spend a portability exception.
   */
  private async decorateMachines(
    rows: {
      id: string;
      support_reference: string;
      first_registered_at: string;
      last_registered_at: string;
      registration_count: number;
      recheck_count: number;
      trial_spent_reported: number;
      cleared_at: string | null;
      cleared_at_count: number | null;
    }[],
  ): Promise<MachineGroupRow[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const [installations, signals] = await Promise.all([
      this.db
        .selectFrom("machine_installations")
        .select(["group_id", "installation_id"])
        .where("group_id", "in", ids)
        .orderBy("first_seen_at", "asc")
        .execute(),
      this.db
        .selectFrom("machine_signals")
        .select(["group_id", "kind"])
        .where("group_id", "in", ids)
        .execute(),
    ]);

    const byGroup = new Map<string, { installationIds: string[]; kinds: Set<string> }>();
    for (const id of ids) byGroup.set(id, { installationIds: [], kinds: new Set() });
    for (const row of installations)
      byGroup.get(row.group_id)?.installationIds.push(row.installation_id);
    for (const row of signals) byGroup.get(row.group_id)?.kinds.add(row.kind);

    return rows.map((row) => ({
      id: row.id,
      supportReference: row.support_reference,
      firstRegisteredAt: row.first_registered_at,
      lastRegisteredAt: row.last_registered_at,
      registrationCount: Number(row.registration_count),
      recheckCount: Number(row.recheck_count),
      // SQLite hands back 0/1 and Postgres hands back 0/1 too, since the column
      // is an integer on both — but the API says boolean, so it is one here.
      trialSpentReported: Number(row.trial_spent_reported) !== 0,
      clearedAt: row.cleared_at,
      // A group with no signals was recorded from a registration that reported
      // none, so nothing can ever match it — its trial is perpetually fresh,
      // and saying "spent" would send support looking for a problem.
      trialState:
        (byGroup.get(row.id)?.kinds.size ?? 0) === 0
          ? "fresh"
          : trialVerdict({
              clearedAtCount: row.cleared_at_count === null ? null : Number(row.cleared_at_count),
              registrationCount: Number(row.registration_count),
            }),
      installationIds: byGroup.get(row.id)?.installationIds ?? [],
      signalKinds: [...(byGroup.get(row.id)?.kinds ?? [])].sort() as SignalKind[],
    }));
  }

  /**
   * Give a machine its trial back. The next registration from it reads `fresh`;
   * the one after that is `spent` again — a clear is one more trial, not a
   * permanent exemption.
   */
  async clearMachine(id: string, now: Date = new Date()): Promise<MachineGroupRow | null> {
    const existing = await this.getMachine(id);
    if (!existing) return null;
    await this.db
      .updateTable("machine_groups")
      .set({ cleared_at: now.toISOString(), cleared_at_count: existing.registrationCount })
      .where("id", "=", id)
      .execute();
    return this.getMachine(id);
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
