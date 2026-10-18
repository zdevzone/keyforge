import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { atomic, DomainError, type Records, type RecordValue } from "./platform-store.js";
import type { Platform, Grant, Plan } from "./platform.js";

export const money = z.number().int().min(0).max(100_000_000_000);
/** Prices remain in the existing catalog price records, expressed in santim. */
export async function planPrice(records: Records, scope: string, plan: string) {
  const own = await records.get<any>(scope, "price", plan);
  const fallback = await records.get<any>(scope, "price", "__product__");
  return own?.amount ?? fallback?.amount ?? null;
}
const date = z.iso.date();
export const saleSchema = z
  .object({
    requestId: z.string().uuid(),
    licenseId: z.string().min(1),
    kind: z.enum(["initial", "renewal"]),
    date,
    listAmount: money,
    discount: money,
    amount: money,
    dueDate: date.nullable().default(null),
    note: z.string().trim().max(1000).default(""),
  })
  .strict()
  .refine(
    (v) => v.discount <= v.listAmount && v.amount === v.listAmount - v.discount,
    "Selling price must equal list price minus discount.",
  );
export interface Sale extends RecordValue {
  licenseId: string;
  kind: string;
  date: string;
  listAmount: number;
  discount: number;
  amount: number;
  dueDate: string | null;
  note: string;
  customer: string;
  plan: string;
  currency: "ETB";
  actor: string;
  createdAt: string;
  requestId: string;
}
export interface Entry extends RecordValue {
  saleId: string;
  kind: "payment" | "refund" | "credit";
  amount: number;
  date: string;
  paymentId: string | null;
  method: string;
  reference: string;
  reason: string;
  actor: string;
  createdAt: string;
  requestId: string;
}
export function balance(sale: Sale, entries: Entry[], asOf = "9999-12-31") {
  const rows = entries.filter((e) => e.saleId === sale.id && e.date <= asOf);
  const sum = (kind: Entry["kind"]) =>
    rows.filter((e) => e.kind === kind).reduce((n, e) => n + e.amount, 0);
  const received = sum("payment"),
    refunded = sum("refund"),
    credited = sum("credit");
  const outstanding = sale.amount - credited - received + refunded;
  return {
    received,
    refunded,
    credited,
    outstanding,
    netReceived: received - refunded,
    status:
      sale.amount === 0
        ? "complimentary"
        : sale.amount === credited
          ? "credited"
          : outstanding === 0
            ? "paid"
            : received > refunded
              ? "partially_paid"
              : "unpaid",
  };
}
export const paymentFields = z
  .object({
    date,
    method: z.string().trim().min(1).max(100),
    reference: z.string().trim().min(1).max(200),
  })
  .strict();
const entrySchema = z
  .object({
    requestId: z.string().uuid(),
    kind: z.enum(["payment", "refund", "credit"]),
    amount: money.refine((n) => n > 0),
    date,
    paymentId: z.string().nullable().default(null),
    method: z.string().trim().max(100).default(""),
    reference: z.string().trim().max(200).default(""),
    reason: z.string().trim().max(1000).default(""),
  })
  .strict();

