import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";

import {
  fetchActivations,
  fetchAdminConfig,
  fetchLicense,
  liveStatus,
  releaseActivation,
  revokeLicense,
  updateLicense,
  type License,
} from "../api";
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

function Field(props: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{props.label}</dt>
      <dd className="mt-1 text-sm">{props.children}</dd>
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

  if (licenseQuery.isPending) return <Spinner label="Loading license…" />;
  if (licenseQuery.error) return <ErrorNote message={(licenseQuery.error as Error).message} />;

  const license = licenseQuery.data.license;
  const status = liveStatus(license);
  const activations = activationsQuery.data?.activations ?? [];
  const activeSeats = activations.filter((activation) => !activation.deactivatedAt).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <Link to="/" className="text-sm text-slate-500 hover:text-slate-900">
            ← All licenses
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <h1 className="text-xl font-semibold">
              {license.issuedTo || <span className="text-slate-400">(unnamed)</span>}
            </h1>
            <StatusBadge status={status} />
          </div>
          <div className="mt-1 font-mono text-xs text-slate-400">{license.id}</div>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)}>
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

      <Card className="p-5">
        <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
          <Field label="Plan">{license.plan}</Field>
          <Field label="Entitlements">{entitlementsSummary(license.entitlements) || "—"}</Field>
          <Field label="Seats">
            {activeSeats} / {license.activationLimit} in use
          </Field>
          <Field label="Issued">{formatDate(license.issuedAt)}</Field>
          <Field label="Expires">{formatDate(license.expiresAt)}</Field>
          {license.revokedAt && <Field label="Revoked">{formatDateTime(license.revokedAt)}</Field>}
        </dl>
      </Card>

      <Card>
        <div className="border-b border-slate-200 px-5 py-4 text-sm font-medium">Activations</div>
        {activationsQuery.isPending ? (
          <Spinner label="Loading activations…" />
        ) : activationsQuery.error ? (
          <div className="p-5">
            <ErrorNote message={(activationsQuery.error as Error).message} />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Installation</th>
                <th className="px-5 py-3 font-medium">Activated</th>
                <th className="px-5 py-3 font-medium">State</th>
                <th className="px-5 py-3">
                  {/* The actions column. Named for screen readers, which
                      otherwise announce nothing at all for this column. */}
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activations.map((activation) => (
                <tr
                  key={activation.installationId}
                  className={activation.deactivatedAt ? "text-slate-400" : ""}
                >
                  <td className="px-5 py-3 font-mono text-xs">{activation.installationId}</td>
                  <td className="px-5 py-3 whitespace-nowrap">
                    {formatDateTime(activation.activatedAt)}
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap">
                    {activation.deactivatedAt
                      ? `released ${formatDateTime(activation.deactivatedAt)}`
                      : "active"}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {!activation.deactivatedAt && (
                      <Button
                        variant="secondary"
                        onClick={() => setReleasing(activation.installationId)}
                      >
                        Release
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {activations.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center text-slate-400">
                    Never activated.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>

      {editing && <EditLicense license={license} onClose={() => setEditing(false)} />}

      {confirmingRevoke && (
        <Modal title="Revoke this license?" onClose={() => setConfirmingRevoke(false)}>
          <p className="text-sm text-slate-600">
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
          <p className="text-sm text-slate-600">
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
  const [issuedTo, setIssuedTo] = useState(props.license.issuedTo);
  const [rows, setRows] = useState<EntitlementRow[]>(
    entitlementsToRows(props.license.entitlements),
  );
  const [activationLimit, setActivationLimit] = useState(String(props.license.activationLimit));
  const [expiresAt, setExpiresAt] = useState(
    props.license.expiresAt ? props.license.expiresAt.slice(0, 10) : "",
  );

  const mutation = useMutation({
    mutationFn: () =>
      updateLicense(props.license.id, {
        issuedTo: issuedTo.trim(),
        entitlements: rowsToEntitlements(rows),
        activationLimit: Number(activationLimit),
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59Z`).toISOString() : null,
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
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="Activation limit"
            type="number"
            required
            value={activationLimit}
            onChange={setActivationLimit}
          />
          <TextField
            label="Expires (empty = never)"
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
