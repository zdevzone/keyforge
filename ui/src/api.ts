/**
 * Typed access to the service's admin API. Shapes mirror the server's
 * LicenseRow / ActivationRow (src/db.ts) — duplicated deliberately, matching
 * the repo's convention of keeping independently deployed sides decoupled.
 */

export type EntitlementValue = number | string | boolean;
export type Entitlements = Record<string, EntitlementValue>;

export interface License {
  id: string;
  keyHash?: string;
  keyReference: string;
  keyStored: boolean;
  revision: number;
  productId: string;
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
  revision?: number;
  price: number | null;
  currency: "ETB";
  description?: string;
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
  signingKeys: {
    kid: string;
    keyType: string;
    fingerprint: string;
    publicKeyPem: string;
    retiredAt: string | null;
  }[];
}

export function fetchAdminConfig(): Promise<AdminConfig> {
  return Promise.all([get<AdminConfig>("/admin/config"), get<any>(productPath("/catalog"))]).then(
    ([config, catalog]) => ({
      ...config,
      signingKeys: catalog.product.keys.map((k: any) => ({
        ...k,
        keyType: "ed25519",
        fingerprint: k.kid,
      })),
      licenses: {
        ...config.licenses,
        defaultPlan: catalog.plans.find((p: any) => !p.archived)?.id ?? "",
        planPresets: Object.fromEntries(
          catalog.plans.filter((p: any) => !p.archived).map((p: any) => [p.id, p]),
        ),
      },
    }),
  );
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
  return get(productPath("/catalog")).then((c: any) => ({
    catalog: c.usage.map((u: any) => ({ ...u, values: [], moreValues: 0 })),
    licensesScanned: c.licensesScanned,
  }));
}

export interface DeviceSummary {
  machineGroups: { id: string; supportReference: string }[];
  signalKinds: string[];
  signalAvailability: "Available" | "Partial" | "Unavailable";
  signalsUpdatedAt?: string;
}
export interface Activation extends DeviceSummary {
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

export async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...init?.headers,
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
  return get(`${productPath("/licenses")}?${search.toString()}`);
}

export interface Installation extends DeviceSummary {
  activeLicense: boolean;
  licenses: {
    licenseId: string;
    keyReference: string;
    status: string;
    deactivatedAt: string | null;
  }[];
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
  return get(`${productPath("/installations")}?${search.toString()}`);
}

/**
 * One machine in the trial ledger, as /admin/machines returns it.
 *
 * A reported group is a recognition hint, not a verified physical computer.
 */
export interface Machine {
  id: string;
  /** Short and quotable; what the customer reads out to support. */
  supportReference: string;
  firstRegisteredAt: string;
  lastRegisteredAt: string;
  registrationCount: number;
  /** Registrations an operator asked for, so repeats are distinguishable. */
  recheckCount: number;
  /** The client's own claim that its trial is gone. Evidence, never a verdict. */
  trialSpentReported: boolean;
  clearedAt: string | null;
  /**
   * What a registration matching this machine would be told right now.
   * Derived server-side — it is how an operator sees that a clear landed.
   */
  trialState: "fresh" | "spent";
  installationIds: string[];
  signalKinds: string[];
  signalAvailability: DeviceSummary["signalAvailability"];
  signalsUpdatedAt?: string;
}

export interface MachinePage {
  machines: Machine[];
  total: number;
}

export function fetchMachines(
  params: { q?: string; page?: number; pageSize?: number } = {},
): Promise<MachinePage> {
  const pageSize = params.pageSize ?? 25;
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  search.set("limit", String(pageSize));
  search.set("offset", String((params.page ?? 0) * pageSize));
  return get(`${productPath("/machines")}?${search.toString()}`);
}

/** Grants exactly one more trial — the next registration is fresh, the one after is not. */
export function clearMachine(id: string): Promise<{
  machine: { id: string; clearedAt: string };
}> {
  return request(`${productPath("/machines")}/${encodeURIComponent(id)}/clear`, {
    method: "POST",
    body: {},
  });
}

export type SupportCategory = "technical" | "licensing" | "billing" | "feature_request" | "other";
export type SupportUrgency = "low" | "normal" | "high" | "critical";

export interface SupportRequestSummary {
  id: string;
  clientRequestId: string;
  licenseId: string;
  installationId: string;
  category: SupportCategory;
  urgency: SupportUrgency;
  subject: string;
  reporterName: string | null;
  appVersion: string | null;
  platform: string | null;
  status: "queued" | "in_progress" | "waiting_customer" | "resolved" | "closed";
  assignedTo: string | null;
  revision: number;
  messages: { id: string; author: string; body: string; internal: boolean; createdAt: string }[];
  clientCreatedAt: string;
  receivedAt: string;
  updatedAt: string;
}

export interface SupportRequest extends SupportRequestSummary {
  message: string;
}

export interface SupportRequestPage {
  requests: SupportRequestSummary[];
  total: number;
}

export function fetchSupportRequests(
  params: {
    category?: SupportCategory;
    urgency?: SupportUrgency;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<SupportRequestPage> {
  const pageSize = params.pageSize ?? 25;
  const search = new URLSearchParams();
  if (params.category) search.set("category", params.category);
  if (params.urgency) search.set("urgency", params.urgency);
  search.set("limit", String(pageSize));
  search.set("offset", String((params.page ?? 0) * pageSize));
  return get(`${productPath("/support")}?${search.toString()}`);
}

export function fetchSupportRequest(id: string): Promise<{ request: SupportRequest }> {
  return get(`${productPath("/support")}/${encodeURIComponent(id)}`);
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
  return get(`${productPath("/licenses")}/${encodeURIComponent(id)}`);
}

export function fetchActivations(id: string): Promise<{ activations: Activation[] }> {
  return get(`${productPath("/licenses")}/${encodeURIComponent(id)}/activations`);
}

export interface IssueLicenseInput {
  requestId: string;
  subjectKind?: "installation" | "service";
  plan: string;
  planRevision?: number;
  expectedPrice: number;
  issuedTo: string;
  installationId?: string;
  licenseRequestId?: string;
  payment?: { date: string; method: string; reference: string };
}
export interface IssuedLicense {
  license: License;
  key: string;
  sale: { id: string; amount: number; currency: string; status: string };
  delivery: { status: string; error: string | null };
}
export function issueLicense(input: IssueLicenseInput): Promise<IssuedLicense> {
  return request(productPath("/licenses"), { method: "POST", body: input });
}

export function updateLicense(
  id: string,
  input: Partial<
    Pick<License, "issuedTo" | "activationLimit" | "expiresAt" | "entitlements"> & {
      revision: number;
    }
  >,
): Promise<{ license: License }> {
  return request(`${productPath("/licenses")}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
  });
}

export function revokeLicense(id: string): Promise<{ license: License }> {
  return request(`${productPath("/licenses")}/${encodeURIComponent(id)}/revoke`, {
    method: "POST",
    body: {},
  });
}

export function releaseActivation(id: string, installationId: string): Promise<{ ok: boolean }> {
  return request(`${productPath("/licenses")}/${encodeURIComponent(id)}/deactivate`, {
    method: "POST",
    body: { installationId },
  });
}

export function productPath(path: string) {
  return (
    "/admin/products/" +
    encodeURIComponent(localStorage.getItem("keyforge-product") || "default") +
    path
  );
}
