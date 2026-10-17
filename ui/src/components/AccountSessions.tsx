import { useQuery } from "@tanstack/react-query";

import { authClient } from "../auth-client";
import { Card, Button } from "../components";
import { useAction, Feedback } from "../platform-ui";
import { useListPage, ListPagination } from "./ListPagination";
export function AccountSessions() {
  const action = useAction();
  const sessions = useQuery({
    queryKey: ["own-sessions"],
    queryFn: async () => {
      const result = await authClient.listSessions();
      if (result.error) throw new Error(result.error.message);
      return result.data || [];
    },
  });

  const list = useListPage(sessions.data ?? []);
  return (
    <Card className="p-6">
      <h2 className="font-semibold">Your sessions</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Review active sessions and revoke access from another device.
      </p>
      {sessions.error && (
        <p role="alert" className="text-destructive">
          {(sessions.error as Error).message}
        </p>
      )}
      <ul className="mt-4 divide-y divide-slate-200">
        {list.rows.map((s: any) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm">{s.userAgent || "Unknown browser"}</p>
              <p className="text-xs text-muted-foreground">
                {s.ipAddress || "No IP recorded"} · {new Date(s.createdAt).toLocaleString()}
              </p>
            </div>
            <Button
              variant="secondary"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const result = await authClient.revokeSession({ token: s.token });
                  if (result.error) throw new Error(result.error.message);
                  await sessions.refetch();
                }, "Session revoked.")
              }
            >
              Revoke session
            </Button>
          </li>
        ))}
      </ul>
      <ListPagination {...list} />
      <Feedback action={action} />
    </Card>
  );
}
