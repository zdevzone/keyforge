import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Bell, Check, CheckCheck, CircleDot, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Button as IconButton } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { request } from "../api";
import {
  Button,
  Card,
  Spinner,
  ErrorNote,
  Modal,
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components";
import { ActionButton } from "../components/ActionButton";
import { Checkbox } from "../components/Checkbox";
import { Choice } from "../components/Choice";
import { ListPagination, useListPage } from "../components/ListPagination";
import { Tooltip } from "../components/Tooltip";
import { useProduct, useAction, Feedback } from "../platform-ui";

type Notification = {
  id: string;
  title: string;
  detail: string;
  kind: string;
  href: string;
  date: string;
  createdAt: string;
  read: boolean;
};
type Feed = {
  items: Notification[];
  preferences: Record<"messages" | "assignments" | "expirations", boolean>;
};
type Bulk = {
  action: "read" | "unread" | "delete";
  scope: "selected" | "matching" | "all";
  filter?: string;
  eventIds?: string[];
  confirmed?: boolean;
};
function useNotifications() {
  const { id } = useProduct(),
    base = "/admin/products/" + id + "/notifications";
  const query = useQuery({
    queryKey: ["notifications", id],
    queryFn: () => request<Feed>(base),
    refetchInterval: 30000,
  });
  return { query, base, id };
}
function timestamp(value: string) {
  return new Date(value).toLocaleString();
}
export function NotificationPreferences() {
  const { query: q, base } = useNotifications();
  const action = useAction(() => q.refetch());
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Notification preferences</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        In-app alerts for the active product. Expiration reminders appear within 30, 7 and 1 days.
      </p>
      <div className="arc-theme mt-4 flex flex-col gap-4">
        {(["messages", "assignments", "expirations"] as const).map((key) => (
          <Checkbox
            key={key}
            label={
              {
                messages: "Customer messages",
                assignments: "Conversations assigned to you",
                expirations: "Upcoming license expirations",
              }[key]
            }
            checked={q.data.preferences[key]}
            disabled={action.busy}
            onCheckedChange={(checked) =>
              void action.run(() =>
                request(base + "/preferences", {
                  method: "PUT",
                  body: { ...q.data.preferences, [key]: checked === true },
                }),
              )
            }
          />
        ))}
      </div>
      <Feedback action={action} />
    </Card>
  );
}
export default function Notifications({ embedded = false }: { embedded?: boolean }) {
  const { query: q, base, id } = useNotifications();
  const [filter, setFilter] = useState("all");
  const [selection, setSelection] = useState<{ key: string; ids: Set<string>; matching: boolean }>({
    key: "",
    ids: new Set(),
    matching: false,
  });
  const [deletion, setDeletion] = useState<{ input: Bulk; count: number; label: string } | null>(
    null,
  );
  const action = useAction(() => {
    setSelection({ key: "", ids: new Set(), matching: false });
    void q.refetch();
  });
  const items = q.data?.items ?? [];
  const matching = items.filter((n) => filter === "all" || (filter === "read" ? n.read : !n.read));
  const key = id + ":" + filter;
  const selected =
    selection.key === key ? selection : { key, ids: new Set<string>(), matching: false };
  const page = useListPage(matching, key);
  const selectedIds = selected.matching
    ? matching.map((n) => n.id)
    : matching.filter((n) => selected.ids.has(n.id)).map((n) => n.id);
  const pageSelected = page.rows.filter((n) => selectedIds.includes(n.id)).length;
  const run = (input: Bulk) =>
    void action.run(
      () => request(base + "/bulk", { method: "POST", body: input }),
      "Notifications updated.",
    );
  function bulk(operation: Bulk["action"], all = false) {
    const input: Bulk = {
      action: operation,
      scope: all ? "all" : selected.matching ? "matching" : "selected",
      filter,
      ...(all || selected.matching ? {} : { eventIds: selectedIds }),
    };
    if (operation === "delete")
      setDeletion({
        input,
        count: all ? items.length : selectedIds.length,
        label: all
          ? "all notifications for this product"
          : selected.matching
            ? "all matching notifications"
            : "selected notifications",
      });
    else run(input);
  }
  if (q.isPending) return <Spinner />;
  if (q.error) return <ErrorNote message={q.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className={embedded ? "text-base font-semibold" : "text-xl font-semibold"}>
          Notifications
        </h2>
        <p className="text-muted-foreground">
          Your product updates and attention history. Updates refresh every 30 seconds.
        </p>
        <Link to="/settings?tab=preferences" className="text-sm text-primary underline">
          Notification preferences
        </Link>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Choice
          label="Show notifications"
          searchable={false}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "unread", label: "Unread" },
            { value: "read", label: "Read" },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label="Mark all notifications as read"
            icon={CheckCheck}
            disabled={action.busy || !items.some((n) => !n.read)}
            onClick={() => bulk("read", true)}
          />
          <ActionButton
            label="Delete all notifications"
            icon={Trash2}
            variant="danger"
            disabled={action.busy || !items.length}
            onClick={() => bulk("delete", true)}
          />
        </div>
      </div>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm" aria-live="polite">
            {selectedIds.length} selected
            {selected.matching
              ? " across all matching pages"
              : " individually or on the current page"}
          </p>
          <div className="flex flex-wrap gap-2">
            <ActionButton
              label="Mark selected as read"
              icon={CheckCheck}
              disabled={action.busy || !selectedIds.length}
              onClick={() => bulk("read")}
            />
            <ActionButton
              label="Mark selected as unread"
              icon={CircleDot}
              disabled={action.busy || !selectedIds.length}
              onClick={() => bulk("unread")}
            />
            <ActionButton
              label="Delete selected"
              icon={Trash2}
              variant="danger"
              disabled={action.busy || !selectedIds.length}
              onClick={() => bulk("delete")}
            />
          </div>
        </div>
        {pageSelected === page.rows.length &&
          page.rows.length > 0 &&
          matching.length > page.rows.length &&
          !selected.matching && (
            <p className="px-4 pb-4 text-sm">
              Current page selected.{" "}
              <Button
                variant="secondary"
                onClick={() => setSelection({ key, ids: new Set(), matching: true })}
              >
                Select all {matching.length} matching notifications
              </Button>
            </p>
          )}
        {selectedIds.length > 0 && (
          <div className="px-4 pb-3">
            <Button
              variant="secondary"
              onClick={() => setSelection({ key, ids: new Set(), matching: false })}
            >
              Clear selection
            </Button>
          </div>
        )}
        <p className="px-4 pb-3 text-sm text-muted-foreground md:hidden">
          Scroll the table horizontally to view timestamps and Details.
        </p>
        <Table className="notifications-grid">
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="arc-theme">
                  <Checkbox
                    aria-label="Select current page"
                    disabled={action.busy || !page.rows.length}
                    checked={
                      pageSelected === 0
                        ? false
                        : pageSelected === page.rows.length
                          ? true
                          : "indeterminate"
                    }
                    onCheckedChange={(checked) =>
                      setSelection({
                        key,
                        matching: false,
                        ids:
                          checked === true
                            ? new Set([...selectedIds, ...page.rows.map((n) => n.id)])
                            : new Set(
                                selectedIds.filter((v) => !page.rows.some((n) => n.id === v)),
                              ),
                      })
                    }
                  />
                </span>
              </TableHead>
              <TableHead>Notification</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.map((n) => (
              <TableRow key={n.id}>
                <TableCell>
                  <span className="arc-theme">
                    <Checkbox
                      aria-label={"Select " + n.title}
                      checked={selectedIds.includes(n.id)}
                      disabled={action.busy}
                      onCheckedChange={(checked) =>
                        setSelection({
                          key,
                          matching: false,
                          ids: new Set(
                            checked === true
                              ? [...selectedIds, n.id]
                              : selectedIds.filter((v) => v !== n.id),
                          ),
                        })
                      }
                    />
                  </span>
                </TableCell>
                <TableCell className="notification-copy">
                  <p className="font-medium">{n.title}</p>
                  <p className="text-sm text-muted-foreground">{n.detail}</p>
                  {n.kind === "expiration" && (
                    <p className="text-xs text-muted-foreground">Expires {timestamp(n.date)}</p>
                  )}
                </TableCell>
                <TableCell>
                  <time dateTime={n.createdAt}>{timestamp(n.createdAt)}</time>
                </TableCell>
                <TableCell>
                  <span className={n.read ? "text-muted-foreground" : "font-medium text-primary"}>
                    {n.read ? "Read" : "Unread"}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    to={n.href}
                    className="inline-flex min-h-9 items-center justify-end gap-2 text-primary underline"
                    aria-label={"Details for " + n.title}
                  >
                    Details
                    <ArrowUpRight size={16} aria-hidden="true" />
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!matching.length && (
          <p className="p-6">No {filter === "all" ? "" : filter + " "}notifications.</p>
        )}
        <ListPagination {...page} label="Notification pages" />
      </Card>
      <Feedback action={action} />
      {deletion && (
        <DeleteNotificationDialog
          deletion={deletion}
          base={base}
          onClose={() => setDeletion(null)}
          onDeleted={() => {
            setSelection({ key: "", ids: new Set(), matching: false });
            setDeletion(null);
            void q.refetch();
          }}
        />
      )}
    </div>
  );
}
function DeleteNotificationDialog({
  deletion,
  base,
  onClose,
  onDeleted,
}: {
  deletion: { input: Bulk; count: number; label: string };
  base: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const action = useAction(onDeleted);
  return (
    <Modal title="Delete notifications?" onClose={() => !action.busy && onClose()}>
      <p>
        Delete {deletion.count} {deletion.label}? This removes them from your notification history.
        Conversation and license records are preserved.
      </p>
      <div className="mt-5 flex justify-end gap-3">
        <Button variant="secondary" disabled={action.busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={action.busy}
          onClick={() =>
            void action.run(
              () =>
                request(base + "/bulk", {
                  method: "POST",
                  body: { ...deletion.input, confirmed: true },
                }),
              "Notifications deleted.",
            )
          }
        >
          Confirm deletion
        </Button>
      </div>
      <Feedback action={action} />
    </Modal>
  );
}
export function NotificationBell() {
  const { query: q, base } = useNotifications();
  const [open, setOpen] = useState(false);
  const action = useAction(() => q.refetch());
  const recent = useMemo(() => (q.data?.items ?? []).slice(0, 5), [q.data]);
  const unread = q.data?.items.filter((item) => !item.read).length ?? 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Recent notifications" side="bottom">
        <PopoverTrigger asChild>
          <IconButton
            variant="ghost"
            size="icon"
            aria-label="Recent notifications"
            className="relative shrink-0"
          >
            <Bell aria-hidden="true" />
            {unread > 0 && (
              <span className="notification-count" aria-label={unread + " unread notifications"}>
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </IconButton>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        align="end"
        className="notification-popover w-96 max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="font-semibold">Notifications</h2>
          <span className="text-xs text-muted-foreground">{unread} unread</span>
        </div>
        <ul aria-label="Recent notifications" className="max-h-96 overflow-y-auto divide-y">
          {recent.map((item) => (
            <li
              key={item.id}
              className={item.read ? "notification-item" : "notification-item notification-unread"}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {!item.read && (
                    <CircleDot className="size-3 shrink-0 text-primary" aria-label="Unread" />
                  )}
                  <p className="text-sm font-medium">{item.title}</p>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</p>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <Link
                    to={item.href}
                    onClick={() => setOpen(false)}
                    className="text-xs text-primary underline"
                  >
                    View details
                  </Link>
                  <time dateTime={item.createdAt} className="text-xs text-muted-foreground">
                    {new Date(item.createdAt).toLocaleDateString()}
                  </time>
                </div>
              </div>
              <Tooltip content={item.read ? "Mark as unread" : "Mark as read"}>
                <IconButton
                  variant="ghost"
                  size="icon"
                  disabled={action.busy}
                  aria-label={item.read ? "Mark as unread" : "Mark as read"}
                  onClick={() =>
                    void action.run(() =>
                      request(base + "/bulk", {
                        method: "POST",
                        body: {
                          action: item.read ? "unread" : "read",
                          scope: "selected",
                          eventIds: [item.id],
                        },
                      }),
                    )
                  }
                >
                  {item.read ? <CircleDot aria-hidden="true" /> : <Check aria-hidden="true" />}
                </IconButton>
              </Tooltip>
            </li>
          ))}
        </ul>
        {recent.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {q.isPending ? "Loading notifications…" : "No recent notifications."}
          </p>
        )}
        <div className="flex flex-col gap-2 border-t p-3">
          {q.error && <ErrorNote message={q.error.message} />}
          <Feedback action={action} />
          <IconButton variant="ghost" asChild>
            <Link to="/settings?tab=notifications" onClick={() => setOpen(false)}>
              View all notifications
              <ArrowUpRight data-icon="inline-end" />
            </Link>
          </IconButton>
        </div>
      </PopoverContent>
    </Popover>
  );
}
