import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Input } from "@/components/ui/input";

import { fetchInstallations } from "../api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components";
import { Button, Card, ErrorNote, Spinner, formatDate, formatDateTime } from "../components";
import { DeviceIdentity } from "../components/DeviceIdentity";

const PAGE_SIZE = 25;

function SummaryCard(props: { label: string; value: number; hint?: string }) {
  return (
    <div className="summary-item">
      <div className="summary-label">{props.label}</div>
      <div className="summary-value">{props.value.toLocaleString()}</div>
      <div className="summary-note">{props.hint || "Selected product"}</div>
    </div>
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
        <p className="mt-1 text-sm text-muted-foreground">
          Registered app identities and their current license bindings. Reported machine groups are
          recognition hints, not verified physical-device counts.
        </p>
      </div>

      <Card className="summary-panel">
        <h2>Installation overview</h2>
        <div className="summary-grid">
          <SummaryCard label="Installations" value={counts.total} />
          <SummaryCard label="Active licensed installations" value={counts.licensed} />
          <SummaryCard label="Unlicensed" value={counts.unlicensed} />
          <SummaryCard
            label="Licenses issued"
            value={counts.licensesIssued}
            hint="Issued grants, including unactivated licenses"
          />
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-4">
          <Input
            type="search"
            aria-label="Search installations"
            placeholder="Search by installation, user, email or platform…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          <div className="filter-tabs" aria-label="Installation status">
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
        <div className={`overflow-x-auto ${isPlaceholderData ? "opacity-60" : ""}`}>
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <TableHead className="px-5 py-3 font-medium">Installation</TableHead>
                <TableHead className="px-5 py-3 font-medium">User</TableHead>
                <TableHead className="px-5 py-3 font-medium">Reported machine group</TableHead>
                <TableHead className="px-5 py-3 font-medium">Version</TableHead>
                <TableHead className="px-5 py-3 font-medium">Platform</TableHead>
                <TableHead className="px-5 py-3 font-medium">License</TableHead>
                <TableHead className="px-5 py-3 font-medium">Registered</TableHead>
                <TableHead className="px-5 py-3 font-medium">Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-slate-100">
              {installations.map((installation) => (
                <TableRow key={installation.installationId} className="hover:bg-slate-50">
                  <TableCell className="px-5 py-3 font-mono text-xs">
                    {installation.installationId}
                  </TableCell>
                  <TableCell className="px-5 py-3">
                    {installation.userName || (
                      <span className="text-muted-foreground">(anonymous)</span>
                    )}
                    {installation.userEmail && (
                      <div className="text-xs text-muted-foreground">{installation.userEmail}</div>
                    )}
                  </TableCell>
                  <TableCell className="px-5 py-3">
                    <DeviceIdentity device={installation} />
                  </TableCell>
                  <TableCell className="px-5 py-3">{installation.appVersion || "—"}</TableCell>
                  <TableCell className="px-5 py-3">{installation.platform || "—"}</TableCell>
                  <TableCell className="px-5 py-3">
                    {installation.licenses?.length ? (
                      installation.licenses.map((binding) => (
                        <div key={binding.licenseId}>
                          <Link
                            to={"/licenses/" + binding.licenseId}
                            className="font-mono text-xs underline"
                          >
                            {binding.keyReference || binding.licenseId.slice(0, 8)}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {binding.deactivatedAt ? "Released" : binding.status}
                          </p>
                        </div>
                      ))
                    ) : (
                      <span className="text-muted-foreground">No license binding</span>
                    )}
                  </TableCell>
                  <TableCell className="px-5 py-3 whitespace-nowrap">
                    {formatDate(installation.registeredAt)}
                  </TableCell>
                  <TableCell className="px-5 py-3 whitespace-nowrap">
                    {formatDateTime(installation.lastSeenAt)}
                  </TableCell>
                </TableRow>
              ))}
              {installations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="px-5 py-10 text-center text-muted-foreground">
                    {counts.total === 0
                      ? "No installations registered yet — the installer reports here on every install."
                      : "No installations match the current filter."}
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
