import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { fetchAdminConfig, request, productPath } from "../api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components";
import { Button, Card, FormFields, Modal, TextField, Spinner, ErrorNote } from "../components";
import { ActionButton } from "../components/ActionButton";
import { useListPage, ListPagination } from "../components/ListPagination";
import UsageReport from "../components/UsageReport";
import { Feedback, Select, useAction } from "../platform-ui";
export default function Metering() {
  const cache = useQueryClient(),
    query = useQuery({ queryKey: ["meters"], queryFn: () => request<any>(productPath("/meters")) });
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => request<any>(productPath("/catalog")),
  });
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const admin = config.data?.viewer.role === "admin";
  const credentials = useQuery({
    queryKey: ["credentials"],
    queryFn: () => request<any>(productPath("/credentials")),
    enabled: admin,
  });
  const [creatingCredential, setCreatingCredential] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [editing, setEditing] = useState<any>(null),
    [credentialName, setCredentialName] = useState(""),
    [secret, setSecret] = useState("");
  const action = useAction(() => {
    void cache.invalidateQueries({ queryKey: ["meters"] });
    void cache.invalidateQueries({ queryKey: ["credentials"] });
  });
  const metersPage = useListPage<any>(query.data?.meters ?? []);
  const usagePage = useListPage<any>(query.data?.usage ?? []);
  const credentialsPage = useListPage<any>(credentials.data?.credentials ?? []);
  if (query.isPending) return <Spinner label="Loading meters…" />;
  if (query.error) return <ErrorNote message={(query.error as Error).message} />;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Metering</h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Consume license quotas through trusted service integrations. Offline customer-controlled
          usage cannot be enforced by reporting alone.
        </p>
      </div>
      <UsageReport usage={query.data.usage} />
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Meters</h2>
          {admin && <Button onClick={() => setEditing({})}>Add meter</Button>}
        </div>
        {metersPage.rows.map((m: any) => (
          <div
            key={m.id}
            className="mt-4 flex items-center justify-between border-t border-slate-200 pt-4"
          >
            <div>
              <p className="font-medium">
                {m.id}
                {m.archived ? " · Archived" : ""}
              </p>
              <p className="text-sm text-muted-foreground">
                {m.entitlement} · {m.period} · {m.description}
              </p>
            </div>
            {admin && <ActionButton icon={Pencil} label="Edit" onClick={() => setEditing(m)} />}
          </div>
        ))}
        <ListPagination {...metersPage} />
        {!query.data.meters.length && (
          <p className="mt-4 text-sm text-muted-foreground">
            Define a numeric entitlement first, then connect a meter to it.
          </p>
        )}
      </Card>
      {editing && admin && (
        <MeterEditor
          key={editing.id || "new"}
          value={editing}
          definitions={catalog.data?.definitions || []}
          done={() => {
            setEditing(null);
            void query.refetch();
          }}
        />
      )}
      <Card className="overflow-x-auto p-5">
        <h2 className="font-semibold">Consumed units</h2>
        <Table className="mt-4 w-full text-left text-sm">
          <TableHeader>
            <TableRow>
              {["License", "Meter", "Period", "Consumed"].map((h) => (
                <TableHead key={h} className="py-3 pr-4">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {usagePage.rows.map((u: any) => (
              <TableRow key={u.id} className="border-t border-slate-200">
                <TableCell className="py-3 pr-4">
                  <Link to={"/licenses/" + u.licenseId} className="font-mono text-xs underline">
                    {u.licenseId}
                  </Link>
                </TableCell>
                <TableCell className="pr-4">{u.meterId}</TableCell>
                <TableCell className="pr-4">{u.period}</TableCell>
                <TableCell className="tabular-nums">{u.consumed}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ListPagination {...usagePage} />
        {!query.data.usage.length && (
          <p className="py-6 text-sm text-muted-foreground">
            No usage has been consumed. New tokens do not reset cumulative usage.
          </p>
        )}
      </Card>
      {admin && revoking && (
        <Modal title="Revoke service credential?" onClose={() => setRevoking(null)}>
          <p className="mb-4 text-sm">This service will lose usage access for this product.</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={action.busy}
              onClick={() =>
                void action
                  .run(
                    () =>
                      request(productPath("/credentials/" + revoking + "/revoke"), {
                        method: "POST",
                        body: {},
                      }),
                    "Credential revoked.",
                  )
                  .then((ok) => {
                    if (ok) setRevoking(null);
                  })
              }
            >
              Revoke credential
            </Button>
          </div>
          <Feedback action={action} />
        </Modal>
      )}
      {admin && (
        <Card className="p-6">
          <h2 className="font-semibold">Service credentials</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Product-scoped credentials for trusted backend services. Never embed them in browsers or
            desktop apps.
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              setSecret("");
              setCredentialName("");
              setCreatingCredential(true);
            }}
          >
            Add credential
          </Button>
          {creatingCredential && (
            <Modal
              title="Create usage credential"
              onClose={() => {
                setCreatingCredential(false);
                setSecret("");
              }}
            >
              {!secret && (
                <form
                  className="mt-4 max-w-md space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action.run(async () => {
                      const r = await request<any>(productPath("/credentials"), {
                        method: "POST",
                        body: {
                          name: credentialName,
                          permissions: ["usage:read", "usage:consume"],
                        },
                      });
                      setSecret(r.secret);
                    }, "Credential created. Copy it now.");
                  }}
                >
                  <TextField
                    label="Integration name"
                    value={credentialName}
                    onChange={setCredentialName}
                    required
                  />
                  <Button type="submit" disabled={action.busy}>
                    Create usage credential
                  </Button>
                </form>
              )}
              {secret && (
                <div className="mt-4 space-y-3 rounded-lg border border-warning/30 bg-warning/10 p-4">
                  <p className="text-sm text-warning">
                    Shown once. Store in the service's secret manager.
                  </p>
                  <code className="block break-all text-xs">{secret}</code>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void action.run(
                          () => navigator.clipboard.writeText(secret),
                          "Credential copied.",
                        )
                      }
                    >
                      Copy credential
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSecret("");
                        setCreatingCredential(false);
                      }}
                    >
                      Done
                    </Button>
                  </div>
                </div>
              )}
              <Feedback action={action} />
            </Modal>
          )}
          <ul className="mt-4 divide-y divide-slate-200">
            {credentialsPage.rows.map((c: any) => (
              <li key={c.id} className="flex items-center justify-between gap-4 py-3">
                <div>
                  <p className="text-sm">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.revoked ? "Revoked" : c.permissions.join(", ")}
                  </p>
                </div>
                <Button
                  variant="danger"
                  disabled={c.revoked || action.busy}
                  onClick={() => setRevoking(c.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
          <ListPagination {...credentialsPage} />
          <Feedback action={action} />
        </Card>
      )}
    </div>
  );
}
function MeterEditor({
  value,
  definitions,
  done,
}: {
  value: any;
  definitions: any[];
  done: () => void;
}) {
  const [id, setId] = useState(value.id || ""),
    [entitlement, setEntitlement] = useState(
      value.entitlement || definitions.find((d) => d.type === "number" && !d.archived)?.id || "",
    ),
    [period, setPeriod] = useState(value.period || "lifetime"),
    [description, setDescription] = useState(value.description || ""),
    [archived, setArchived] = useState(value.archived || false);
  const action = useAction(done);
  return (
    <Modal title={value.id ? "Edit meter" : "Add meter"} onClose={done}>
      <form
        className="mt-4 max-w-xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() =>
            request(productPath("/meters/" + encodeURIComponent(id)), {
              method: "PUT",
              body: {
                id,
                entitlement,
                period,
                description,
                archived,
                ...(value.revision ? { revision: value.revision } : {}),
              },
            }),
          );
        }}
      >
        <FormFields>
          <TextField label="Permanent meter ID" value={id} onChange={setId} required />
          <Select
            label="Numeric quota entitlement"
            value={entitlement}
            onChange={setEntitlement}
            options={definitions
              .filter((d) => d.type === "number" && !d.archived)
              .map((d) => ({ value: d.id, label: d.id }))}
          />
          <Select
            label="Quota period"
            value={period}
            onChange={setPeriod}
            options={["lifetime", "daily", "monthly"].map((v) => ({
              value: v,
              label: v === "lifetime" ? "Lifetime" : v + " (UTC)",
            }))}
          />
          <TextField label="Description" value={description} onChange={setDescription} />
        </FormFields>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Archive meter
        </label>
        <p className="text-sm text-muted-foreground">
          Existing meter periods and quota links cannot be changed; create another meter instead.
        </p>
        <div className="flex gap-3">
          <Button type="submit" disabled={action.busy}>
            Save meter
          </Button>
          <Button variant="secondary" onClick={done}>
            Cancel
          </Button>
        </div>
        <Feedback action={action} />
      </form>
    </Modal>
  );
}
