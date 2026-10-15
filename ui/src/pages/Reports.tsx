import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchAdminConfig, request } from "../api";
import {
  Button,
  Card,
  ErrorNote,
  Spinner,
  TextField,
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "../components";
import { ActionButton } from "../components/ActionButton";
import { Choice } from "../components/Choice";
import { DateField } from "../components/DateField";
import { ListPagination, useListPage } from "../components/ListPagination";
import { useProduct } from "../platform-ui";

type Row = {
  id: string;
  customer: string;
  status: string;
  date: string | null;
  [key: string]: string | number | null;
};
type Report = {
  rows: Row[];
  counts: Record<string, number>;
  meters: Record<string, number>;
  generatedAt: string;
};
const types = [
  { value: "licenses", label: "License status" },
  { value: "expirations", label: "License expirations" },
  { value: "usage", label: "Usage by customer" },
  { value: "activations", label: "Activations" },
  { value: "support", label: "Support requests" },
];
const labels: Record<string, string> = {
  id: "Record ID",
  customer: "Customer",
  status: "Status",
  date: "Date (UTC)",
  plan: "Plan",
  expiresAt: "Expires (UTC)",
  seats: "Seat limit",
  licenseId: "License ID",
  meter: "Meter",
  period: "Period",
  consumed: "Consumed units",
  installation: "Installation",
  releasedAt: "Released (UTC)",
  subject: "Subject",
  category: "Category",
  urgency: "Urgency",
};
const columns: Record<string, string[]> = {
  licenses: ["customer", "plan", "status", "date", "expiresAt", "seats"],
  expirations: ["customer", "plan", "status", "expiresAt", "seats"],
  usage: ["customer", "meter", "period", "consumed", "status"],
  activations: ["customer", "installation", "status", "date", "releasedAt"],
  support: ["customer", "subject", "category", "urgency", "status", "date"],
};
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function ReportTable({ rows, fields }: { rows: Row[]; fields: string[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {fields.map((key) => (
            <TableHead key={key}>{labels[key]}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            {fields.map((key) => (
              <TableCell key={key}>{row[key] ?? "—"}</TableCell>
            ))}
          </TableRow>
        ))}
        {!rows.length && (
          <TableRow>
            <TableCell colSpan={fields.length}>No records match these filters.</TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
export default function Reports() {
  const cache = useQueryClient();
  const { id, products } = useProduct();
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const [draft, setDraft] = useState({
    type: "licenses",
    from: "",
    to: "",
    customer: "",
    status: "all",
  });
  const [filters, setFilters] = useState(draft);
  const invalid = Boolean(draft.from && draft.to && draft.from > draft.to);
  const query = useQuery({
    queryKey: ["reports", id, filters],
    queryFn: () => {
      const search = new URLSearchParams(
        Object.entries(filters).filter(([, value]) => value !== ""),
      );
      return request<Report>(`/admin/products/${encodeURIComponent(id)}/reports?${search}`);
    },
  });
  const rows = query.data?.rows ?? [];
  const list = useListPage(rows, JSON.stringify([id, filters]));
  const fields = columns[filters.type];
  const title = types.find((t) => t.value === filters.type)!.label;
  const product = products.find((p) => p.id === id)?.name ?? id;
  const statuses =
    draft.type === "support"
      ? ["queued", "in_progress", "waiting_customer", "resolved", "closed"]
      : draft.type === "activations"
        ? ["active", "released"]
        : ["active", "expired", "revoked"];
  function exportCsv() {
    const keys = ["id", ...fields];
    const body = [
      keys.map((key) => csvCell(labels[key])).join(","),
      ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(",")),
    ].join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + body], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${id}-${filters.type}-${query.data!.generatedAt.slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="report-page flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Reports</h1>
        {config.data?.viewer.role === "admin" && (
          <Link to="/reports/financial" className="text-primary underline">
            Financial reports
          </Link>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          Review licensing and service activity for {product}. Switch products in the header.
        </p>
      </div>
      <Card className="report-controls p-5">
        <form
          className="flex flex-wrap items-end gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!invalid) {
              setFilters({ ...draft });
              void cache.invalidateQueries({ queryKey: ["reports", id, draft], exact: true });
            }
          }}
        >
          <Choice
            label="Report"
            value={draft.type}
            options={types.filter(
              (t) => t.value !== "activations" || config.data?.features.registry,
            )}
            onChange={(type) => setDraft({ ...draft, type, status: "all" })}
          />
          <DateField
            label="From (UTC)"
            placeholder="Any start date"
            value={draft.from}
            onChange={(from) => setDraft({ ...draft, from })}
          />
          <DateField
            label="Through (UTC)"
            placeholder="Any end date"
            value={draft.to}
            onChange={(to) => setDraft({ ...draft, to })}
          />
          <TextField
            label="Customer contains"
            value={draft.customer}
            onChange={(customer) => setDraft({ ...draft, customer })}
          />
          <Choice
            label="Status"
            value={draft.status}
            options={[
              { value: "all", label: "All statuses" },
              ...statuses.map((value) => ({ value, label: value.replaceAll("_", " ") })),
            ]}
            onChange={(status) => setDraft({ ...draft, status })}
          />
          <Button type="submit" disabled={invalid || query.isFetching}>
            Apply filters
          </Button>
        </form>
        {invalid && <ErrorNote message="Start date must not follow end date." />}
        <p className="mt-4 text-sm text-muted-foreground">
          Dates filter issuance, expiry, activation or request receipt according to the report.
          Usage includes complete overlapping daily/monthly buckets; lifetime totals appear only
          without dates. Status is current, not historical.
        </p>
      </Card>
      {query.isPending ? (
        <Spinner label="Building report…" />
      ) : query.error ? (
        <ErrorNote message={(query.error as Error).message} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold">
                {title} · {rows.length} {rows.length === 1 ? "record" : "records"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {filters.from || "All time"} – {filters.to || "present"} ·{" "}
                {filters.customer || "All customers"} · {filters.status.replaceAll("_", " ")}
              </p>
              <p className="text-xs text-muted-foreground">
                Generated {query.data.generatedAt} · {product}
              </p>
            </div>
            <div className="report-controls flex gap-2">
              <ActionButton
                icon={Download}
                label="Export CSV"
                onClick={exportCsv}
                disabled={!rows.length || query.isFetching}
              />
              <ActionButton
                icon={Printer}
                label="Print / Save PDF"
                onClick={() => window.print()}
                disabled={!rows.length || query.isFetching}
              />
            </div>
          </div>
          <p className="text-sm">
            {Object.entries(query.data.counts)
              .map(([status, count]) => `${status.replaceAll("_", " ")}: ${count}`)
              .join(" · ") || "No matching records"}
          </p>
          {filters.type === "usage" && (
            <p className="text-sm">
              {Object.entries(query.data.meters)
                .map(([meter, count]) => `${meter}: ${count.toLocaleString()} units`)
                .join(" · ")}
            </p>
          )}
          <Card className="report-screen overflow-hidden p-5">
            <ReportTable rows={list.rows} fields={fields} />
            <ListPagination {...list} label="Report pages" />
          </Card>
          <div className="report-print">
            <ReportTable rows={rows} fields={fields} />
          </div>
        </>
      )}
    </div>
  );
}
