import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil } from "lucide-react";
import { Unplug } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

import {
  fetchActivations,
  fetchAdminConfig,
  fetchLicense,
  productPath,
  request,
  liveStatus,
  releaseActivation,
  revokeLicense,
  updateLicense,
  type License,
} from "../api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components";
import {
  Button,
  Card,
  EntitlementsEditor,
  ErrorNote,
  Modal,
  Spinner,
  StatusBadge,
  TextField,
  entitlementsSummary,
  entitlementsToRows,
  formatDate,
  formatDateTime,
  rowsToEntitlements,
  type EntitlementRow,
} from "../components";
import { DeviceIdentity } from "../components/DeviceIdentity";
import { useListPage, ListPagination } from "../components/ListPagination";
import ProductKey from "../components/ProductKey";
import { expiryDate, expiryFromDate } from "../lib/expiry";

function Field(props: { label: string; children: ReactNode }) {
  return (
    <div className="detail-field">
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

export default function LicenseDetail() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);

  // Support operators may read a license and release its seats (the transfer
  // case) but not edit or revoke it. The server enforces this; hiding the
  // controls just avoids offering buttons that would 403.
  const { data: config } = useQuery({
    queryKey: ["admin-config"],
    queryFn: fetchAdminConfig,
    staleTime: Infinity,
  });
  const canManage = config?.viewer.role === "admin";

  const licenseQuery = useQuery({
    queryKey: ["licenses", id],
    queryFn: () => fetchLicense(id),
  });
  const deliveryQuery = useQuery({
    queryKey: ["license-delivery", id],
    queryFn: () => request<any>(productPath("/licenses/" + id + "/delivery")),
    refetchInterval: 15000,
  });
  const activationsQuery = useQuery({
    queryKey: ["licenses", id, "activations"],
    queryFn: () => fetchActivations(id),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["licenses"] });
  };

  const revokeMutation = useMutation({
    mutationFn: () => revokeLicense(id),
    onSuccess: () => {
      setConfirmingRevoke(false);
      invalidate();
    },
  });

  const releaseMutation = useMutation({
    mutationFn: (installationId: string) => releaseActivation(id, installationId),
    onSuccess: () => {
      setReleasing(null);
      invalidate();
    },
  });

  const activationPage = useListPage(activationsQuery.data?.activations ?? [], id);
  if (licenseQuery.isPending) return <Spinner label="Loading license…" />;
  if (licenseQuery.error) return <ErrorNote message={(licenseQuery.error as Error).message} />;

  const license = licenseQuery.data.license;
  const status = liveStatus(license);
  const activations = activationsQuery.data?.activations ?? [];
  const activeSeats = activations.filter((activation) => !activation.deactivatedAt).length;

  return (
    <div className="space-y-6">
      <Card className="detail-sheet">
        <div className="detail-heading">
          <div>
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary"
            >
              <ArrowLeft className="size-4" /> All licenses
            </Link>
            <div className="mt-2 flex items-center gap-3">
              <h1 className="text-xl font-semibold">
                {license.issuedTo || <span className="text-muted-foreground">(unnamed)</span>}
              </h1>
              {canManage && (
                <Link className="text-primary underline" to={"/sales?license=" + id}>
                  Sales & payments
                </Link>
              )}
              <StatusBadge status={status} />
            </div>
            <div className="mt-1 font-mono text-xs text-muted-foreground">{license.id}</div>
          </div>
          {canManage && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil data-icon="inline-start" />
                Edit
              </Button>
              {license.status !== "revoked" && (
                <Button variant="danger" onClick={() => setConfirmingRevoke(true)}>
                  Revoke
                </Button>
              )}
            </div>
          )}
        </div>

        {deliveryQuery.data?.delivery && (
          <section className="px-6 pb-4 text-sm" aria-label="License delivery" aria-live="polite">
            <span className="font-medium">Delivery: </span>
            {
              (
                {
                  available: "Available to customer · awaiting retrieval",
                  retrieved: "Retrieved by customer",
                  manual: "Manual sharing required",
                  failed: "Key retrieval failed · customer can retry",
                } as Record<string, string>
              )[deliveryQuery.data.delivery.status]
            }
            {deliveryQuery.data.delivery.error && (
              <ErrorNote message={deliveryQuery.data.delivery.error} />
            )}
          </section>
        )}
        <Tabs defaultValue="overview" className="detail-tabs">
          <TabsList variant="line" className="gap-8" aria-label="License details">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="activations">Activations</TabsTrigger>
            {canManage && <TabsTrigger value="key">Product key</TabsTrigger>}
          </TabsList>
          <TabsContent value="overview">
            <div className="detail-overview">
              <section>
                <h2>Primary details</h2>
                <dl className="detail-fields">
                  <Field label="Customer">{license.issuedTo || "(unnamed)"}</Field>
                  <Field label="License ID">
                    <span className="font-mono text-xs">{license.id}</span>
                  </Field>
                  <Field label="Plan">{license.plan}</Field>
                  <Field label="Entitlements">
                    {entitlementsSummary(license.entitlements) || "—"}
                  </Field>
                  <Field label="Issued">{formatDate(license.issuedAt)}</Field>
                  <Field label="Expires">{formatDate(license.expiresAt)}</Field>
                  {license.revokedAt && (
                    <Field label="Revoked">{formatDateTime(license.revokedAt)}</Field>
                  )}
                </dl>
              </section>
              <aside className="detail-aside">
                <h2>Activation seats</h2>
                {activationsQuery.isPending ? (
                  <Spinner label="Loading seats…" />
                ) : activationsQuery.error ? (
                  <ErrorNote message={(activationsQuery.error as Error).message} />
                ) : (
                  <dl>
                    <div>
                      <dt>Seat limit</dt>
                      <dd>{license.activationLimit}</dd>
                    </div>
                    <div>
                      <dt>In use</dt>
                      <dd>{activeSeats}</dd>
                    </div>
                    <div>
                      <dt>Available</dt>
                      <dd>{Math.max(0, license.activationLimit - activeSeats)}</dd>
                    </div>
                    <div>
                      <dt>License status</dt>
                      <dd>
                        <StatusBadge status={status} />
                      </dd>
                    </div>
                  </dl>
                )}
              </aside>
            </div>
          </TabsContent>
          {canManage && (
            <TabsContent value="key">
              <ProductKey license={license} />
            </TabsContent>
          )}
          <TabsContent value="activations">
            <div className="border-b border-slate-200 px-5 py-4 text-sm font-medium">
              Activation history · {activeSeats} active installation{activeSeats === 1 ? "" : "s"}
            </div>
            {activationsQuery.isPending ? (
              <Spinner label="Loading activations…" />
            ) : activationsQuery.error ? (
              <div className="p-5">
                <ErrorNote message={(activationsQuery.error as Error).message} />
              </div>
            ) : (
              <Table className="w-full text-sm">
                <TableHeader>
                  <TableRow className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <TableHead className="px-5 py-3 font-medium">Installation</TableHead>
                    <TableHead className="px-5 py-3 font-medium">Reported machine group</TableHead>
                    <TableHead className="px-5 py-3 font-medium">Activated</TableHead>
                    <TableHead className="px-5 py-3 font-medium">State</TableHead>
                    <TableHead className="px-5 py-3 text-right">
                      {/* The actions column. Named for screen readers, which
                      otherwise announce nothing at all for this column. */}
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="divide-y divide-slate-100">
                  {activationPage.rows.map((activation) => (
                    <TableRow
                      key={activation.installationId}
                      className={activation.deactivatedAt ? "text-muted-foreground" : ""}
                    >
                      <TableCell className="px-5 py-3 font-mono text-xs">
                        {activation.installationId}
                      </TableCell>
                      <TableCell className="px-5 py-3 whitespace-nowrap">
                        <DeviceIdentity device={activation} />
                      </TableCell>
                      <TableCell className="px-5 py-3 whitespace-nowrap">
                        {formatDateTime(activation.activatedAt)}
                      </TableCell>
                      <TableCell className="px-5 py-3 whitespace-nowrap">
                        {activation.deactivatedAt
                          ? `released ${formatDateTime(activation.deactivatedAt)}`
                          : "active"}
                      </TableCell>
                      <TableCell className="px-5 py-3 text-right">
                        {!activation.deactivatedAt && (
                          <Button
                            variant="secondary"
                            onClick={() => setReleasing(activation.installationId)}
                          >
                            <Unplug aria-hidden="true" />
                            Release
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {activations.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="px-5 py-10 text-center text-muted-foreground"
                      >
                        Never activated.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
            <ListPagination {...activationPage} />
          </TabsContent>
        </Tabs>
      </Card>

      {editing && (
        <EditLicense key={license.id} license={license} onClose={() => setEditing(false)} />
      )}

      {confirmingRevoke && (
        <Modal title="Revoke this license?" onClose={() => setConfirmingRevoke(false)}>
          <p className="text-sm text-muted-foreground">
            Revocation is permanent — there is no un-revoke. Installations learn of it on their next
            refresh and imports stop there.
          </p>
          {revokeMutation.error && (
            <div className="mt-3">
              <ErrorNote message={(revokeMutation.error as Error).message} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirmingRevoke(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={revokeMutation.isPending}
              onClick={() => revokeMutation.mutate()}
            >
              {revokeMutation.isPending ? "Revoking…" : "Revoke license"}
            </Button>
          </div>
        </Modal>
      )}

      {releasing && (
        <Modal title="Release this activation?" onClose={() => setReleasing(null)}>
          <p className="text-sm text-muted-foreground">
            Frees the seat held by <code className="font-mono text-xs">{releasing}</code> so the key
            can activate on another installation (transfer).
          </p>
          {releaseMutation.error && (
            <div className="mt-3">
              <ErrorNote message={(releaseMutation.error as Error).message} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReleasing(null)}>
              Cancel
            </Button>
            <Button
              disabled={releaseMutation.isPending}
              onClick={() => releaseMutation.mutate(releasing)}
            >
              {releaseMutation.isPending ? "Releasing…" : "Release seat"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EditLicense(props: { license: License; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [baseLicense] = useState(props.license);
  const [issuedTo, setIssuedTo] = useState(props.license.issuedTo);
  const [rows, setRows] = useState<EntitlementRow[]>(
    entitlementsToRows(props.license.entitlements),
  );
  const [activationLimit, setActivationLimit] = useState(String(props.license.activationLimit));
  const [expiresAt, setExpiresAt] = useState(expiryDate(baseLicense.expiresAt));

  const mutation = useMutation({
    mutationFn: () =>
      updateLicense(baseLicense.id, {
        revision: baseLicense.revision,
        issuedTo: issuedTo.trim(),
        entitlements: rowsToEntitlements(rows),
        activationLimit: Number(activationLimit),
        expiresAt: expiryFromDate(expiresAt, baseLicense.expiresAt),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["licenses"] });
      props.onClose();
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Modal title="Edit license" onClose={props.onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <TextField label="Customer" value={issuedTo} onChange={setIssuedTo} />
        <EntitlementsEditor rows={rows} onChange={setRows} />
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <TextField
            label="Activation limit"
            type="number"
            required
            value={activationLimit}
            onChange={setActivationLimit}
          />
          <TextField
            label="Expires (UTC date; empty = never)"
            type="date"
            value={expiresAt}
            onChange={setExpiresAt}
          />
        </div>
        {mutation.error && <ErrorNote message={(mutation.error as Error).message} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
