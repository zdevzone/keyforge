import { useQuery } from "@tanstack/react-query";
import { Download, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, useId } from "react";

import { Input } from "@/components/ui/input";

import { request } from "../api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components";
import { Button, Card, Modal, ErrorNote, Spinner, TextField, formatDateTime } from "../components";
import { ActionButton } from "../components/ActionButton";
import { useListPage, ListPagination } from "../components/ListPagination";
import { download, Feedback, Select, useAction } from "../platform-ui";

interface Schedule {
  enabled: boolean;
  hourUTC: number;
  minuteUTC?: number;
  retentionDays: number;
  revision: number;
}
interface Endpoint {
  name: string;
  url: string;
  method: "POST" | "PUT";
  format: "multipart" | "raw";
  fileField: string;
  headerName?: string;
  headerValueEnv?: string;
  archived: boolean;
  revision?: number;
}
interface Destination {
  id: string;
  name: string;
  type: string;
  configured: boolean;
  reason?: string;
  config?: Endpoint;
  schedule: Schedule | null;
}
interface Job {
  id: string;
  status: string;
  phase?: string;
  destination: string;
  destinationName?: string;
  createdAt: string;
  error?: string;
  retentionError?: string;
  cacheAvailable?: boolean;
  canDownload: boolean;
  pruned?: boolean;
  size?: number;
  verifiedAt?: string;
  remoteRetained?: boolean;
}
interface BackupState {
  destinations: Destination[];
  jobs: Job[];
  archiveEncryption: boolean;
  engine: string;
  authSnapshotAvailable: boolean;
  workerError?: string;
}

