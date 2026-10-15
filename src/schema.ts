import type { Generated } from "kysely";

/**
 * The ledger's tables, typed for Kysely.
 *
 * Portability choices that keep one query set working on both SQLite and
 * Postgres:
 *  - timestamps are ISO-8601 **text**, not native date types, so comparisons
 *    and ordering behave identically on both (ISO strings sort correctly);
 *  - `entitlements` is JSON serialized to **text** rather than jsonb — the
 *    server never queries inside it, so a portable column beats a clever one;
 *  - booleans are `integer` 0/1, because SQLite has no boolean type and a
 *    column that reads back as `1` on one engine and `true` on the other is a
 *    bug waiting for whichever engine the author did not develop against.
 */

export interface LicensesTable {
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
}

export interface ActivationsTable {
  license_id: string;
  installation_id: string;
  activated_at: string;
  deactivated_at: string | null;
}

export interface InstallationsTable {
  installation_id: string;
  registered_at: string;
  last_seen_at: string;
  app_version: string;
  platform: string;
  user_name: string;
  user_email: string;
  license_id: string | null;
}

/**
 * One physical machine, as far as the trial ledger can tell.
 *
 * Created by the first registration that cannot be matched to an existing
 * group, and thereafter the thing a `fresh`/`spent` verdict is about. Carries
 * no hardware identifiers itself — those live in `machine_signals`, one row per
 * hash, so a noisy identifier can be counted across groups without a scan.
 */
export interface MachineGroupsTable {
  id: string;
  /** Short and quotable; what a customer reads out to support. Unique. */
  support_reference: string;
  first_registered_at: string;
  last_registered_at: string;
  registration_count: number;
  /** Registrations the operator asked for, so repeats are distinguishable. */
  recheck_count: number;
  /** The client's own claim that its trial is gone. Evidence, never a verdict. */
  trial_spent_reported: number;
  /** Set by support; kept for the record even once the grant is used up. */
  cleared_at: string | null;
  /** registration_count at the moment of the clear. Equal = the grant is unused. */
  cleared_at_count: number | null;
}

export interface MachineSignalsTable {
  group_id: string;
  kind: string;
  /** SHA-256 of the identifier, lowercase hex. Never the identifier itself. */
  hash: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface MachineInstallationsTable {
  group_id: string;
  installation_id: string;
  first_seen_at: string;
}

export interface AuditLogTable {
  id: Generated<number>;
  at: string;
  actor: string;
  action: string;
  license_id: string | null;
  detail: string;
}

export interface SupportRequestsTable {
  id: string;
  client_request_id: string;
  license_id: string;
  installation_id: string;
  category: string;
  urgency: string;
  subject: string;
  message: string;
  reporter_name: string | null;
  app_version: string | null;
  platform: string | null;
  status: string;
  client_created_at: string;
  received_at: string;
  updated_at: string;
}

export interface SupportRateLimitBucketsTable {
  license_id: string;
  installation_id: string;
  window_start: string;
  request_count: number;
}

export interface Database {
  platform_records: {
    scope: string;
    kind: string;
    id: string;
    data: string;
    revision: number;
  };
  platform_lock: { id: number; value: number };
  licenses: LicensesTable;
  activations: ActivationsTable;
  installations: InstallationsTable;
  machine_groups: MachineGroupsTable;
  machine_signals: MachineSignalsTable;
  machine_installations: MachineInstallationsTable;
  audit_log: AuditLogTable;
  support_requests: SupportRequestsTable;
  support_rate_limit_buckets: SupportRateLimitBucketsTable;
}
