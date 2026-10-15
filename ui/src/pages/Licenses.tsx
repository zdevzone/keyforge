import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { Input } from "@/components/ui/input";

import { fetchAdminConfig, fetchLicenses, liveStatus, type License, type LiveStatus } from "../api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components";
import {
  Button,
  Card,
  ErrorNote,
  Spinner,
  StatusBadge,
  entitlementsSummary,
  formatDate,
} from "../components";
import IssueLicense from "../IssueLicense";

const PAGE_SIZE = 25;

function SummaryCard(props: { label: string; value: number; note: string }) {
  return (
    <div className="summary-item">
      <span className="summary-label">{props.label}</span>
      <span className="summary-value">{props.value.toLocaleString()}</span>
      <span className="summary-note">{props.note}</span>
    </div>
  );
}

const filters: Array<{ label: string; value: LiveStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Expired", value: "expired" },
  { label: "Revoked", value: "revoked" },
];

export default function Licenses() {
  const [params] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") || "");
  const [query, setQuery] = useState(params.get("q") || "");
  const [filter, setFilter] = useState<LiveStatus | "all">("all");
  const [page, setPage] = useState(0);
  const [issuing, setIssuing] = useState(false);
  // Support operators can read everything here but not mint licenses; the
  // server returns 403 either way, this just avoids offering a dead button.
  const { data: config } = useQuery({
    queryKey: ["admin-config"],
    queryFn: fetchAdminConfig,
    staleTime: Infinity,
  });
  const canIssue = config?.viewer.role === "admin";

  // Search is server-side now; debounce keystrokes so each pause, not each
  // letter, becomes a request.
  useEffect(() => {
    const handle = setTimeout(() => {
      setQuery(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  const status = filter === "all" ? undefined : filter;
  const { data, isPending, error, isPlaceholderData, isFetching, refetch } = useQuery({
    queryKey: ["licenses", { q: query, status, page }],
    queryFn: () => fetchLicenses({ q: query, status, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  if (isPending) return <Spinner label="Loading licenses…" />;
  if (error) return <ErrorNote message={(error as Error).message} />;

  const { licenses, total, counts } = data;
  const everything = counts.active + counts.expired + counts.revoked;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-6">
      <Card className="summary-panel">
        <h1 className="mb-6">License overview</h1>
        <div className="summary-grid">
          <SummaryCard label="Total licenses" value={everything} note="Selected product" />
          <SummaryCard label="Active" value={counts.active} note="Currently valid" />
          <SummaryCard label="Expired" value={counts.expired} note="Past expiration date" />
          <SummaryCard label="Revoked" value={counts.revoked} note="Access withdrawn" />
        </div>
      </Card>

      <Card>
        <div className="list-toolbar">
          <h2>Licenses</h2>
          <Link className="text-sm text-primary underline" to="/license-requests">
            License requests
          </Link>
          {canIssue && (
            <Button onClick={() => setIssuing(true)}>
              <Plus data-icon="inline-start" />
              Issue license
            </Button>
          )}
          <Button variant="secondary" disabled={isFetching} onClick={() => void refetch()}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>
        <div className="list-filters">
          <div className="relative w-full sm:max-w-xs">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Filter licenses"
              placeholder="Search by customer, plan or id…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full pl-9"
            />
          </div>
          <div className="filter-tabs" aria-label="License status">
            {filters.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  setFilter(option.value);
                  setPage(0);
                }}
                aria-pressed={filter === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {issuing && <IssueLicense onClose={() => setIssuing(false)} />}
        <div className={`overflow-x-auto ${isPlaceholderData ? "opacity-60" : ""}`}>
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <TableHead className="px-5 py-3 font-medium">Issued to</TableHead>
                <TableHead className="px-5 py-3 font-medium">Plan</TableHead>
                <TableHead className="px-5 py-3 font-medium">Status</TableHead>
                <TableHead className="px-5 py-3 font-medium">Entitlements</TableHead>
                <TableHead className="px-5 py-3 font-medium text-right">Seats</TableHead>
                <TableHead className="px-5 py-3 font-medium">Issued</TableHead>
                <TableHead className="px-5 py-3 font-medium">Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-slate-100">
              {licenses.map((license) => (
                <LicenseRow key={license.id} license={license} status={liveStatus(license)} />
              ))}
              {licenses.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="px-5 py-10 text-center text-muted-foreground">
                    {everything === 0
                      ? "No licenses issued yet."
                      : "No licenses match the current filter."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="table-pagination">
          <span>
            Showing {from}–{to} of {total}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="tabular-nums">
              {page + 1} / {pageCount}
            </span>
            <Button
              variant="secondary"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function LicenseRow(props: { license: License; status: LiveStatus }) {
  const { license, status } = props;
  return (
    <TableRow className="hover:bg-slate-50">
      <TableCell className="px-5 py-3">
        <Link to={`/licenses/${license.id}`} className="font-medium text-slate-900 hover:underline">
          {license.issuedTo || <span className="text-muted-foreground">(unnamed)</span>}
        </Link>
        <div className="font-mono text-xs text-muted-foreground">{license.id}</div>
      </TableCell>
      <TableCell className="px-5 py-3">{license.plan}</TableCell>
      <TableCell className="px-5 py-3">
        <StatusBadge status={status} />
      </TableCell>
      <TableCell className="px-5 py-3 text-xs text-muted-foreground">
        {entitlementsSummary(license.entitlements) || "—"}
      </TableCell>
      <TableCell className="px-5 py-3 text-right tabular-nums">{license.activationLimit}</TableCell>
      <TableCell className="px-5 py-3 whitespace-nowrap">{formatDate(license.issuedAt)}</TableCell>
      <TableCell className="px-5 py-3 whitespace-nowrap">{formatDate(license.expiresAt)}</TableCell>
    </TableRow>
  );
}
