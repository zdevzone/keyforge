import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { fetchAdminConfig, type AdminFeature, type OperatorRole } from "../api";
import { authClient } from "../auth-client";
import { Button, Card, ErrorNote, Modal, Spinner, TextField, formatDateTime } from "../components";

/**
 * Operator management, built on Better Auth's admin plugin.
 *
 * Everything here is also enforced server-side: this page renders from the
 * role the server reports, and the server refuses the calls regardless of what
 * the browser chooses to display.
 */

interface Operator {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  createdAt?: string | Date | null;
}

interface OperatorSession {
  id: string;
  token: string;
  createdAt?: string | Date | null;
  expiresAt?: string | Date | null;
  userAgent?: string | null;
}

function roleLabel(role: string | null | undefined): OperatorRole {
  return role === "admin" ? "admin" : "support";
}

function RoleBadge(props: { role: string | null | undefined }) {
  const role = roleLabel(props.role);
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        role === "admin"
          ? "bg-slate-900 text-white ring-slate-900"
          : "bg-slate-50 text-slate-600 ring-slate-300"
      }`}
    >
      {role}
    </span>
  );
}

export default function Operators() {
  const queryClient = useQueryClient();
  const { data: config } = useQuery({
    queryKey: ["admin-config"],
    queryFn: fetchAdminConfig,
    staleTime: Infinity,
  });
  const [creating, setCreating] = useState(false);
  const [passwordFor, setPasswordFor] = useState<Operator | null>(null);
  const [sessionsFor, setSessionsFor] = useState<Operator | null>(null);
  const [removing, setRemoving] = useState<Operator | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const scope = new Set<AdminFeature>(config?.adminScope ?? []);
  const viewer = config?.viewer;

  const operatorsQuery = useQuery({
    queryKey: ["operators"],
    queryFn: async () => {
      const { data, error } = await authClient.admin.listUsers({ query: { limit: 200 } });
      if (error) throw new Error(error.message ?? "Could not list operators.");
      return (data?.users ?? []) as Operator[];
    },
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["operators"] });
  };

  const run = async (label: string, fn: () => Promise<{ error?: { message?: string } | null }>) => {
    setActionError(null);
    const { error } = await fn();
    if (error) {
      setActionError(`${label}: ${error.message ?? "failed"}`);
      return false;
    }
    invalidate();
    return true;
  };

  if (operatorsQuery.isPending) return <Spinner label="Loading operators…" />;
  if (operatorsQuery.error) return <ErrorNote message={(operatorsQuery.error as Error).message} />;

  const operators = operatorsQuery.data;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">Operators</h1>
          <p className="mt-1 text-sm text-slate-500">
            Who can sign in to this console. <strong>admin</strong> runs the counter and manages
            operators; <strong>support</strong> reads everything and can release activations.
          </p>
        </div>
        {scope.has("operators") && <Button onClick={() => setCreating(true)}>Add operator</Button>}
      </div>

      {actionError && <ErrorNote message={actionError} />}

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-5 py-3 font-medium">Operator</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Added</th>
              <th className="px-5 py-3">
                {/* The actions column. Named for screen readers, which
                      otherwise announce nothing at all for this column. */}
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {operators.map((operator) => {
              const isSelf = viewer?.actor === operator.email;
              return (
                <tr key={operator.id} className="align-middle hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <div className="font-medium">
                      {operator.email}
                      {isSelf && <span className="ml-2 text-xs text-slate-400">(you)</span>}
                    </div>
                    {operator.banned && (
                      <div className="text-xs text-red-600">
                        banned{operator.banReason ? `: ${operator.banReason}` : ""}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <RoleBadge role={operator.role} />
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap text-slate-500">
                    {operator.createdAt ? formatDateTime(String(operator.createdAt)) : "—"}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-wrap justify-end gap-2">
                      {scope.has("operators") && !isSelf && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            void run("Change role", () =>
                              authClient.admin.setRole({
                                userId: operator.id,
                                role: roleLabel(operator.role) === "admin" ? "support" : "admin",
                              }),
                            )
                          }
                        >
                          Make {roleLabel(operator.role) === "admin" ? "support" : "admin"}
                        </Button>
                      )}
                      {scope.has("operators") && (
                        <Button variant="secondary" onClick={() => setPasswordFor(operator)}>
                          Set password
                        </Button>
                      )}
                      {scope.has("sessions") && (
                        <Button variant="secondary" onClick={() => setSessionsFor(operator)}>
                          Sessions
                        </Button>
                      )}
                      {scope.has("bans") && !isSelf && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            void run(operator.banned ? "Unban" : "Ban", () =>
                              operator.banned
                                ? authClient.admin.unbanUser({ userId: operator.id })
                                : authClient.admin.banUser({ userId: operator.id }),
                            )
                          }
                        >
                          {operator.banned ? "Unban" : "Ban"}
                        </Button>
                      )}
                      {scope.has("impersonation") && !isSelf && (
                        <Button
                          variant="secondary"
                          onClick={() =>
                            void run("Impersonate", () =>
                              authClient.admin.impersonateUser({ userId: operator.id }),
                            ).then((ok) => {
                              if (ok) window.location.assign("/");
                            })
                          }
                        >
                          Impersonate
                        </Button>
                      )}
                      {scope.has("operators") && !isSelf && (
                        <Button variant="danger" onClick={() => setRemoving(operator)}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {operators.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-slate-400">
                  No operators yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {creating && (
        <CreateOperator
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            invalidate();
          }}
        />
      )}

      {passwordFor && (
        <SetPassword
          operator={passwordFor}
          onClose={() => setPasswordFor(null)}
          onDone={() => setPasswordFor(null)}
        />
      )}

      {sessionsFor && <Sessions operator={sessionsFor} onClose={() => setSessionsFor(null)} />}

      {removing && (
        <Modal title="Remove this operator?" onClose={() => setRemoving(null)}>
          <p className="text-sm text-slate-600">
            <span className="font-medium">{removing.email}</span> will lose access immediately and
            their sessions end. The audit entries they created stay in the log.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                void run("Remove operator", () =>
                  authClient.admin.removeUser({ userId: removing.id }),
                ).then((ok) => ok && setRemoving(null))
              }
            >
              Remove operator
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CreateOperator(props: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<OperatorRole>("support");

  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.admin.createUser({
        email: email.trim(),
        password,
        name: name.trim() || email.trim(),
        role,
      });
      if (error) throw new Error(error.message ?? "Could not create the operator.");
    },
    onSuccess: props.onCreated,
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <Modal title="Add an operator" onClose={props.onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <TextField label="Email" type="email" required value={email} onChange={setEmail} />
        <TextField label="Name (optional)" value={name} onChange={setName} />
        <TextField
          label="Password"
          type="password"
          required
          value={password}
          onChange={setPassword}
        />
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Role</span>
          <div className="mt-1 flex gap-2">
            {(["support", "admin"] as OperatorRole[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRole(option)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  role === option
                    ? "bg-slate-900 text-white"
                    : "border border-slate-300 text-slate-600 hover:bg-slate-100"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {role === "admin"
              ? "Full access: issue, edit and revoke licenses, download backups, manage operators."
              : "Read-only on licenses, plus releasing activations for seat transfers."}
          </p>
        </label>
        {mutation.error && <ErrorNote message={(mutation.error as Error).message} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Adding…" : "Add operator"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SetPassword(props: { operator: Operator; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.admin.setUserPassword({
        userId: props.operator.id,
        newPassword: password,
      });
      if (error) throw new Error(error.message ?? "Could not set the password.");
    },
    onSuccess: props.onDone,
  });

  return (
    <Modal title={`Set password for ${props.operator.email}`} onClose={props.onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
        className="space-y-4"
      >
        <TextField
          label="New password"
          type="password"
          required
          value={password}
          onChange={setPassword}
        />
        {mutation.error && <ErrorNote message={(mutation.error as Error).message} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Setting…" : "Set password"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Sessions(props: { operator: Operator; onClose: () => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["operator-sessions", props.operator.id],
    queryFn: async () => {
      const { data, error } = await authClient.admin.listUserSessions({
        userId: props.operator.id,
      });
      if (error) throw new Error(error.message ?? "Could not list sessions.");
      return (data?.sessions ?? []) as OperatorSession[];
    },
  });

  const revokeAll = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.admin.revokeUserSessions({ userId: props.operator.id });
      if (error) throw new Error(error.message ?? "Could not revoke sessions.");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["operator-sessions", props.operator.id] });
    },
  });

  return (
    <Modal title={`Sessions for ${props.operator.email}`} onClose={props.onClose}>
      {query.isPending ? (
        <Spinner label="Loading sessions…" />
      ) : query.error ? (
        <ErrorNote message={(query.error as Error).message} />
      ) : (
        <>
          <ul className="divide-y divide-slate-100 text-sm">
            {query.data.map((session) => (
              <li key={session.id} className="py-2">
                <div className="text-slate-700">
                  {session.createdAt ? formatDateTime(String(session.createdAt)) : "—"}
                </div>
                <div className="truncate text-xs text-slate-400">{session.userAgent ?? "—"}</div>
              </li>
            ))}
            {query.data.length === 0 && (
              <li className="py-4 text-center text-slate-400">No active sessions.</li>
            )}
          </ul>
          {revokeAll.error && (
            <div className="mt-3">
              <ErrorNote message={(revokeAll.error as Error).message} />
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={props.onClose}>
              Close
            </Button>
            <Button
              variant="danger"
              disabled={revokeAll.isPending || query.data.length === 0}
              onClick={() => revokeAll.mutate()}
            >
              {revokeAll.isPending ? "Revoking…" : "Revoke all sessions"}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
