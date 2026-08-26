import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { fetchAudit, type AuditEntry } from "../api";
import { Button, Card, ErrorNote, Spinner, formatDateTime } from "../components";

const actionLabels: Record<string, string> = {
  "license.issue": "issued license",
  "license.update": "updated license",
  "license.revoke": "revoked license",
  "activation.release": "released activation",
  "backup.download": "downloaded backup",
  "operator.create": "added operator",
  "operator.update": "updated operator",
  "operator.role": "changed operator role",
  "operator.password": "set operator password",
  "operator.remove": "removed operator",
  "operator.ban": "banned operator",
  "operator.unban": "unbanned operator",
  "operator.session.revoke": "revoked a session",
  "operator.session.revoke_all": "revoked all sessions",
  "operator.impersonate": "impersonated operator",
};

function detailSummary(entry: AuditEntry): string {
  const parts = Object.entries(entry.detail)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value === null ? "—" : String(value)}`);
  return parts.join(" · ");
}

export default function Audit() {
  const { data, error, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["audit"],
      queryFn: ({ pageParam }) => fetchAudit(pageParam ? { before: pageParam } : {}),
      initialPageParam: 0,
      getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
    });

  if (isPending) return <Spinner label="Loading audit log…" />;
  if (error) return <ErrorNote message={(error as Error).message} />;

  const entries = data.pages.flatMap((page) => page.entries);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every admin action, newest first. Console operators appear by email; the CLI's shared
          bearer token can only say "cli".
        </p>
      </div>

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3 font-medium">When</th>
              <th className="px-5 py-3 font-medium">Who</th>
              <th className="px-5 py-3 font-medium">Action</th>
              <th className="px-5 py-3 font-medium">License</th>
              <th className="px-5 py-3 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <tr key={entry.id} className="align-top">
                <td className="px-5 py-3 whitespace-nowrap">{formatDateTime(entry.at)}</td>
                <td className="px-5 py-3">{entry.actor}</td>
                <td className="px-5 py-3 whitespace-nowrap">
                  {actionLabels[entry.action] ?? entry.action}
                </td>
                <td className="px-5 py-3">
                  {entry.licenseId ? (
                    <Link
                      to={`/licenses/${entry.licenseId}`}
                      className="font-mono text-xs underline"
                    >
                      {entry.licenseId.slice(0, 8)}…
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-5 py-3 text-xs text-slate-500">{detailSummary(entry)}</td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-slate-400">
                  Nothing recorded yet — admin actions land here as they happen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {hasNextPage && (
          <div className="border-t border-slate-200 px-5 py-3 text-center">
            <Button
              variant="secondary"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