export function registerFinance(app: FastifyInstance, p: Platform, wrap: any, ap: string) {
  const scope = (id: string) => "product:" + id;
  const today = () => p.time().slice(0, 10);
  app.get(
    ap + "/finance",
    wrap(
      async (req: any) => {
        const s = scope(req.params.productId);
        const sales = await p.records.list<Sale>(s, "sale"),
          entries = await p.records.list<Entry>(s, "financial_entry");
        const pricing = await p.records.list<any>(s, "price");
        const licenses = await p.records.list<Grant>(s, "license");
        const plans = await p.records.list<Plan>(s, "plan");
        return {
          currency: "ETB",
          sales: sales
            .map((v) => ({ ...v, ...balance(v, entries) }))
            .sort((a, b) => b.date.localeCompare(a.date)),
          entries,
          pricing,
          licenses: licenses.map((l) => ({
            id: l.id,
            customer: l.issuedTo,
            plan: l.plan,
            hasSale: sales.some((s) => s.licenseId === l.id),
          })),
          plans: plans.map((p) => ({ id: p.id, description: p.description })),
        };
      },
      true,
      true,
    ),
  );
  app.put(
    ap + "/finance/prices/:priceId",
    wrap(
      async (req: any) => {
        const input = z
          .object({ amount: money.nullable(), revision: z.number().int().optional() })
          .strict()
          .parse(req.body);
        const s = scope(req.params.productId),
          id = req.params.priceId;
        await atomic(p.options.database, async (r) => {
          if (id !== "__product__" && !(await r.get(s, "plan", id)))
            throw new DomainError("unknown_plan", "No such plan.", 404);
          await r.put(
            s,
            "price",
            { id, ...input, currency: "ETB", updatedAt: p.time() },
            input.revision,
          );
        });
        await p.audit(req.actor, "finance.price", req.params.productId, { priceId: id });
        return { ok: true };
      },
      true,
      true,
    ),
  );
  app.post(
    ap + "/finance/sales",
    wrap(
      async (req: any) => {
        const input = saleSchema.parse(req.body),
          s = scope(req.params.productId);
        if (input.date > today())
          throw new DomainError("future_date", "Sale date cannot be in the future.");
        const result = await atomic(p.options.database, async (r) => {
          const old = await r.get<Sale>(s, "sale", input.requestId);
          if (old) {
            if (Object.entries(input).some(([k, v]) => old[k as keyof Sale] !== v))
              throw new DomainError("idempotency_conflict", "Request already used.", 409);
            return old;
          }
          const license = await r.get<Grant>(s, "license", input.licenseId);
          if (!license) throw new DomainError("unknown_license", "No such license.", 404);
          if (license.importAccountId)
            throw new DomainError(
              "use_license_renewal",
              "Record import-account purchases through the license renewal workflow.",
              409,
            );
          if (
            input.kind === "initial" &&
            (await r.list<Sale>(s, "sale")).some(
              (v) => v.licenseId === license.id && v.kind === "initial",
            )
          )
            throw new DomainError(
              "initial_sale_exists",
              "Record a renewal for subsequent sales.",
              409,
            );
          const sale: Sale = {
            ...input,
            id: input.requestId,
            customer: license.issuedTo,
            plan: license.plan,
            currency: "ETB",
            actor: req.actor,
            createdAt: p.time(),
          };
          await r.put(s, "sale", sale);
          return sale;
        });
        await p.audit(req.actor, "finance.sale", req.params.productId, { saleId: result.id });
        return { sale: result };
      },
      true,
      true,
    ),
  );
  app.post(
    ap + "/finance/sales/:saleId/entries",
    wrap(
      async (req: any) => {
        const input = entrySchema.parse(req.body),
          s = scope(req.params.productId);
        if (input.date > today())
          throw new DomainError("future_date", "Transaction date cannot be in the future.");
        const result = await atomic(p.options.database, async (r) => {
          const sale = await r.get<Sale>(s, "sale", req.params.saleId);
          if (!sale) throw new DomainError("unknown_sale", "No such sale.", 404);
          const old = await r.get<Entry>(s, "financial_entry", input.requestId);
          if (old) {
            if (
              old.saleId !== sale.id ||
              Object.entries(input).some(([k, v]) => old[k as keyof Entry] !== v)
            )
              throw new DomainError("idempotency_conflict", "Request already used.", 409);
            return old;
          }
          if (input.date < sale.date)
            throw new DomainError("invalid_date", "Transaction cannot precede the sale.");
          const entries = await r.list<Entry>(s, "financial_entry"),
            b = balance(sale, entries);
          if (input.kind === "payment" && input.amount > b.outstanding)
            throw new DomainError("overpayment", "Amount exceeds outstanding balance.");
          if (input.kind !== "payment" && !input.reason)
            throw new DomainError("reason_required", "A reason is required.");
          if (input.kind === "credit" && input.amount > b.outstanding)
            throw new DomainError(
              "excess_credit",
              "Credit exceeds outstanding balance. Record any cash refund first.",
            );
          if (input.kind === "refund") {
            const payment = entries.find(
              (e) => e.id === input.paymentId && e.saleId === sale.id && e.kind === "payment",
            );
            if (
              !payment ||
              input.date < payment.date ||
              input.amount >
                payment.amount -
                  entries
                    .filter((e) => e.kind === "refund" && e.paymentId === payment.id)
                    .reduce((n, e) => n + e.amount, 0)
            )
              throw new DomainError(
                "invalid_refund",
                "Refund must reference a receipt and cannot exceed its remaining amount.",
              );
          } else if (input.paymentId)
            throw new DomainError("invalid_payment_reference", "Only refunds reference a receipt.");
          const entry: Entry = {
            ...input,
            id: input.requestId,
            saleId: sale.id,
            actor: req.actor,
            createdAt: p.time(),
          };
          const dates = new Set([
            ...entries.filter((e) => e.saleId === sale.id).map((e) => e.date),
            entry.date,
          ]);
          if ([...dates].some((d) => balance(sale, [...entries, entry], d).outstanding < 0))
            throw new DomainError(
              "historical_overpayment",
              "This date would overpay a historical balance. Check the transaction date.",
            );
          await r.put(s, "financial_entry", entry);
          return entry;
        });
        await p.audit(req.actor, "finance." + input.kind, req.params.productId, {
          entryId: result.id,
          saleId: req.params.saleId,
        });
        return { entry: result };
      },
      true,
      true,
    ),
  );
  app.get(
    ap + "/finance/report",
    wrap(
      async (req: any) => {
        const q = z
          .object({
            from: date.optional(),
            to: date.optional(),
            customer: z.string().max(200).default(""),
          })
          .refine((v) => !v.from || !v.to || v.from <= v.to, "Invalid date range")
          .parse(req.query);
        const s = scope(req.params.productId),
          to = q.to ?? today();
        const sales = (await p.records.list<Sale>(s, "sale")).filter(
          (v) => v.customer.toLowerCase().includes(q.customer.toLowerCase()) && v.date <= to,
        );
        const ids = new Set(sales.map((v) => v.id));
        const entries = (await p.records.list<Entry>(s, "financial_entry")).filter(
          (v) => ids.has(v.saleId) && v.date <= to,
        );
        const periodSales = sales.filter((v) => !q.from || v.date >= q.from),
          periodEntries = entries.filter((v) => !q.from || v.date >= q.from);
        const sum = (kind: Entry["kind"]) =>
          periodEntries.filter((v) => v.kind === kind).reduce((n, v) => n + v.amount, 0);
        return {
          currency: "ETB",
          asOf: to,
          salesValue: periodSales.reduce((n, v) => n + v.amount, 0),
          received: sum("payment"),
          refunds: sum("refund"),
          credits: sum("credit"),
          netReceived: sum("payment") - sum("refund"),
          outstanding: sales.reduce((n, v) => n + balance(v, entries, to).outstanding, 0),
          sales: periodSales,
          entries: periodEntries,
          balances: sales.map((v) => ({ ...v, ...balance(v, entries, to) })),
        };
      },
      true,
      true,
    ),
  );
}
