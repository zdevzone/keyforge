import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

/**
 * Operator roles for the admin console.
 *
 * Two roles, because two jobs exist:
 *  - `admin` runs the counter: issues, edits and revokes licenses, downloads
 *    backups, and manages the other operators.
 *  - `support` answers customers: reads everything and can release an
 *    activation (the "customer got a new laptop" transfer), but cannot mint or
 *    destroy licenses, and cannot touch operator accounts.
 *
 * Declaring them through Better Auth's access-control system rather than
 * relying on its implicit admin/user defaults is what makes `support` a role
 * the plugin will actually accept in `setRole`. The empty permission set is the
 * point: it is what stops a support operator from managing operators.
 *
 * Keyforge's *own* ledger rules (who may issue or revoke) are enforced
 * separately in app.ts — this file governs operator management only.
 */

export const OPERATOR_ROLES = ["admin", "support"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export function isOperatorRole(value: unknown): value is OperatorRole {
  return typeof value === "string" && (OPERATOR_ROLES as readonly string[]).includes(value);
}

export const ac = createAccessControl({ ...defaultStatements });

export const roles = {
  admin: ac.newRole({ ...adminAc.statements }),
  support: ac.newRole({ user: [], session: [] }),
};

/**
 * Admin-plugin surfaces a deployment can switch on, mapped to the endpoints
 * Better Auth mounts under /api/auth/admin/*. Paths were read from the plugin's
 * own endpoint table rather than guessed from method names.
 */
export const ADMIN_FEATURES = ["operators", "sessions", "bans", "impersonation"] as const;
export type AdminFeature = (typeof ADMIN_FEATURES)[number];

export const ADMIN_FEATURE_ENDPOINTS: Record<AdminFeature, string[]> = {
  operators: [
    "list-users",
    "get-user",
    "create-user",
    "update-user",
    "set-role",
    "set-user-password",
    "remove-user",
  ],
  sessions: ["list-user-sessions", "revoke-user-session", "revoke-user-sessions"],
  bans: ["ban-user", "unban-user"],
  impersonation: ["impersonate-user", "stop-impersonating"],
};

/** Permission checks are harmless and always answer, whatever the scope. */
const ALWAYS_ALLOWED_ADMIN_ENDPOINTS = new Set(["has-permission"]);

/**
 * Resolve `auth.admin` config into the set of enabled features.
 * "core" = manage operators and their sessions. "full" = everything.
 * An explicit array picks features by name; an unknown name is a startup
 * error, matching how the rest of the config fails closed rather than
 * silently dropping policy.
 */
export function resolveAdminFeatures(scope: "core" | "full" | string[]): Set<AdminFeature> {
  if (scope === "core") return new Set<AdminFeature>(["operators", "sessions"]);
  if (scope === "full") return new Set<AdminFeature>(ADMIN_FEATURES);
  const unknown = scope.filter((name) => !(ADMIN_FEATURES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown auth.admin feature(s): ${unknown.join(", ")}. ` +
        `Valid features are: ${ADMIN_FEATURES.join(", ")}.`,
    );
  }
  return new Set(scope as AdminFeature[]);
}

/**
 * Decide whether an /api/auth/admin/<endpoint> request may proceed. Endpoints
 * belonging to a disabled feature are refused before the plugin sees them, so
 * turning impersonation off actually turns it off rather than merely hiding a
 * button.
 */
export function isAdminEndpointEnabled(endpoint: string, enabled: Set<AdminFeature>): boolean {
  if (ALWAYS_ALLOWED_ADMIN_ENDPOINTS.has(endpoint)) return true;
  for (const feature of ADMIN_FEATURES) {
    if (ADMIN_FEATURE_ENDPOINTS[feature].includes(endpoint)) return enabled.has(feature);
  }
  // Unknown endpoints (a future plugin version) stay closed on purpose.
  return false;
}
