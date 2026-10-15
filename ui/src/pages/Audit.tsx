import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchAudit, type AuditEntry } from "../api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components";
import { Card, ErrorNote, Spinner, formatDateTime } from "../components";
import { PageNavigation as Pagination } from "../components/PageNavigation";

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
  const [page, setPage] = useState(1);
  const { data, error, isPending, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["audit"],
      queryFn: ({ pageParam }) => fetchAudit(pageParam ? { before: pageParam } : {}),
      initialPageParam: 0,
      getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
    });

  if (isPending) return <Spinner label="Loading audit log…" />;
  if (error) return <ErrorNote message={(error as Error).message} />;

  const currentPage = Math.min(page, data.pages.length);
  const entries = data.pages[currentPage - 1].entries;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every admin action, newest first. Console operators appear by email; the CLI's shared
          bearer token can only say "cli".
        </p>
      </div>

      <Card>
        <Table className="w-full text-sm">
          <TableHeader>
            <TableRow className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <TableHead className="px-5 py-3 font-medium">When</TableHead>
              <TableHead className="px-5 py-3 font-medium">Who</TableHead>
              <TableHead className="px-5 py-3 font-medium">Action</TableHead>
              <TableHead className="px-5 py-3 font-medium">License</TableHead>
              <TableHead className="px-5 py-3 font-medium">Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <TableRow key={entry.id} className="align-top">
                <TableCell className="px-5 py-3 whitespace-nowrap">
                  {formatDateTime(entry.at)}
                </TableCell>
                <TableCell className="px-5 py-3">{entry.actor}</TableCell>
                <TableCell className="px-5 py-3 whitespace-nowrap">
                  {actionLabels[entry.action] ?? entry.action}
                </TableCell>
                <TableCell className="px-5 py-3">
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
                </TableCell>
                <TableCell className="px-5 py-3 text-xs text-muted-foreground">
                  {detailSummary(entry)}
                </TableCell>
              </TableRow>
            ))}
            {entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="px-5 py-10 text-center text-muted-foreground">
                  Nothing recorded yet — admin actions land here as they happen.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="arc-theme table-pagination flex-wrap gap-3" aria-busy={isFetchingNextPage}>
          <p aria-live="polite" className="text-sm text-muted-foreground">
            Page {currentPage} · {entries.length} entries{isFetchingNextPage ? " · Loading…" : ""}
          </p>
          <Pagination
            page={currentPage}
            pageCount={data.pages.length + (hasNextPage ? 1 : 0)}
            label="Audit pages"
            onPageChange={(next) => {
              if (isFetchingNextPage) return;
              if (next <= data.pages.length) setPage(next);
              else
                void fetchNextPage().then((result) => {
                  if (!result.isError) setPage(next);
                });
            }}
          />
        </div>
      </Card>
    </div>
  );
}