export default function Backups({ embedded = false }: { embedded?: boolean }) {
  const query = useQuery({
    queryKey: ["backups"],
    queryFn: () => request<BackupState>("/admin/backups"),
    refetchInterval: 3000,
  });
  const action = useAction(() => void query.refetch());
  const manualAction = useAction(() => void query.refetch());
  const [manualJob, setManualJob] = useState<string | null>(null),
    [editing, setEditing] = useState<Destination | "new" | null>(null),
    [filter, setFilter] = useState("all");
  const processed = useRef<string | null>(null);
  useEffect(() => {
    const job = query.data?.jobs.find((j) => j.id === manualJob);
    if (!job || !["completed", "failed"].includes(job.status) || processed.current === job.id)
      return;
    processed.current = job.id;
    void manualAction
      .run(async () => {
        if (job.status === "failed") throw new Error(job.error || "Backup failed.");
        await download("/admin/backups/" + job.id + "/download", job.id + ".kfbackup");
      }, "Backup downloaded.")
      .finally(() => setManualJob(null));
  }, [query.data, manualJob, manualAction]);
  const jobsPage = useListPage<Job>(
    (query.data?.jobs ?? []).filter((j) => filter === "all" || j.destination === filter),
    filter,
  );
  if (query.isPending) return <Spinner label="Loading backup destinations…" />;
  if (query.error) return <ErrorNote message={(query.error as Error).message} />;
  const data = query.data;
  async function createLocalDownload() {
    const result = await request<{ job: Job }>("/admin/backups", {
      method: "POST",
      body: { destination: "local" },
    });
    setManualJob(result.job.id);
  }
  const jobs = data.jobs.filter((j) => filter === "all" || j.destination === filter);
  return (
    <div className="space-y-6">
      <div>
        <h2 className={embedded ? "text-base font-semibold" : "text-xl font-semibold"}>Backups</h2>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Download a snapshot, or send encrypted archives to any configured destination. Each
          destination has its own daily UTC schedule.
        </p>
      </div>
      {data.workerError && <ErrorNote message={data.workerError} />}
      <Card className="p-6">
        <h2 className="font-semibold">Manual download</h2>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          {data.engine === "sqlite"
            ? "Download one consistent SQLite snapshot containing licenses, operators and sessions."
            : "Prepare an encrypted Postgres archive and download it when the snapshot completes."}
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {data.engine === "sqlite" ? (
            <Button
              disabled={manualAction.busy}
              onClick={() =>
                void manualAction.run(
                  () => download("/admin/backup/database", "keyforge.sqlite"),
                  "Unified database downloaded.",
                )
              }
            >
              Download database now
            </Button>
          ) : (
            <Button
              disabled={manualAction.busy || Boolean(manualJob) || !data.archiveEncryption}
              onClick={() => void manualAction.run(createLocalDownload, "Preparing download…")}
            >
              {manualJob ? "Preparing download…" : "Download backup now"}
            </Button>
          )}
        </div>
        <Feedback action={manualAction} />
      </Card>
      {!data.archiveEncryption && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Configure the backup encryption key ring to upload or schedule archives. Immediate SQLite
          downloads remain available.
        </p>
      )}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 p-6">
          <div>
            <h2 className="font-semibold">Backup destinations</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Provider credentials are detected on the server. Access is checked when a backup runs.
            </p>
          </div>
          <Button variant="secondary" onClick={() => setEditing("new")}>
            Add upload endpoint
          </Button>
        </div>
        <div className="divide-y divide-slate-200">
          {data.destinations.map((d) => (
            <DestinationPanel
              key={d.id + ":" + (d.schedule?.revision ?? 0) + ":" + (d.config?.revision ?? 0)}
              destination={d}
              encryption={data.archiveEncryption}
              refresh={() => void query.refetch()}
              edit={() => setEditing(d)}
            />
          ))}
        </div>
      </Card>
      {editing && (
        <EndpointEditor
          key={typeof editing === "string" ? "new" : editing.id}
          destination={typeof editing === "string" ? undefined : editing}
          done={() => {
            setEditing(null);
            void query.refetch();
          }}
          cancel={() => setEditing(null)}
        />
      )}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 p-6">
          <div>
            <h2 className="font-semibold">Backup history</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              An encrypted local copy is retained for downloads, including when a remote upload
              fails.
            </p>
          </div>
          <Select
            label="Filter destination"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All destinations" },
              ...Array.from(
                new Map([
                  ...data.destinations.map((d) => [d.id, d.name] as const),
                  ...data.jobs.map(
                    (j) => [j.destination, j.destinationName || j.destination] as const,
                  ),
                ]).entries(),
              ).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <p className="px-6 pt-4 text-sm text-muted-foreground md:hidden">
          Scroll the table horizontally for download and verification actions.
        </p>
        <div className="overflow-x-auto">
          <Table className="w-full text-left text-sm">
            <TableHeader>
              <TableRow>
                {["Created", "Destination", "Result", "Archive", "Actions"].map((h) => (
                  <TableHead
                    key={h}
                    className={"px-5 py-3 font-medium" + (h === "Actions" ? " text-right" : "")}
                  >
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-slate-200">
              {jobsPage.rows.map((j) => (
                <TableRow key={j.id} className="align-top">
                  <TableCell className="whitespace-nowrap px-5 py-4">
                    {formatDateTime(j.createdAt)}
                    <p className="mt-1 text-xs text-muted-foreground">{j.id.slice(0, 8)}</p>
                  </TableCell>
                  <TableCell className="px-5 py-4">{j.destinationName || j.destination}</TableCell>
                  <TableCell className="max-w-sm px-5 py-4">
                    <span
                      className={
                        j.status === "failed"
                          ? "font-medium text-red-700"
                          : j.status === "completed"
                            ? "font-medium text-emerald-700"
                            : "text-slate-700"
                      }
                    >
                      {j.status === "completed"
                        ? "Completed"
                        : j.status === "failed"
                          ? "Failed"
                          : j.status === "running"
                            ? j.phase === "upload"
                              ? "Uploading"
                              : "Creating snapshot"
                            : "Queued"}
                    </span>
                    {j.error && <p className="mt-2 text-sm text-red-700">{j.error}</p>}
                    {j.retentionError && (
                      <p className="mt-2 text-sm text-amber-800">Retention: {j.retentionError}</p>
                    )}
                  </TableCell>
                  <TableCell className="px-5 py-4">
                    {j.pruned
                      ? "Retention expired"
                      : j.size
                        ? Math.ceil(j.size / 1024) + " KiB"
                        : "—"}
                    {j.verifiedAt && (
                      <p className="mt-1 text-xs text-emerald-700">Restore verified</p>
                    )}
                    {j.remoteRetained && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Endpoint manages remote retention
                      </p>
                    )}
                  </TableCell>
                  <TableCell aria-label="Backup actions" className="px-5 py-4 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <ActionButton
                        icon={Download}
                        label="Download"
                        variant="secondary"
                        disabled={action.busy || !j.canDownload}
                        onClick={() =>
                          void action.run(
                            () =>
                              download("/admin/backups/" + j.id + "/download", j.id + ".kfbackup"),
                            "Archive downloaded.",
                          )
                        }
                      />
                      <ActionButton
                        icon={ShieldCheck}
                        label="Verify"
                        variant="secondary"
                        disabled={action.busy || !j.canDownload}
                        onClick={() =>
                          void action.run(
                            () =>
                              request("/admin/backups/" + j.id + "/verify", {
                                method: "POST",
                                body: {},
                              }),
                            "Isolated restore verified.",
                          )
                        }
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <ListPagination {...jobsPage} />
        {!jobs.length && (
          <p className="p-8 text-sm text-muted-foreground">
            No backup jobs for this selection. Choose Back up now on a configured destination to
            create one.
          </p>
        )}
        <div className="px-6 pb-5">
          <Feedback action={action} />
        </div>
      </Card>
      <p className="text-sm text-muted-foreground">
        Signing and encryption keys are excluded from archives. Keep their recovery copies
        separately. Production restore remains a maintenance-mode CLI operation.
      </p>
    </div>
  );
}
function DestinationPanel({
  destination: d,
  encryption,
  refresh,
  edit,
}: {
  destination: Destination;
  encryption: boolean;
  refresh: () => void;
  edit: () => void;
}) {
  const controlId = useId();
  const [scheduling, setScheduling] = useState(false);
  const [enabled, setEnabled] = useState(d.schedule?.enabled ?? false),
    [time, setTime] = useState(
      String(d.schedule?.hourUTC ?? 2).padStart(2, "0") +
        ":" +
        String(d.schedule?.minuteUTC ?? 0).padStart(2, "0"),
    ),
    [days, setDays] = useState(String(d.schedule?.retentionDays ?? 30));
  const action = useAction(refresh);
  const timeParts = time.split(":").map(Number);
  const settingNames: Record<string, string> = {
    s3: "LICENSE_BACKUP_S3_BUCKET and AWS credentials (or dedicated backup S3 keys)",
    r2: "LICENSE_BACKUP_R2_BUCKET, account ID or endpoint, and R2 S3 access keys",
    uploadthing: "LICENSE_BACKUP_UPLOADTHING_TOKEN or UPLOADTHING_TOKEN",
  };
  return (
    <section aria-label={d.name + " backup destination"} className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-semibold">{d.name}</h3>
            <span
              className={
                "rounded px-2 py-1 text-xs font-medium " +
                (d.configured ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-700")
              }
            >
              {d.configured ? "Configured" : "Not configured"}
            </span>
          </div>
          <p className="mt-2 max-w-prose text-sm text-muted-foreground">
            {d.type === "local"
              ? "Encrypted archives on this server."
              : d.type === "custom"
                ? "Upload to your endpoint using " +
                  d.config?.method +
                  " and " +
                  (d.config?.format === "raw" ? "a raw file body." : "a multipart file form.")
                : "Encrypted archives stored with " + d.name + "."}
          </p>
          {!d.configured && <p className="mt-2 text-sm text-muted-foreground">{d.reason}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {d.config && (
            <Button variant="secondary" onClick={edit}>
              Edit endpoint
            </Button>
          )}
          <Button
            disabled={action.busy || !d.configured || !encryption}
            onClick={() =>
              void action.run(
                () => request("/admin/backups", { method: "POST", body: { destination: d.id } }),
                "Backup queued.",
              )
            }
          >
            {action.busy ? "Working…" : "Back up now"}
          </Button>
        </div>
      </div>
      {settingNames[d.id] && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-700">Server configuration</summary>
          <p className="mt-2 break-words text-muted-foreground">
            Set {settingNames[d.id]}, then restart the server. Credentials are never returned to
            this page.
          </p>
        </details>
      )}
      {(d.configured || d.schedule) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {d.schedule?.enabled
              ? "Daily at " +
                String(d.schedule.hourUTC).padStart(2, "0") +
                ":" +
                String(d.schedule.minuteUTC ?? 0).padStart(2, "0") +
                " UTC · " +
                d.schedule.retentionDays +
                " days retention"
              : "Automatic backups off"}
          </p>
          <Button variant="secondary" onClick={() => setScheduling(true)}>
            Edit schedule
          </Button>
        </div>
      )}
      {scheduling && (
        <Modal title={d.name + " backup schedule"} onClose={() => setScheduling(false)}>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void action
                .run(
                  () =>
                    request("/admin/backups/destinations/" + d.id + "/schedule", {
                      method: "PUT",
                      body: {
                        enabled,
                        hourUTC: timeParts[0],
                        minuteUTC: timeParts[1],
                        retentionDays: Number(days),
                        ...(d.schedule ? { revision: d.schedule.revision } : {}),
                      },
                    }),
                  "Schedule saved.",
                )
                .then((ok) => {
                  if (ok) setScheduling(false);
                });
            }}
          >
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
                <input
                  className="peer sr-only"
                  role="switch"
                  aria-checked={enabled}
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span
                  aria-hidden="true"
                  className="relative h-6 w-11 rounded-full bg-slate-300 peer-checked:bg-slate-900 peer-focus-visible:ring-2 peer-focus-visible:ring-slate-600 peer-focus-visible:ring-offset-2 after:absolute after:left-1 after:top-1 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-5"
                />
                Scheduled backups
              </label>
              <label htmlFor={controlId + "-time"} className="text-sm font-medium">
                Daily time (UTC)
                <Input
                  id={controlId + "-time"}
                  type="time"
                  required
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="mt-1 block rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              <label htmlFor={controlId + "-retention"} className="text-sm font-medium">
                Retention days
                <Input
                  id={controlId + "-retention"}
                  type="number"
                  required
                  min="1"
                  max="3650"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                  className="mt-1 block w-28 rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              <Button
                type="submit"
                variant="secondary"
                disabled={action.busy || (enabled && (!d.configured || !encryption))}
              >
                Save schedule
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              {d.schedule?.enabled
                ? "Automatic backup is enabled for this destination."
                : "Automatic backup is off. Manual backups remain available."}
              {d.type === "custom"
                ? " Retention removes the local copy; remote retention is managed by your endpoint."
                : ""}
            </p>
          </form>
          <Feedback action={action} />
        </Modal>
      )}
      <Feedback action={action} />
    </section>
  );
}
function EndpointEditor({
  destination,
  done,
  cancel,
}: {
  destination?: Destination;
  done: () => void;
  cancel: () => void;
}) {
  const config = destination?.config;
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.querySelector("input")?.focus();
  }, []);
  const [name, setName] = useState(config?.name || ""),
    [url, setURL] = useState(config?.url || ""),
    [method, setMethod] = useState<string>(config?.method || "POST"),
    [format, setFormat] = useState<string>(config?.format || "multipart"),
    [field, setField] = useState(config?.fileField || "file"),
    [header, setHeader] = useState(config?.headerName || ""),
    [secretEnv, setSecretEnv] = useState(config?.headerValueEnv || "");
  const action = useAction();
  function body(archived = false) {
    return {
      name,
      url,
      method,
      format,
      fileField: field,
      archived,
      ...(header ? { headerName: header } : {}),
      ...(secretEnv ? { headerValueEnv: secretEnv } : {}),
      ...(config?.revision ? { revision: config.revision } : {}),
    };
  }
  async function save(archived = false) {
    const ok = await action.run(
      () =>
        request(
          destination
            ? "/admin/backups/destinations/" + destination.id
            : "/admin/backups/destinations",
          { method: destination ? "PUT" : "POST", body: body(archived) },
        ),
      archived ? "Endpoint removed." : "Endpoint saved.",
    );
    if (ok) done();
  }
  return (
    <Modal title={destination ? "Edit upload endpoint" : "Add upload endpoint"} onClose={cancel}>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        Use a URL that accepts file uploads. Authentication is optional; endpoint storage is managed
        by its owner.
      </p>
      <form
        ref={formRef}
        className="mt-5 max-w-2xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField label="Destination name" value={name} onChange={setName} required />
        <TextField
          label="Upload URL"
          type="url"
          value={url}
          onChange={setURL}
          required
          placeholder="https://storage.example.com/upload"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="HTTP method"
            value={method}
            onChange={setMethod}
            options={[
              { value: "POST", label: "POST" },
              { value: "PUT", label: "PUT" },
            ]}
          />
          <Select
            label="Upload format"
            value={format}
            onChange={setFormat}
            options={[
              { value: "multipart", label: "Multipart file form" },
              { value: "raw", label: "Raw file body" },
            ]}
          />
        </div>
        {format === "multipart" && (
          <TextField label="File field name" value={field} onChange={setField} required />
        )}
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Optional authorization header</summary>
          <div className="mt-4 space-y-4">
            <TextField
              label="Header name"
              value={header}
              onChange={setHeader}
              placeholder="Authorization"
            />
            <TextField
              label="Secret environment variable"
              value={secretEnv}
              onChange={setSecretEnv}
              placeholder="LICENSE_BACKUP_CUSTOM_BOX_TOKEN"
            />
            <p className="text-muted-foreground">
              Set the complete header value on the server in a LICENSE_BACKUP_CUSTOM_ environment
              variable. Leave both fields empty for public endpoints.
            </p>
          </div>
        </details>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={action.busy}>
            Save endpoint
          </Button>
          <Button variant="secondary" onClick={cancel}>
            Cancel
          </Button>
          {destination && (
            <Button variant="danger" disabled={action.busy} onClick={() => void save(true)}>
              Remove endpoint
            </Button>
          )}
        </div>
        <Feedback action={action} />
      </form>
    </Modal>
  );
}
