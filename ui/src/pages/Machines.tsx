import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";

import { clearMachine, fetchMachines, type Machine } from "../api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components";
import { Button, Card, ErrorNote, Modal, Spinner, formatDate, formatDateTime } from "../components";
import { SignalAvailability } from "../components/DeviceIdentity";

/**
 * The support desk for trials.
 *
 * Built around one moment: a customer is on the phone saying the app claims
 * their trial is used up, and they have a six-character reference to read out.
 * Everything else on this page is secondary to turning that reference into a
 * machine and, when the customer is right, giving it back.
 *
 * Open to support operators as well as admins — the server allows both, and
 * refusing the people who staff the inbox is how a support tool turns into an
 * escalation.
 */

const PAGE_SIZE = 25;

function TrialBadge(props: { state: "fresh" | "spent" }) {
  const spent = props.state === "spent";
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs font-medium ${
        spent ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
      }`}
    >
      {spent ? "spent" : "fresh"}
    </span>
  );
}

export default function Machines() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [clearing, setClearing] = useState<Machine | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const handle = setTimeout(() => {
      setQuery(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  const { data, isPending, error, isPlaceholderData } = useQuery({
    queryKey: ["machines", { q: query, page }],
    queryFn: () => fetchMachines({ q: query, page, pageSize: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });

  const clearMutation = useMutation({
    mutationFn: (id: string) => clearMachine(id),
    onSuccess: () => {
      setClearing(null);
      // The row's trialState flips to "fresh" on the refetch, which is the only
      // confirmation an operator gets that the clear actually landed.
      void queryClient.invalidateQueries({ queryKey: ["machines"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });

  if (isPending) return <Spinner label="Loading machines…" />;
  if (error) return <ErrorNote message={(error as Error).message} />;

  const { machines, total } = data;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Machines</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Reported machine groups in the trial ledger. Matching signals are recognition hints, not
          verified physical-device counts. License seats remain installation-based.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-4">
          <Input
            type="search"
            placeholder="Support reference, machine id, or installation id…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full max-w-sm rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          <span className="text-xs text-muted-foreground">
            The reference is what the customer reads out, e.g.{" "}
            <code className="font-mono">K7QX-2F</code>
          </span>
        </div>
        <div className={`overflow-x-auto ${isPlaceholderData ? "opacity-60" : ""}`}>
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <TableHead className="px-4 py-3 font-medium">Reference</TableHead>
                <TableHead className="px-4 py-3 font-medium">Trial</TableHead>
                <TableHead className="px-4 py-3 font-medium">Regs</TableHead>
                <TableHead className="px-4 py-3 font-medium">Signals</TableHead>
                <TableHead className="px-4 py-3 font-medium">Installations</TableHead>
                <TableHead className="px-4 py-3 font-medium">Last registration</TableHead>
                <TableHead className="px-4 py-3 font-medium">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-slate-100">
              {machines.map((machine) => (
                <TableRow key={machine.id} className="align-top hover:bg-slate-50">
                  <TableCell className="px-4 py-3">
                    <div className="font-mono text-sm font-medium whitespace-nowrap">
                      {machine.supportReference}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{machine.id}</div>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <TrialBadge state={machine.trialState} />
                    {machine.clearedAt && (
                      <div className="mt-1 text-xs text-muted-foreground">
                        cleared {formatDate(machine.clearedAt)}
                      </div>
                    )}
                    {/* The client's own claim, kept apart from the verdict on
                        purpose: it is evidence for the operator reading this
                        row, and the server never lets it decide anything. */}
                    {machine.trialSpentReported && (
                      <div className="mt-1 text-xs text-muted-foreground">client says spent</div>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 tabular-nums">
                    {machine.registrationCount}
                    {machine.recheckCount > 0 && (
                      <div className="text-xs whitespace-nowrap text-muted-foreground">
                        {machine.recheckCount} recheck{machine.recheckCount === 1 ? "" : "s"}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <SignalAvailability
                      kinds={machine.signalKinds}
                      availability={machine.signalAvailability}
                    />
                    {machine.signalsUpdatedAt && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Updated {formatDateTime(machine.signalsUpdatedAt)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[10rem] px-4 py-3">
                    <div className="space-y-0.5">
                      {machine.installationIds.slice(0, 2).map((id) => (
                        <div key={id} className="truncate font-mono text-xs" title={id}>
                          {id}
                        </div>
                      ))}
                      {machine.installationIds.length > 2 && (
                        <div className="text-xs text-muted-foreground">
                          +{machine.installationIds.length - 2} more
                        </div>
                      )}
                      {machine.installationIds.length === 0 && (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs whitespace-nowrap">
                    {formatDateTime(machine.lastRegisteredAt)}
                    <div className="text-muted-foreground">
                      first {formatDate(machine.firstRegisteredAt)}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right">
                    <Button
                      variant="secondary"
                      disabled={machine.trialState === "fresh"}
                      onClick={() => setClearing(machine)}
                    >
                      <RotateCcw aria-hidden="true" />
                      Clear
                    </Button>
                    {machine.trialState === "fresh" && (
                      <div className="mt-1 text-xs whitespace-nowrap text-muted-foreground">
                        already fresh
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {machines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    {query
                      ? "Nothing matches that reference, machine id or installation id."
                      : "No machines yet — the installer reports here on first run."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-5 py-3 text-sm text-muted-foreground">
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

      {clearing && (
        <Modal title="Give this machine its trial back?" onClose={() => setClearing(null)}>
          <p className="text-sm text-muted-foreground">
            <code className="font-mono text-xs">{clearing.supportReference}</code> has registered{" "}
            {clearing.registrationCount} time{clearing.registrationCount === 1 ? "" : "s"} since{" "}
            {formatDate(clearing.firstRegisteredAt)}.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Clearing grants <strong>exactly one more trial</strong>: the next run on that machine
            reads fresh, and the one after it is spent again. It is not a permanent exemption, and
            it does not affect any license the customer holds.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Recorded in the audit log against your name.
          </p>
          {clearMutation.error && (
            <div className="mt-3">
              <ErrorNote message={(clearMutation.error as Error).message} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setClearing(null)}>
              Cancel
            </Button>
            <Button
              disabled={clearMutation.isPending}
              onClick={() => clearMutation.mutate(clearing.id)}
            >
              {clearMutation.isPending ? "Clearing…" : "Clear machine"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
