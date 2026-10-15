import { useQuery } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchAdminConfig, productPath, request } from "../api";
import {
  Card,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  ErrorNote,
  Spinner,
  TextField,
  Button,
} from "../components";
import { ActionButton } from "../components/ActionButton";
import { Choice } from "../components/Choice";
import { ListPagination, useListPage } from "../components/ListPagination";
import IssueLicense from "../IssueLicense";

export default function LicenseRequests() {
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const query = useQuery({
    queryKey: ["license-requests"],
    queryFn: () => request<any>(productPath("/license-requests")),
    refetchInterval: 30000,
  });
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("requested"),
    [issuing, setIssuing] = useState<string | null>(null),
    [copied, setCopied] = useState(false);
  const rows = (query.data?.requests ?? []).filter(
    (v: any) =>
      (filter === "all" || v.status === filter) &&
      (v.name + " " + v.email).toLowerCase().includes(search.toLowerCase()),
  );
  const page = useListPage<any>(rows, search + filter);
  if (query.isPending) return <Spinner />;
  if (query.error) return <ErrorNote message={query.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">License requests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review requests submitted before installation. Contact details are customer-provided and
            unverified.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard
              .writeText(window.location.origin + "/request-license")
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Request link copied" : "Copy public request link"}
        </Button>
      </div>
      <Link className="text-sm text-primary underline" to="/">
        Back to licenses
      </Link>
      <Card>
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <TextField label="Find request" value={search} onChange={setSearch} />
          <Choice
            label="Request status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "requested", label: "Awaiting issuance" },
              { value: "issued", label: "Issued" },
              { value: "all", label: "All" },
            ]}
          />
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Requested plan</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((v: any) => (
                <TableRow key={v.id}>
                  <TableCell>
                    {v.name}
                    <p className="text-xs text-muted-foreground">{v.email}</p>
                  </TableCell>
                  <TableCell>{v.plan}</TableCell>
                  <TableCell>{new Date(v.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{v.status === "requested" ? "Awaiting issuance" : "Issued"}</TableCell>
                  <TableCell className="text-right">
                    {v.status === "requested" && config.data?.viewer.role === "admin" ? (
                      <ActionButton
                        icon={CheckCheck}
                        label="Issue license"
                        onClick={() => setIssuing(v.id)}
                      />
                    ) : v.licenseId ? (
                      <Link className="text-primary underline" to={"/licenses/" + v.licenseId}>
                        Details
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={5}>No requests match this filter.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <ListPagination {...page} />
      </Card>
      {issuing && <IssueLicense initialRequestId={issuing} onClose={() => setIssuing(null)} />}
    </div>
  );
}
