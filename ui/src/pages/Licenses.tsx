import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { fetchAdminConfig, fetchLicenses, liveStatus, type License, type LiveStatus } from "../api";
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

function SummaryCard(props: { label: string; value: number }) {
  return (
    <Card className="px-5 py-4">
      <div className="text-sm text-slate-500">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{props.value}</div>
    </Card>
  );
}

const filters: Array<{ label: string; value: LiveStatus | "all" }> = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Expired", value: "expired" },
  { label: "Revoked", value: "revoked" },
];

export default function Licenses() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
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
  const { data, isPending, error, isPlaceholderData } = useQuery({
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
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard label="Licenses" value={everything} />
        <SummaryCard label="Active" value={counts.active} />
        <SummaryCard label="Expired" value={counts.expired} />
        <SummaryCard label="Revoked" value={counts.revoked} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-4">
          <input
            type="search"
            placeholder="Search by customer, plan or id…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          <div className="flex gap-1">
            {filters.map((option) => (
              <button
                key={option.value}
                onClick={() => {
                  setFilter(option.value);
                  setPage(0);
                }}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  filter === option.value
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          {canIssue && (
            <div className="ml-auto">
              <Button onClick={() => setIssuing(true)}>Issue license</Button>
            </div>
          )}
        </div>
        {issuing && <IssueLicense onClose={() => setIssuing(false)} />}
        <div className={`overflow-x-auto ${isPlaceholderData ? "opacity-60" : ""}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Issued to</th>
                <th className="px-5 py-3 font-medium">Plan</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Entitlements</th>
                <th className="px-5 py-3 font-medium text-right">Seats</th>
                <th className="px-5 py-3 font-medium">Issued</th>
                <th className="px-5 py-3 font-medium">Expires</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {licenses.map((license) => (
                <LicenseRow key={license.id} license={license} status={liveStatus(license)} />
              ))}
              {licenses.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                    {everything === 0
                      ? "No licenses issued yet."
                      : "No licenses match the current filter."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-slate-500">
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
    <tr className="hover:bg-slate-50">
      <td className="px-5 py-3">
        <Link to={`/licenses/${license.id}`} className="font-medium text-slate-900 hover:underline">
          {license.issuedTo || <span className="text-slate-400">(unnamed)</span>}
        </Link>
        <div className="font-mono text-xs text-slate-400">{license.id}</div>
      </td>
      <td className="px-5 py-3">{license.plan}</td>
      <td className="px-5 py-3">
        <StatusBadge status={status} />
      </td>
      <td className="px-5 py-3 text-xs text-slate-500">
        {entitlementsSummary(license.entitlements) || "—"}
      </td>
      <td className="px-5 py-3 text-right tabular-nums">{license.activationLimit}</td>
      <td className="px-5 py-3 whitespace-nowrap">{formatDate(license.issuedAt)}</td>
      <td className="px-5 py-3 whitespace-nowrap">{formatDate(license.expiresAt)}</td>
    </tr>
  );
}
