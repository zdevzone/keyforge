import type { Generated } from "kysely";

/** Current product-scoped v1 application schema, shared by SQLite and PostgreSQL. */
export interface Database {
  platform_records: { scope: string; kind: string; id: string; data: string; revision: number };
  platform_lock: { id: number; value: number };
  audit_log: {
    id: Generated<number>;
    at: string;
    actor: string;
    action: string;
    license_id: string | null;
    detail: string;
  };
}
