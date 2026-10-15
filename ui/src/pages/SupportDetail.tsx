import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { fetchSupportRequest, request, productPath } from "../api";
import { Textarea } from "../components";
import { Button, Card, ErrorNote, Spinner, formatDateTime } from "../components";
import { ConversationThread } from "../components/ConversationThread";
import { useListPage, ListPagination } from "../components/ListPagination";
import { Feedback, Select, useAction } from "../platform-ui";

const states = ["queued", "in_progress", "waiting_customer", "resolved", "closed"];

export default function SupportDetail() {
  const { id = "" } = useParams(),
    query = useQuery({ queryKey: ["support", id], queryFn: () => fetchSupportRequest(id) });

  if (query.isPending) return <Spinner label="Opening support request…" />;

  if (query.error) return <ErrorNote message={(query.error as Error).message} />;

  return (
    <TicketEditor
      key={query.data.request.id}

      ticket={query.data.request}

      refresh={() => query.refetch()}
    />
  );
}

function TicketEditor({ ticket, refresh }: { ticket: any; refresh: () => Promise<unknown> }) {
  const [draftStatus, setStatus] = useState<string | null>(null),
    [draftAssignee, setAssignee] = useState<string | null>(null),
    [message, setMessage] = useState(""),
    [internal, setInternal] = useState(false);

  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  const directory = useQuery({
    queryKey: ["operator-directory"],

    queryFn: () => request<any>("/admin/operators/directory"),
  });

  const workflowAction = useAction(refresh),
    conversationAction = useAction(refresh);

  const busy = workflowAction.busy || conversationAction.busy;

  const [history, setHistory] = useState("public");

  const publicMessages = [
    {
      id: "original",
      author: "customer",
      body: ticket.message,
      createdAt: ticket.receivedAt,
      internal: false,
    },
    ...ticket.messages,
  ];

  const historyPage = useListPage<any>(
    publicMessages.filter((m) => (history === "notes" ? m.internal : !m.internal)).reverse(),
    history,
    50,
  );

  const participants = Array.from(new Set<string>(publicMessages.map((m) => m.author))).map(
    (author) => ({
      id: author,
      name: author === "customer" ? ticket.reporterName || "Customer" : author,
    }),
  );

  useEffect(() => {
    void request(productPath("/support/" + ticket.id + "/read"), {
      method: "POST",
      body: { lastMessageId: ticket.messages.at(-1)?.id ?? "original" },
    }).catch(() => {});
  }, [ticket.id, ticket.messages]);

  const status = draftStatus ?? ticket.status;

  const assignee = draftAssignee ?? (ticket.assignedTo || "");

  return (
    <div className="space-y-6">
      <div>
        <Link to="/support" className="text-sm underline">
          Support inbox
        </Link>
        <h1 className="mt-4 text-xl font-semibold">{ticket.subject}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {ticket.category} · {ticket.urgency} · Received {formatDateTime(ticket.receivedAt)}
        </p>
      </div>
      <Card className="p-6">
        <h2 className="font-semibold">Workflow</h2>
        <form
          className="mt-4 space-y-4"

          onSubmit={(e) => {
            e.preventDefault();

            void workflowAction

              .run(
                () =>
                  request(productPath("/support/" + ticket.id), {
                    method: "PATCH",

                    body: { status, assignedTo: assignee || null, revision: ticket.revision },
                  }),
                "Request updated.",
              )

              .then((ok) => {
                if (ok) {
                  setStatus(null);

                  setAssignee(null);
                }
              });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              label="Status"

              value={status}

              onChange={setStatus}

              options={states.map((s) => ({ value: s, label: s.replaceAll("_", " ") }))}
            />
            <Select
              label="Assigned operator"

              value={assignee}

              onChange={setAssignee}

              options={[
                { value: "", label: "Unassigned" },

                ...(directory.data?.operators || []).map((o: any) => ({
                  value: o.email,

                  label: o.name + " · " + o.email,
                })),
              ]}
            />
          </div>
          <Button type="submit" disabled={busy}>
            Update request
          </Button>
          <Feedback action={workflowAction} />
        </form>
      </Card>
      <Card className="p-6">
        <h2 className="font-semibold">Conversation</h2>
        <p className="my-3 text-sm text-muted-foreground">
          Customer replies are available to the authenticated dependent app. Internal notes are
          visible only to operators.
        </p>
        <Select
          label="Conversation history"
          value={history}
          onChange={setHistory}
          options={[
            { value: "public", label: "Customer conversation" },
            { value: "notes", label: "Internal operator notes" },
          ]}
        />
        {history === "notes" && (
          <p className="my-3 font-medium">Private · never sent to the customer</p>
        )}
        <div className="arc-theme conversation-thread mt-4">
          <ConversationThread
            participants={participants}
            messages={[...historyPage.rows]
              .reverse()
              .map((m) => ({ id: m.id, authorId: m.author, text: m.body, createdAt: m.createdAt }))}
            internal={history === "notes"}
            label={history === "notes" ? "Private operator notes" : "Customer conversation"}
          />
        </div>
        <ListPagination {...historyPage} label="Conversation history pages (newest first)" />
        {ticket.status !== "closed" ? (
          <form
            className="mt-6 space-y-3"

            onSubmit={(e) => {
              e.preventDefault();

              void conversationAction

                .run(
                  () =>
                    request(productPath("/support/" + ticket.id + "/messages"), {
                      method: "POST",

                      body: { requestId, message, internal, revision: ticket.revision },
                    }),
                  internal
                    ? "Internal note added."
                    : "Reply saved for the dependent app to retrieve.",
                )

                .then((ok) => {
                  if (ok) {
                    setMessage("");

                    setRequestId(crypto.randomUUID());
                  }
                });
            }}
          >
            <label className="block text-sm font-medium" htmlFor="support-reply">
              {internal ? "Internal note" : "Customer reply"}
            </label>
            <Textarea
              id="support-reply"

              required

              minLength={1}

              maxLength={5000}

              value={message}

              onChange={(e) => {
                setMessage(e.target.value);

                setRequestId(crypto.randomUUID());
              }}

              rows={5}

              className="w-full rounded-lg border border-slate-300 p-3 text-sm"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"

                checked={internal}

                onChange={(e) => {
                  setInternal(e.target.checked);

                  setRequestId(crypto.randomUUID());
                }}
              />
              Internal note — hidden from customers
            </label>
            <Button type="submit" disabled={busy}>
              {internal ? "Add note" : "Send reply"}
            </Button>
            <Feedback action={conversationAction} />
          </form>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            Closed requests cannot receive new messages. Reopen the request or create a new case.
          </p>
        )}
      </Card>
      <Card className="p-6">
        <h2 className="font-semibold">Related records</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted-foreground">License</dt>
            <dd>
              <Link to={"/licenses/" + ticket.licenseId} className="font-mono text-xs underline">
                {ticket.licenseId}
              </Link>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Installation</dt>
            <dd className="break-all font-mono text-xs">{ticket.installationId}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Application</dt>
            <dd className="text-sm">
              {[ticket.appVersion, ticket.platform].filter(Boolean).join(" · ") || "Not supplied"}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted-foreground">Server reference</dt>
            <dd className="break-all font-mono text-xs">{ticket.id}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
