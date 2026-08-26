import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { ac, roles } from "./permissions";

// Same origin as the page — the Fastify process serves both the SPA and
// /api/auth/*, so no baseURL is needed.
//
// The admin plugin gets the role definitions so calls like setRole("support")
// type-check. They are not an authority: the console renders from the role the
// server reports (/admin/config → viewer.role), and the server refuses
// anything it should not allow regardless of what the browser believes.
export const authClient = createAuthClient({
  plugins: [adminClient({ ac, roles })],
});

export const { useSession, signIn, signOut, changePassword } = authClient;
