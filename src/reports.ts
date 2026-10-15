import { z } from "zod";

import type { Grant, Ticket } from "./platform.js";

export const reportQuerySchema = z
  .object({
    type: z
      .enum(["licenses", "expirations", "usage", "activations", "support"])
      .default("licenses"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    customer: z.string().max(200).default(""),
    status: z.string().max(40).default("all"),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, "Start date must not follow end date.");
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export interface ReportRow {
  id: string;
  customer: string;
  status: string;
  date: string | null;
  [key: string]: string | number | null;
}
export interface ReportBinding {
  id: string;
  licenseId: string;
  installationId: string;
  activatedAt: string;
  deactivatedAt: string | null;
}
export interface ReportUsage {
  id: string;
  licenseId: string;
  meterId: string;
  period: string;
  consumed: number;
}

export function buildReport(
  query: ReportQuery,
  licenses: Grant[],
  records: (Ticket | ReportBinding | ReportUsage)[],
  now: string,
) {
  const grants = new Map(licenses.map((l) => [l.id, l]));
  const status = (l: Grant) =>
    l.status === "revoked"
      ? "revoked"
      : l.expiresAt && Date.parse(l.expiresAt) <= Date.parse(now)
        ? "expired"
        : "active";
  let rows: ReportRow[];
  if (query.type === "licenses" || query.type === "expirations") {
    rows = licenses
      .filter((l) => query.type !== "expirations" || l.expiresAt)
      .map((l) => ({
        id: l.id,
        customer: l.issuedTo,
        plan: l.plan,
        status: status(l),
        date: query.type === "expirations" ? l.expiresAt : l.issuedAt,
        expiresAt: l.expiresAt,
        seats: l.activationLimit,
      }));
  } else if (query.type === "usage") {
    rows = (records as ReportUsage[]).map((u) => ({
      id: u.id,
      customer: grants.get(u.licenseId)?.issuedTo || "",
      licenseId: u.licenseId,
      meter: u.meterId,
      period: u.period,
      consumed: u.consumed,
      status: grants.has(u.licenseId) ? status(grants.get(u.licenseId)!) : "unknown",
      date: u.period === "lifetime" ? null : u.period + (u.period.length === 7 ? "-01" : ""),
    }));
  } else if (query.type === "activations") {
    rows = (records as ReportBinding[]).map((b) => ({
      id: b.id,
      customer: grants.get(b.licenseId)?.issuedTo || "",
      licenseId: b.licenseId,
      installation: b.installationId,
      status: b.deactivatedAt ? "released" : "active",
      date: b.activatedAt,
      releasedAt: b.deactivatedAt,
    }));
  } else {
    rows = (records as Ticket[]).map((t) => ({
      id: t.id,
      customer: grants.get(t.licenseId)?.issuedTo || t.reporterName || "",
      subject: t.subject,
      category: t.category,
      urgency: t.urgency,
      status: t.status,
      date: t.receivedAt,
    }));
  }
  const customer = query.customer.trim().toLowerCase();
  rows = rows
    .filter((row) => {
      if (customer && !row.customer.toLowerCase().includes(customer)) return false;
      if (query.status !== "all" && row.status !== query.status) return false;
      const day = row.date ? new Date(row.date).toISOString().slice(0, 10) : undefined;
      // Usage is a bucket total, not an event ledger. Include whole monthly buckets
      // overlapping the range; undated lifetime totals only belong in all-time views.
      let end = day;
      if (query.type === "usage" && typeof row.period === "string" && row.period.length === 7)
        end = new Date(Date.UTC(Number(row.period.slice(0, 4)), Number(row.period.slice(5, 7)), 0))
          .toISOString()
          .slice(0, 10);
      return (
        (!query.from || Boolean(end && end >= query.from)) &&
        (!query.to || Boolean(day && day <= query.to))
      );
    })
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || a.id.localeCompare(b.id));
  return {
    type: query.type,
    generatedAt: now,
    rows,
    counts: Object.fromEntries(
      [...new Set(rows.map((r) => r.status))].map((s) => [
        s,
        rows.filter((r) => r.status === s).length,
      ]),
    ),
    // Different meters may measure different units; never sum across meters.
    meters:
      query.type === "usage"
        ? Object.fromEntries(
            [...new Set(rows.map((r) => String(r.meter)))].map((m) => [
              m,
              rows.filter((r) => r.meter === m).reduce((sum, r) => sum + Number(r.consumed), 0),
            ]),
          )
        : {},
  };
}
