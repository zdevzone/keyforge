import type { LicenseToken, TrialToken } from "./tokens.js";

export const DEVICE_SIGNAL_KINDS = [
  "machine-guid",
  "smbios-uuid",
  "volume-serial",
  "linux-machine-id",
  "macos-platform-uuid",
  "root-volume-uuid",
] as const;
export type DeviceSignalKind = (typeof DEVICE_SIGNAL_KINDS)[number];
export interface DeviceSignal {
  kind: DeviceSignalKind;
  hash: string;
}
export interface DeviceSignalsReport {
  signals: DeviceSignal[];
  diagnostics: {
    kind: DeviceSignalKind;
    status:
      | "available"
      | "unavailable"
      | "invalid"
      | "timeout"
      | "permission_denied"
      | "unsupported"
      | "query_failed";
  }[];
}
export type DeviceSignalsProvider = (context: {
  serverUrl: string;
  productId: string;
}) => Promise<DeviceSignalsReport>;

export interface RegistrationMetadata {
  appVersion?: string;
  platform?: string;
  userName?: string;
  userEmail?: string;
  machineSignals?: DeviceSignal[];
}
export interface ClientState {
  version: 1;
  serverUrl: string;
  productId: string;
  subjectKind: "installation" | "service";
  installationId: string;
  credential: string;
  registration: RegistrationMetadata & { installationId: string; requestId: string };
  registered: boolean;
  trialStarted: boolean;
  trialConsumed: number;
  trialToken: string | null;
  licenseToken: string | null;
  denial: string | null;
  lastObservedTime: number;
  deviceSignals?: DeviceSignalsReport;
}
/** One owner per installation. load returns a snapshot; save atomically replaces it.
 * Production implementations must protect credentials using platform secure storage. */
export interface SecureStorage {
  load(): Promise<ClientState | null>;
  save(state: ClientState): Promise<void>;
}
export type Authorization =
  | { state: "unlicensed"; reason: string }
  | { state: "trial"; token: TrialToken; remaining: number | null }
  | {
      state: "licensed";
      token: LicenseToken;
      entitlements: LicenseToken["entitlements"];
      deadline: string;
    }
  | { state: "reconnect_required" | "expired" | "revoked"; reason: string };
export interface NotificationPreferences {
  messages: boolean;
  expirations: boolean;
}
export type CustomerNotification = {
  id: string;
  title: string;
  date: string;
  read: boolean;
} & (
  | { kind: "reply"; ticketId: string }
  | { kind: "expiration"; licenseId: string }
  | {
      kind: "license";
      licenseId: string;
      deliveryStatus: "available" | "retrieved" | "failed" | "manual";
      collectPath: string;
    }
);
export interface CustomerThread {
  id: string;
  revision: number;
  licenseId: string;
  installationId: string;
  clientRequestId: string;
  category: SupportRequest["category"];
  urgency: SupportRequest["urgency"];
  subject: string;
  message: string;
  status: "queued" | "in_progress" | "waiting_customer" | "resolved" | "closed";
  receivedAt: string;
  updatedAt: string;
  messages: {
    id: string;
    author: "customer" | "support";
    internal: false;
    body: string;
    createdAt: string;
  }[];
}
export interface SupportRequest {
  requestId: string;
  licenseId: string;
  category: "technical" | "licensing" | "billing" | "feature_request" | "other";
  urgency: "low" | "normal" | "high" | "critical";
  subject: string;
  message: string;
  createdAt: string;
  reporter?: { name?: string };
  app?: { version?: string; platform?: string };
}
export interface ValidationResult {
  valid: true;
  id: string;
  plan: string;
  issuedTo: string;
  expiresAt: string | null;
  entitlements: Record<string, string | number | boolean>;
  seatsInUse: number;
  seatsAvailable: number;
  serverTime: string;
}
