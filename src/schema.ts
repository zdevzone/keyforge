import type { Generated } from "kysely";

/**
 * The ledger's tables, typed for Kysely.
 *
 * Portability choices that keep one query set working on both SQLite and
 * Postgres:
 *  - timestamps are ISO-8601 **text**, not native date types, so comparisons
 *    and ordering behave identically on both (ISO strings sort correctly);
 *  - `entitlements` is JSON serialized to **text** rather than jsonb — the
 *    server never queries inside it, so a portable column beats a clever one.
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

export interface AuditLogTable {
  id: Generated<number>;
  at: string;
  actor: string;
  action: string;
  license_id: string | null;
  detail: string;
}

export interface Database {
  licenses: LicensesTable;
  activations: ActivationsTable;
  installations: InstallationsTable;
  audit_log: AuditLogTable;
}
