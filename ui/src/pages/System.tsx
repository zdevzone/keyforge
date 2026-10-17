import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { request } from "../api";
import { useSession } from "../auth-client";
import { Button, Card, ErrorNote, Modal, Spinner, TextField } from "../components";
import { Checkbox } from "../components/Checkbox";
export default function System({ embedded = false }: { embedded?: boolean }) {
  const query = useQuery({ queryKey: ["system"], queryFn: () => request<any>("/admin/system") });
  if (query.isPending) return <Spinner label="Reading system configuration…" />;
  if (query.error) return <ErrorNote message={(query.error as Error).message} />;
  const s = query.data;
  return (
    <div className="space-y-6">
      {!embedded && (
        <div>
          <h1 className="text-xl font-semibold">System status</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Effective configuration. Secrets are never displayed.
          </p>
        </div>
      )}
      <Card className="p-6">
        <dl className="grid gap-6 sm:grid-cols-2">
          {Object.entries({
            Database: s.engine,
            "Ledger source": s.databaseSource,
            "Operator database source": s.authSource,
            "Operator login": s.authEnabled ? "Enabled" : "Disabled",
            "CLI bearer access": s.adminBearerEnabled ? "Enabled" : "Disabled",
            "Key encryption": s.encryptionConfigured ? "Configured" : "Missing",
            "Public origin": s.publicOriginConfigured ? "Configured" : "Development fallback",
          }).map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-medium">{String(value)}</dd>
            </div>
          ))}
        </dl>
        {s.ignoredSqlitePaths && (
          <p className="mt-6 text-sm">
            DATABASE_URL selects Postgres for both datasets. SQLite paths are ignored, not standby
            databases.
          </p>
        )}
        {s.sqlitePaths && (
          <p className="mt-6 text-sm">
            Ledger: {s.sqlitePaths.ledger}
            <br />
            Operators: {s.sqlitePaths.auth}
            <br />
            One database snapshot includes licensing, operator accounts and sessions.
          </p>
        )}
      </Card>
      {s.warnings.map((w: string) => (
        <output
          key={w}
          className="rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm text-warning"
        >
          {w}
        </output>
      ))}
      <Link to="/backups" className="text-sm underline">
        Manage backups
      </Link>
      <Card className="p-6">
        <h2 className="font-semibold">Configuration boundaries</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The environment configures infrastructure and secrets. Product plans, entitlements and
          trials live in the database and are managed in the console. The JSON file seeds the first
          product once; it does not overwrite later edits.
        </p>
      </Card>
      <ResetApplicationData />
    </div>
  );
}

interface ResetPlan {
  available: boolean;
  preservedAdmin: { id: string; email: string } | null;
  reason: string | null;
  backupAvailable: boolean;
  backupRequirement: string;
}
function ResetApplicationData() {
  const plan = useQuery({
    queryKey: ["system-reset"],
    queryFn: () => request<ResetPlan>("/admin/system/reset"),
  });
  const { data: session } = useSession();
  const cache = useQueryClient();
  const [params] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [backup, setBackup] = useState(true);
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function reset(event: FormEvent) {
    event.preventDefault();
    if (confirmation !== "DELETE ALL" || busy || !plan.data?.available) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ preservedAdmin: { id: string }; backupId: string | null }>(
        "/admin/system/reset",
        {
          method: "POST",
          body: { confirmation, backup, requestId },
        },
      );
      await cache.cancelQueries();
      localStorage.setItem("keyforge-product", "default");
      // A full navigation drops all cached pre-reset records and session state.
      window.location.assign(
        session?.user.id === result.preservedAdmin.id &&
          !(session.session as { impersonatedBy?: string }).impersonatedBy
          ? "/settings?tab=system&reset=complete" + (result.backupId ? "&backup=verified" : "")
          : "/login?reset=complete",
      );
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }
  return (
    <Card className="p-6">
      <h2 className="font-semibold text-destructive">Reset application data</h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        Clear products, plans, licenses, installations, financial records, conversations,
        notifications and other operators. Keep the first seeded administrator and their
        credentials. Deployment configuration, signing keys and external backup files are retained.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        The default product and deployment plan defaults are recreated. Existing offline tokens may
        remain valid until their normal expiry.
      </p>
      {params.get("reset") === "complete" && (
        <output className="mt-4 block text-sm text-success">
          Application data was reset. The seeded administrator was preserved.
          {params.get("backup") === "verified" && (
            <>
              {" "}
              A verified backup is available in{" "}
              <Link className="underline" to="/settings?tab=backups">
                Backups
              </Link>
              .
            </>
          )}
        </output>
      )}
      {plan.isPending && (
        <p className="mt-4 text-sm text-muted-foreground">Checking reset availability…</p>
      )}
      {plan.error && <ErrorNote message={plan.error.message} />}
      {plan.data?.preservedAdmin && (
        <p className="mt-4 text-sm">
          Administrator retained: <strong>{plan.data.preservedAdmin.email}</strong>
        </p>
      )}
      {plan.data?.reason && (
        <p className="mt-4 text-sm text-muted-foreground">{plan.data.reason}</p>
      )}
      <Button
        className="mt-5"
        variant="danger"
        disabled={!plan.data?.available}
        onClick={() => {
          setOpen(true);
          setConfirmation("");
          setBackup(true);
          setError("");
          setRequestId(crypto.randomUUID());
        }}
      >
        Reset application data
      </Button>
      {open && (
        <Modal title="Reset application data?" onClose={busy ? undefined : () => setOpen(false)}>
          <form onSubmit={reset} className="flex flex-col gap-5" aria-busy={busy}>
            <p className="text-sm leading-6">
              This permanently deletes application records and all operators except{" "}
              <strong>{plan.data?.preservedAdmin?.email}</strong>. Only that administrator’s
              credentials and non-impersonated sessions remain. Other operator accounts and sessions
              are removed.
            </p>
            <Checkbox
              label="Back up existing data before resetting"
              checked={backup}
              onCheckedChange={(value) => setBackup(value === true)}
              disabled={busy}
              description="Create and verify an encrypted database archive first. If either step fails, no application data is deleted."
            />
            {backup && (
              <p className="text-sm text-muted-foreground">{plan.data?.backupRequirement}</p>
            )}
            {backup && !plan.data?.backupAvailable && (
              <p className="text-sm text-destructive">
                Backup is not configured. Configure backups or explicitly uncheck this option to
                reset without a backup.
              </p>
            )}
            <TextField
              label="Type DELETE ALL to confirm"
              value={confirmation}
              onChange={setConfirmation}
              required
            />
            {error && <ErrorNote message={error} />}
            {busy && (
              <output className="text-sm text-muted-foreground">
                {backup
                  ? "Creating and verifying the backup, then resetting…"
                  : "Resetting application data…"}{" "}
                Keep this page open.
              </output>
            )}
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={
                  busy || confirmation !== "DELETE ALL" || (backup && !plan.data?.backupAvailable)
                }
              >
                {busy ? "Resetting…" : "Delete all application data"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}
