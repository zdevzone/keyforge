import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { atomic, DomainError, type Records } from "./platform-store.js";
import type { Platform, Grant, Ticket } from "./platform.js";

export function expirationNotice(license: Grant, now: string) {
  if (
    license.status !== "active" ||
    !license.expiresAt ||
    Date.parse(license.expiresAt) < Date.parse(now)
  )
    return null;
  const days = Math.ceil((Date.parse(license.expiresAt) - Date.parse(now)) / 86400000);
  if (days < 0 || days > 30) return null;
  const threshold = days <= 1 ? 1 : days <= 7 ? 7 : 30;
  return {
    id: `expiry:${license.id}:${license.expiresAt}:${threshold}`,
    kind: "expiration",
    title: `License expires ${days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`}`,
    detail: license.issuedTo,
    href: "/licenses/" + license.id,
    date: license.expiresAt,
  };
}
export function registerNotifications(
  app: FastifyInstance,
  p: Platform,
  wrap: any,
  ap: string,
  device: string,
  bearer: any,
) {
  const scope = (id: string) => "product:" + id;
  const prefs = z
    .object({ messages: z.boolean(), assignments: z.boolean(), expirations: z.boolean() })
    .strict();
  const defaults = { messages: true, assignments: true, expirations: true };
  const recipient = (actor: string) => "operator:" + actor;
  async function operatorFeed(records: Records, s: string, actor: string) {
    const owner = recipient(actor);
    const preference = (await records.get<any>(s, "notification_preferences", owner)) ?? defaults;
    const items: any[] = [];
    for (const t of await records.list<Ticket>(s, "ticket")) {
      if (preference.messages && !["closed", "resolved"].includes(t.status)) {
        const last = t.messages.filter((m) => !m.internal).at(-1);
        if (!last || last.author === "customer")
          items.push({
            id: "message:" + t.id + ":" + (last?.id ?? "original"),
            kind: "message",
            title: t.subject,
            detail: "Customer message needs attention",
            href: "/support/" + t.id,
            date: last?.createdAt ?? t.receivedAt,
          });
      }
      if (
        preference.assignments &&
        t.assignedTo === actor &&
        !["closed", "resolved"].includes(t.status)
      )
        items.push({
          id: "assignment:" + t.id + ":" + t.assignedTo,
          kind: "assignment",
          title: t.subject,
          detail: "Assigned to you",
          href: "/support/" + t.id,
          date: t.updatedAt,
        });
    }
    if (preference.messages)
      for (const request of await records.list<any>("workspace:default", "license_request")) {
        if ("product:" + request.productId === s && request.status === "requested")
          items.push({
            id: "request:" + request.id,
            kind: "message",
            title: "License request from " + request.name,
            detail: "Awaiting license issuance",
            href: "/license-requests",
            date: request.createdAt,
          });
      }
    if (preference.expirations)
      for (const l of await records.list<Grant>(s, "license")) {
        const n = expirationNotice(l, p.time());
        if (n) items.push(n);
      }
    const existing = await records.list<any>(s, "notification");
    const known = new Set(existing.filter((n) => n.owner === owner).map((n) => n.eventId));
    for (const n of items) {
      if (known.has(n.id)) continue;
      const record = {
        ...n,
        id: JSON.stringify([owner, n.id]),
        eventId: n.id,
        owner,
        createdAt: p.time(),
      };
      await records.put(s, "notification", record);
      existing.push(record);
    }
    const states = new Map(
      (await records.list<any>(s, "notification_state"))
        .filter((v) => v.owner === owner)
        .map((v) => [v.eventId, v]),
    );
    const reads = new Set(
      (await records.list<any>(s, "notification_read"))
        .filter((v) => v.owner === owner)
        .map((v) => v.eventId),
    );
    return {
      items: existing
        .filter((n) => n.owner === owner && !states.get(n.eventId)?.deleted)
        .map((n) => ({
          id: n.eventId,
          kind: n.kind,
          title: n.title,
          detail: n.detail,
          href: n.href,
          date: n.date,
          createdAt: n.createdAt,
          read: states.get(n.eventId)?.read ?? reads.has(n.eventId),
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
      preferences: { ...defaults, ...preference },
    };
  }
  app.get(
    ap + "/notifications",
    wrap(
      async (req: any) =>
        atomic(p.options.database, (records) =>
          operatorFeed(records, scope(req.params.productId), req.actor),
        ),
      true,
    ),
  );
  app.post(
    ap + "/notifications/bulk",
    wrap(async (req: any) => {
      const input = z
        .object({
          action: z.enum(["read", "unread", "delete"]),
          scope: z.enum(["selected", "matching", "all"]),
          filter: z.enum(["all", "unread", "read"]).default("all"),
          eventIds: z.array(z.string().min(1).max(500)).max(2000).optional(),
          confirmed: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      if (input.action === "delete" && input.confirmed !== true)
        throw new DomainError(
          "notification_confirmation_required",
          "Confirm notification deletion first.",
        );
      if (input.scope === "selected" && !input.eventIds?.length)
        throw new DomainError("notification_selection_required", "Select notifications first.");
      return atomic(p.options.database, async (records) => {
        const s = scope(req.params.productId),
          owner = recipient(req.actor);
        const feed = await operatorFeed(records, s, req.actor);
        const selected = new Set(input.eventIds);
        const items = feed.items.filter((n) =>
          input.scope === "selected"
            ? selected.has(n.id)
            : input.scope === "all" ||
              input.filter === "all" ||
              (input.filter === "read" ? n.read : !n.read),
        );
        for (const n of items)
          await records.put(s, "notification_state", {
            id: JSON.stringify([owner, n.id]),
            owner,
            eventId: n.id,
            read: input.action === "read" ? true : input.action === "unread" ? false : n.read,
            deleted: input.action === "delete",
            updatedAt: p.time(),
          });
        return { ok: true, affected: items.length };
      });
    }, true),
  );
  app.put(
    ap + "/notifications/preferences",
    wrap(async (req: any) => {
      const input = prefs.parse(req.body);
      await atomic(p.options.database, (r) =>
        r.put(scope(req.params.productId), "notification_preferences", {
          id: recipient(req.actor),
          ...input,
        }),
      );
      return { ok: true };
    }, true),
  );
  app.post(
    ap + "/notifications/read",
    wrap(async (req: any) => {
      const { eventId } = z
          .object({ eventId: z.string().min(1).max(500) })
          .strict()
          .parse(req.body),
        owner = recipient(req.actor);
      await atomic(p.options.database, async (r) => {
        const s = scope(req.params.productId),
          id = JSON.stringify([owner, eventId]);
        const previous = await r.get<any>(s, "notification_state", id);
        await r.put(s, "notification_state", {
          id,
          owner,
          eventId,
          read: true,
          deleted: previous?.deleted ?? false,
          readAt: p.time(),
        });
      });
      return { ok: true };
    }, true),
  );
  app.get(
    device + "/installations/:installationId/notifications",
    wrap(async (req: any) => {
      await p.authenticate(req.params.productId, req.params.installationId, bearer(req));
      const s = scope(req.params.productId),
        items: any[] = [];
      const tickets = (await p.records.list<Ticket>(s, "ticket")).filter(
        (t) => t.installationId === req.params.installationId,
      );
      for (const t of tickets) {
        const m = t.messages.filter((m) => !m.internal && m.author !== "customer").at(-1);
        if (m)
          items.push({
            id: "reply:" + m.id,
            kind: "reply",
            title: t.subject,
            ticketId: t.id,
            date: m.createdAt,
          });
      }
      for (const d of await p.records.list<any>(s, "license_delivery")) {
        if (d.installationId === req.params.installationId)
          items.push({
            id: "license:" + d.licenseId,
            kind: "license",
            title: "Your license is ready",
            licenseId: d.licenseId,
            date: d.createdAt,
            deliveryStatus: d.status,
            collectPath:
              "/v1/products/" +
              req.params.productId +
              "/installations/" +
              encodeURIComponent(req.params.installationId) +
              "/licenses/" +
              d.licenseId +
              "/collect",
          });
      }
      const installation = await p.records.get<any>(s, "installation", req.params.installationId);
      if (installation?.licenseId) {
        const l = await p.records.get<Grant>(s, "license", installation.licenseId);
        if (l) {
          const n = expirationNotice(l, p.time());
          if (n)
            items.push({ id: n.id, kind: n.kind, title: n.title, date: n.date, licenseId: l.id });
        }
      }
      const owner = "installation:" + req.params.installationId;
      const preferences = (await p.records.get<any>(s, "notification_preferences", owner)) ?? {
        messages: true,
        expirations: true,
      };
      const reads = new Set(
        (await p.records.list<any>(s, "notification_read"))
          .filter((v) => v.owner === owner)
          .map((v) => v.eventId),
      );
      return {
        items: items
          .filter(
            (n) =>
              n.kind === "license" ||
              (n.kind === "reply" ? preferences.messages : preferences.expirations),
          )
          .map((n) => ({ ...n, read: reads.has(n.id) })),
        preferences: { messages: preferences.messages, expirations: preferences.expirations },
      };
    }),
  );
  app.put(
    device + "/installations/:installationId/notifications/preferences",
    wrap(async (req: any) => {
      await p.authenticate(req.params.productId, req.params.installationId, bearer(req));
      const input = z
        .object({ messages: z.boolean(), expirations: z.boolean() })
        .strict()
        .parse(req.body);
      await atomic(p.options.database, (r) =>
        r.put(scope(req.params.productId), "notification_preferences", {
          id: "installation:" + req.params.installationId,
          ...input,
        }),
      );
      return { ok: true };
    }),
  );
  app.post(
    device + "/installations/:installationId/notifications/read",
    wrap(async (req: any) => {
      await p.authenticate(req.params.productId, req.params.installationId, bearer(req));
      const { eventId } = z
          .object({ eventId: z.string().min(1).max(500) })
          .strict()
          .parse(req.body),
        owner = "installation:" + req.params.installationId;
      await atomic(p.options.database, (r) =>
        r.put(scope(req.params.productId), "notification_read", {
          id: JSON.stringify([owner, eventId]),
          owner,
          eventId,
          readAt: p.time(),
        }),
      );
      return { ok: true };
    }),
  );
}
