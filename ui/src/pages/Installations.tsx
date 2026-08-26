import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { fetchInstallations } from "../api";
import { Button, Card, ErrorNote, Spinner, formatDate, formatDateTime } from "../components";

const PAGE_SIZE = 25;

function SummaryCard(props: { label: string; value: number; hint?: string }) {
  return (
    <Card className="px-5 py-4">
      <div className="text-sm text-slate-500">{props.label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{props.value}</div>
      {props.hint && <div className="mt-1 text-xs text-slate-400">{props.hint}</div>}
    </Card>
  );
}

const filters: Array<{ label: string; value: "all" | "licensed" | "unlicensed" }> = [
  { label: "All", value: "all" },
  { label: "Licensed", value: "licensed" },
  { label: "Unlicensed", value: "unlicensed" },
];

export default function Installations() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "licensed" | "unlicensed">("all");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const handle = setTimeout(() => {
      setQuery(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  const licensed = filter === "all" ? undefined : filter === "licensed";
  const { data, isPending, error, isPlaceholderData } = useQuery({
    queryKey: ["installations", { q: query, licensed, page }],
    queryFn: () => fetchInstallations({ q: query, licensed, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  if (isPending) return <Spinner label="Loading installations…" />;
  if (error) return <ErrorNote message={(error as Error).message} />;

  const { installations, total, counts } = data;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Installations</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every registered install of the app — licensed or not — against the licenses actually
          issued.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard label="Installations" value={counts.total} />
        <SummaryCard label="Licensed" value={counts.licensed} />
        <SummaryCard label="Unlicensed" value={counts.unlicensed} />
        <SummaryCard
          label="Licenses issued"
          value={counts.licensesIssued}
          hint={
            counts.licensesIssued > 0
              ? `${counts.licensed} of ${counts.licensesIssued} activated somewhere`
              : undefined
          }
        />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-4">
          <input
            type="search"
            placeholder="Search by installation, user, email or platform…"
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
        </div>
        <div className={`overflow-x-auto ${isPlaceholderData ? "opacity-60" : ""}`}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Installation</th>
                <th className="px-5 py-3 font-medium">User</th>
                <th className="px-5 py-3 font-medium">Version</th>
                <th className="px-5 py-3 font-medium">Platform</th>
                <th className="px-5 py-3 font-medium">License</th>
                <th className="px-5 py-3 font-medium">Registered</th>
                <th className="px-5 py-3 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {installations.map((installation) => (
                <tr key={installation.installationId} className="hover:bg-slate-50">
                  <td className="px-5 py-3 font-mono text-xs">{installation.installationId}</td>
                  <td className="px-5 py-3">
                    {installation.userName || <span className="text-slate-400">(anonymous)</span>}
                    {installation.userEmail && (
                      <div className="text-xs text-slate-400">{installation.userEmail}</div>
                    )}
                  </td>
                  <td className="px-5 py-3">{installation.appVersion || "—"}</td>
                  <td className="px-5 py-3">{installation.platform || "—"}</td>
                  <td className="px-5 py-3">
                    {installation.licenseId ? (
                      <Link
                        to={`/licenses/${installation.licenseId}`}
                        className="font-mono text-xs underline"
                      >
                        {installation.licenseId.slice(0, 8)}…
                      </Link>
                    ) : (
                      <span className="text-slate-400">unlicensed</span>
                    )}
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap">
                    {formatDate(installation.registeredAt)}
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap">
                    {formatDateTime(installation.lastSeenAt)}
                  </td>
                </tr>
              ))}
              {installations.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                    {counts.total === 0
                      ? "No installations registered yet — the installer reports here on every install."
                      : "No installations match the current filter."}
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
