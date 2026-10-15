import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { request, productPath } from "../api";
import { Card, ErrorNote, Spinner, TextField, formatDateTime } from "../components";
import { Choice } from "../components/Choice";
import { ListPagination } from "../components/ListPagination";
export function SupportUrgencyBadge({ urgency }: { urgency: string }) {
  return <span className="rounded-md bg-muted px-2 py-1 text-xs">{urgency}</span>;
}
export function supportCategoryLabel(category: string) {
  return category.replaceAll("_", " ");
}
export default function Support() {
  const [view, setView] = useState("attention"),
    [status, setStatus] = useState(""),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(1),
    [category, setCategory] = useState(""),
    [urgency, setUrgency] = useState("");
  const query = useQuery({
    queryKey: ["support", view, status, search, page, category, urgency],
    queryFn: () =>
      request<any>(
        productPath("/support?") +
          new URLSearchParams({
            view,
            status,
            q: search,
            category,
            urgency,
            limit: "25",
            offset: String((page - 1) * 25),
          }),
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 30000,
  });
  const choose = (set: (s: string) => void) => (s: string) => {
    set(s);
    setPage(1);
  };
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Support inbox</h1>
        <p className="text-muted-foreground">
          Customer conversations from connected installations. Reply, assign an operator, or leave a
          private note.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField label="Search conversations" value={search} onChange={choose(setSearch)} />
        <Choice
          label="Inbox"
          value={view}
          onChange={choose(setView)}
          options={[
            { value: "attention", label: "Needs attention" },
            { value: "unread", label: "Unread" },
            { value: "mine", label: "Assigned to me" },
            { value: "unassigned", label: "Unassigned" },
            { value: "all", label: "All conversations" },
          ]}
        />
        <Choice
          label="Status"
          value={status}
          onChange={choose(setStatus)}
          options={[
            { value: "", label: "All statuses" },
            ...["queued", "in_progress", "waiting_customer", "resolved", "closed"].map((v) => ({
              value: v,
              label: v.replaceAll("_", " "),
            })),
          ]}
        />
        <Choice
          label="Category"
          value={category}
          onChange={choose(setCategory)}
          options={[
            { value: "", label: "All categories" },
            ...["technical", "licensing", "billing", "feature_request", "other"].map((v) => ({
              value: v,
              label: supportCategoryLabel(v),
            })),
          ]}
        />
        <Choice
          label="Urgency"
          value={urgency}
          onChange={choose(setUrgency)}
          options={[
            { value: "", label: "All urgencies" },
            ...["critical", "high", "normal", "low"].map((v) => ({ value: v, label: v })),
          ]}
        />
      </div>
      {query.error && <ErrorNote message={query.error.message} />}
      {query.isPending ? (
        <Spinner />
      ) : (
        query.data && (
          <Card>
            <ul className="divide-y">
              {query.data.requests.map((t: any) => (
                <li key={t.id}>
                  <Link
                    to={"/support/" + t.id}
                    className="flex flex-col gap-2 p-5 hover:bg-muted/50 focus-visible:outline-2"
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <span className="font-semibold">
                        {t.unread && <span className="mr-2 text-xs text-primary">Unread</span>}
                        {t.subject}
                      </span>
                      <time className="text-xs text-muted-foreground">
                        {formatDateTime(t.updatedAt)}
                      </time>
                    </div>
                    <p className="truncate text-sm">
                      {t.previewInternal && <span className="font-medium">Private note: </span>}
                      {t.preview}
                    </p>
                    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                      <span>{t.reporterName || "Customer"}</span>
                      <span>{t.assignedTo ? "Assigned: " + t.assignedTo : "Unassigned"}</span>
                      <span>{t.status.replaceAll("_", " ")}</span>
                      <span>{t.category}</span>
                      <SupportUrgencyBadge urgency={t.urgency} />
                      {t.needsAttention && <span>Needs reply</span>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            {!query.data.total && <p className="p-6">No conversations match these filters.</p>}
            <ListPagination
              page={page}
              pageCount={Math.max(1, Math.ceil(query.data.total / 25))}
              onPageChange={setPage}
              total={query.data.total}
              size={25}
            />
          </Card>
        )
      )}
    </div>
  );
}
