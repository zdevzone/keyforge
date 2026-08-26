import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";

/**
 * A mirror of the server's role definitions (src/permissions.ts).
 *
 * Duplicated rather than imported: the console is built separately from the
 * service and must not pull server modules into the browser bundle. These
 * imports are the client-safe ones Better Auth documents for exactly this.
 *
 * This exists for *typing* the admin client — so `setRole("support")` is a
 * legal call rather than a cast. It is never the authority on what an operator
 * may do; the server decides that, and refuses anything it should not allow.
 */

export const ac = createAccessControl({ ...defaultStatements });

export const roles = {
  admin: ac.newRole({ ...adminAc.statements }),
  support: ac.newRole({ user: [], session: [] }),
};
