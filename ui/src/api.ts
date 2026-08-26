/**
 * Typed access to the service's admin API. Shapes mirror the server's
 * LicenseRow / ActivationRow (src/db.ts) — duplicated deliberately, matching
 * the repo's convention of keeping independently deployed sides decoupled.
 */

export type EntitlementValue = number | string | boolean;
export type Entitlements = Record<string, EntitlementValue>;

export interface License {
  id: string;
  keyHash: string;
  plan: string;
  /** Vendor-defined key/value entitlements; the app consuming tokens interprets them. */
  entitlements: Entitlements;
  issuedTo: string;
  status: "active" | "revoked";
  activationLimit: number;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface Meta {
  name: string;
}

/** Public deployment identity (product name for the login page and titles). */
export function fetchMeta(): Promise<Meta> {
  return get("/api/meta");
}

export interface PlanPreset {
  entitlements: Entitlements;
  durationDays?: number;
  activationLimit?: number;
}

export type OperatorRole = "admin" | "support";

export type AdminFeature = "operators" | "sessions" | "bans" | "impersonation";

export interface AdminConfig {
  /** Who is asking, as the server sees them — drives what the console offers. */
  viewer: { actor: string; role: OperatorRole };
  /** Admin-plugin surfaces this deployment enables (config auth.admin). */
  adminScope: AdminFeature[];
  branding: { name: string };
  features: {
    audit: boolean;
    backups: boolean;
    /** False on Postgres, where snapshots come from pg_dump instead. */
    ledgerBackup: boolean;
    registry: boolean;
  };
  engine: "sqlite" | "postgres";
  licenses: {
    defaultPlan: string;
    defaultActivationLimit: number;
    planPresets: Record<string, PlanPreset>;
  };
  /** The public half of the signing key. The private key never leaves the server. */
  signingKey: { keyType: string; fingerprint: string; publicKeyPem: string };
}

export function fetchAdminConfig(): Promise<AdminConfig> {
  return get("/admin/config");
}

/** One entitlement key as it actually appears across the ledger. */
export interface EntitlementUsage {
  name: string;
  /** Every JS type seen for this key. More than one means the app enforces some and not others. */
  types: string[];
  licenseCount: number;
  activeLicenseCount: number;
  plans: string[];
  values: { value: string; count: number }[];
  moreValues: number;
}

export interface EntitlementCatalog {
  catalog: EntitlementUsage[];
  licensesScanned: number;
}

export function fetchEntitlementCatalog(): Promise<EntitlementCatalog> {
  return get("/admin/entitlements");
}

export interface Activation {
  licenseId: string;
  installationId: string;
  activatedAt: string;
  deactivatedAt: string | null;
}

/** What a license is right now, with expiry computed the way the server does. */
export type LiveStatus = "active" | "revoked" | "expired";

export function liveStatus(license: License, now = new Date()): LiveStatus {
  if (license.status === "revoked") return "revoked";
  if (license.expiresAt && now > new Date(license.expiresAt)) return "expired";
  return "active";
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const payload: Record<string, unknown> = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(payload.error ?? "request_failed"),
      String(payload.message ?? `Request failed with ${response.status}.`),
    );
  }
  return payload as T;
}

const get = request;

export interface LicenseListParams {
  q?: string;
  status?: LiveStatus;
  page?: number;
  pageSize?: number;
}

export interface LicensePage {
  licenses: License[];
  /** Rows matching q + status, for pagination. */
  total: number;
  /** Per-status counts over the q scope (ignoring the status filter). */
  counts: Record<LiveStatus, number>;
}

export function fetchLicenses(params: LicenseListParams = {}): Promise<LicensePage> {
  const pageSize = params.pageSize ?? 25;
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  search.set("limit", String(pageSize));
  search.set("offset", String((params.page ?? 0) * pageSize));
  return get(`/admin/licenses?${search.toString()}`);
}

export interface Installation {
  installationId: string;
  registeredAt: string;
  lastSeenAt: string;
  appVersion: string;
  platform: string;
  userName: string;
  userEmail: string;
  licenseId: string | null;
}

export interface InstallationPage {
  installations: Installation[];
  total: number;
  counts: { total: number; licensed: number; unlicensed: number; licensesIssued: number };
}

export function fetchInstallations(
  params: { q?: string; licensed?: boolean; page?: number; pageSize?: number } = {},
): Promise<InstallationPage> {
  const pageSize = params.pageSize ?? 25;
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.licensed !== undefined) search.set("licensed", params.licensed ? "yes" : "no");
  search.set("limit", String(pageSize));
  search.set("offset", String((params.page ?? 0) * pageSize));
  return get(`/admin/installations?${search.toString()}`);
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string;
  action: string;
  licenseId: string | null;
  detail: Record<string, unknown>;
}

export function fetchAudit(options: { before?: number; licenseId?: string } = {}): Promise<{
  entries: AuditEntry[];
  nextBefore: number | null;
}> {
  const search = new URLSearchParams();
  if (options.before !== undefined) search.set("before", String(options.before));
  if (options.licenseId) search.set("licenseId", options.licenseId);
  const suffix = search.size > 0 ? `?${search.toString()}` : "";
  return get(`/admin/audit${suffix}`);
}

export function fetchLicense(id: string): Promise<{ license: License }> {
  return get(`/admin/licenses/${encodeURIComponent(id)}`);
}

export function fetchActivations(id: string): Promise<{ activations: Activation[] }> {
  return get(`/admin/licenses/${encodeURIComponent(id)}/activations`);
}

export interface IssueLicenseInput {
  plan: string;
  entitlements: Entitlements;
  issuedTo: string;
  activationLimit: number;
  expiresAt: string | null;
}

/** The returned key exists only in this response — the server stores its hash. */
export function issueLicense(input: IssueLicenseInput): Promise<{ license: License; key: string }> {
  return request("/admin/licenses", { method: "POST", body: input });
}

export function updateLicense(
  id: string,
  input: Partial<
    Pick<IssueLicenseInput, "issuedTo" | "activationLimit" | "expiresAt" | "entitlements">
  >,
): Promise<{ license: License }> {
  return request(`/admin/licenses/${encodeURIComponent(id)}`, { method: "PATCH", body: input });
}

export function revokeLicense(id: string): Promise<{ license: License }> {
  return request(`/admin/licenses/${encodeURIComponent(id)}/revoke`, { method: "POST", body: {} });
}

export function releaseActivation(id: string, installationId: string): Promise<{ ok: boolean }> {
  return request(`/admin/licenses/${encodeURIComponent(id)}/deactivate`, {
    method: "POST",
    body: { installationId },
  });
}
