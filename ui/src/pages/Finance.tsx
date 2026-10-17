import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Plus, SlidersHorizontal, ReceiptText, CheckCheck } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { request, fetchAdminConfig } from "../api";
import {
  Button,
  Card,
  Modal,
  TextField,
  Spinner,
  ErrorNote,
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "../components";
import { ActionButton } from "../components/ActionButton";
import { Choice } from "../components/Choice";
import { DateField } from "../components/DateField";
import { ListPagination, useListPage } from "../components/ListPagination";
import { PaymentFields } from "../components/PaymentFields";
import { useProduct, useAction, Feedback } from "../platform-ui";
export const birr = (n: number) =>
  new Intl.NumberFormat("en", { style: "currency", currency: "ETB" }).format(n / 100);
export function minor(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new Error("Enter an ETB amount with at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(n)) throw new Error("Amount is too large.");
  return n;
}
export function exportRows(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown) =>
    '"' +
    String(v ?? "")
      .replace(/^[\s]*[=+@-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  const csv = [keys, ...rows.map((r) => keys.map((k) => r[k]))]
    .map((r) => r.map(cell).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Finance() {
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  if (config.isPending) return <Spinner />;
  if (config.data?.viewer.role !== "admin")
    return <ErrorNote message="Financial records require an admin account." />;
  return <FinanceContent />;
}
function FinanceContent() {
  const cache = useQueryClient();
  const { id } = useProduct();
  const [params] = useSearchParams();
  const base = "/admin/products/" + encodeURIComponent(id) + "/finance";
  const query = useQuery({ queryKey: ["finance", id], queryFn: () => request<any>(base) });
  const [panel, setPanel] = useState<string | null>(null),
    [search, setSearch] = useState("");
  const [paying, setPaying] = useState<any>(null);
  const rows = (query.data?.sales ?? []).filter((s: any) =>
    (s.customer + " " + s.licenseId).toLowerCase().includes(search.toLowerCase()),
  );
  const page = useListPage<any>(rows, search + id);
  if (query.isPending) return <Spinner />;
  if (query.error) return <ErrorNote message={query.error.message} />;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Sales & payments</h1>
          <p className="text-muted-foreground">
            New licenses create sales automatically. Record receipts here when payment arrives.
          </p>
          <Link className="text-primary underline" to="/reports/financial">
            Financial reports
          </Link>
        </div>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            icon={SlidersHorizontal}
            label="Default prices"
            onClick={() => setPanel("prices")}
          />
          <ActionButton icon={Plus} label="Record sale" onClick={() => setPanel("new")} />
        </div>
      </div>
      <Card>
        <div className="p-5">
          <TextField label="Find customer or license" value={search} onChange={setSearch} />
          <p className="mt-2 text-sm text-muted-foreground">
            {query.data.licenses.filter((l: any) => !l.hasSale).length} licenses have no sales
            record. This does not mean they are paid or free.
          </p>
        </div>
        <p className="px-5 py-2 text-xs text-muted-foreground sm:hidden">
          Scroll the table horizontally to see all amounts and actions.
        </p>
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              {[
                "Customer / license",
                "Sale",
                "Selling price",
                "Received / refunded",
                "Outstanding",
                "Actions",
              ].map((h) => (
                <TableHead
                  key={h}
                  className={
                    ["Actions", "Selling price", "Received / refunded", "Outstanding"].includes(h)
                      ? "text-right"
                      : ""
                  }
                >
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.rows.map((s: any) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link className="text-primary underline" to={"/licenses/" + s.licenseId}>
                    {s.customer || "Unnamed customer"}
                  </Link>
                  <p className="text-xs text-muted-foreground">{s.plan}</p>
                </TableCell>
                <TableCell>
                  {s.date}
                  <p>
                    {s.kind} · {s.status.replaceAll("_", " ")}
                  </p>
                </TableCell>
                <TableCell className="text-right">{birr(s.amount)}</TableCell>
                <TableCell className="text-right">
                  {birr(s.received)} / {birr(s.refunded)}
                </TableCell>
                <TableCell className="text-right">{birr(s.outstanding)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {s.outstanding > 0 && (
                      <ActionButton
                        icon={CheckCheck}
                        label="Mark as paid"
                        onClick={() => setPaying(s)}
                      />
                    )}
                    <ActionButton
                      icon={ReceiptText}
                      label="Transactions"
                      onClick={() => setPanel(s.id)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell colSpan={6}>No sales recorded for this filter.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <ListPagination {...page} />
      </Card>
      {paying && (
        <Modal title="Mark as paid" onClose={() => setPaying(null)}>
          <MarkPaid
            sale={paying}
            base={base}
            done={async () => {
              await query.refetch();
              await cache.invalidateQueries({ queryKey: ["financial-report"] });
              setPaying(null);
            }}
          />
        </Modal>
      )}
      {panel && (
        <Modal
          title={
            panel === "new"
              ? "Record license sale"
              : panel === "prices"
                ? "Default prices · ETB"
                : "Sale transactions"
          }
          onClose={() => setPanel(null)}
        >
          {panel === "new" ? (
            <SaleForm
              key={id}
              data={query.data}
              base={base}
              initialLicense={params.get("license") ?? ""}
              done={async () => {
                await query.refetch();
                setPanel(null);
              }}
            />
          ) : panel === "prices" ? (
            <Prices data={query.data} base={base} refresh={() => query.refetch()} />
          ) : (
            <Transactions
              sale={query.data.sales.find((s: any) => s.id === panel)}
              entries={query.data.entries.filter((e: any) => e.saleId === panel)}
              base={base}
              refresh={() => query.refetch()}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
function SaleForm({
  data,
  base,
  done,
  initialLicense,
}: {
  data: any;
  base: string;
  done: () => Promise<void>;
  initialLicense: string;
}) {
  const [license, setLicense] = useState(initialLicense),
    [kind, setKind] = useState("initial"),
    [price, setPrice] = useState(""),
    [discount, setDiscount] = useState("0"),
    [date, setDate] = useState(() => new Date().toISOString().slice(0, 10)),
    [due, setDue] = useState(""),
    [note, setNote] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const action = useAction();
  const chosen = data.licenses.find((l: any) => l.id === license);
  const preset =
    data.pricing.find((p: any) => p.id === chosen?.plan && p.amount !== null) ??
    data.pricing.find((p: any) => p.id === "__product__");
  const amount = price || (preset?.amount == null ? "" : String(preset.amount / 100));
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await request(base + "/sales", {
            method: "POST",
            body: {
              requestId,
              licenseId: license,
              kind: chosen?.hasSale ? "renewal" : kind,
              date,
              listAmount: minor(amount),
              discount: minor(discount),
              amount: minor(amount) - minor(discount),
              dueDate: due || null,
              note,
            },
          });
          await done();
        });
      }}
    >
      <Choice
        label="License"
        value={license}
        onChange={(v) => {
          setLicense(v);
          setPrice("");
        }}
        options={data.licenses.map((l: any) => ({
          value: l.id,
          label: (l.customer || "Unnamed") + " · " + l.plan + " · " + l.id,
        }))}
      />
      <Choice
        label="Sale type"
        value={chosen?.hasSale ? "renewal" : kind}
        onChange={setKind}
        options={[
          ...(!chosen?.hasSale ? [{ value: "initial", label: "Historical initial sale" }] : []),
          { value: "renewal", label: "Renewal" },
        ]}
      />
      <p className="text-sm text-muted-foreground">
        A renewal records its financial value. Update license expiry separately when access should
        change.
      </p>
      <TextField label="List price (ETB)" value={amount} onChange={setPrice} required />
      <TextField label="Discount (ETB)" value={discount} onChange={setDiscount} required />
      <p>Selling price: {birr(Number(amount) * 100 - Number(discount) * 100)}</p>
      <DateField label="Sale date" value={date} onChange={setDate} />
      <DateField label="Payment due date" value={due} onChange={setDue} placeholder="No due date" />
      <TextField label="Reference / note" value={note} onChange={setNote} />
      <Button type="submit" disabled={action.busy || !license}>
        Record sale
      </Button>
      <Feedback action={action} />
    </form>
  );
}
function Prices({
  data,
  base,
  refresh,
}: {
  data: any;
  base: string;
  refresh: () => Promise<unknown>;
}) {
  const [target, setTarget] = useState("__product__"),
    [value, setValue] = useState<string | null>(null);
  const action = useAction(refresh);
  const current = data.pricing.find((p: any) => p.id === target);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(() =>
          request(base + "/prices/" + encodeURIComponent(target), {
            method: "PUT",
            body: {
              amount:
                (value ?? (current?.amount == null ? "" : String(current.amount / 100))) === ""
                  ? null
                  : minor(value ?? String(current.amount / 100)),
              revision: current?.revision,
            },
          }),
        );
      }}
    >
      <p>
        Plan prices override the product default. Leave blank to inherit. Existing sales never
        change.
      </p>
      <Choice
        label="Price applies to"
        value={target}
        onChange={(v) => {
          setTarget(v);
          setValue(null);
        }}
        options={[
          { value: "__product__", label: "Product fallback" },
          ...data.plans.map((p: any) => ({ value: p.id, label: "Plan: " + p.id })),
        ]}
      />
      <TextField
        label="Default price (ETB)"
        value={value ?? (current?.amount == null ? "" : String(current.amount / 100))}
        onChange={setValue}
      />
      <Button type="submit" disabled={action.busy}>
        Save price
      </Button>
      <Feedback action={action} />
    </form>
  );
}
function MarkPaid({ sale, base, done }: { sale: any; base: string; done: () => Promise<void> }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10)),
    [method, setMethod] = useState("Bank transfer"),
    [reference, setReference] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const action = useAction(done);
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(() =>
          request(base + "/sales/" + sale.id + "/entries", {
            method: "POST",
            body: { requestId, kind: "payment", amount: sale.outstanding, date, method, reference },
          }),
        );
      }}
    >
      <p>
        Record {birr(sale.outstanding)} received from {sale.customer}. This settles the existing
        sale without creating a license.
      </p>
      <PaymentFields
        method={method}
        reference={reference}
        date={date}
        onMethod={setMethod}
        onReference={setReference}
        onDate={setDate}
      />
      <Button type="submit" disabled={action.busy || !date || !reference.trim()}>
        {action.busy ? "Recording…" : "Mark as paid"}
      </Button>
      <Feedback action={action} />
    </form>
  );
}
function Transactions({
  sale,
  entries,
  base,
  refresh,
}: {
  sale: any;
  entries: any[];
  base: string;
  refresh: () => Promise<unknown>;
}) {
  const [kind, setKind] = useState("payment"),
    [amount, setAmount] = useState(""),
    [date, setDate] = useState(() => new Date().toISOString().slice(0, 10)),
    [reason, setReason] = useState(""),
    [method, setMethod] = useState(""),
    [reference, setReference] = useState(""),
    [payment, setPayment] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const action = useAction(refresh);
  const page = useListPage<any>(entries);
  return (
    <div className="flex flex-col gap-5">
      <p>
        {sale.customer} · {birr(sale.amount)} sold · {birr(sale.outstanding)} outstanding
      </p>
      <ul className="divide-y">
        {page.rows.map((e) => (
          <li className="py-2" key={e.id}>
            {e.date} · {e.kind} · {birr(e.amount)}
            <p className="text-sm text-muted-foreground">
              {e.method} {e.reference} {e.reason} · {e.actor}
            </p>
          </li>
        ))}
      </ul>
      <ListPagination {...page} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await request(base + "/sales/" + sale.id + "/entries", {
              method: "POST",
              body: {
                requestId,
                kind,
                amount: minor(amount),
                date,
                reason,
                method,
                reference,
                paymentId: kind === "refund" ? payment : null,
              },
            });
            setAmount("");
            setRequestId(crypto.randomUUID());
          });
        }}
      >
        <Choice
          label="Transaction"
          value={kind}
          onChange={setKind}
          options={[
            { value: "payment", label: "Payment received" },
            { value: "refund", label: "Cash refund" },
            { value: "credit", label: "Credit / reduce amount owed" },
          ]}
        />
        {kind === "refund" && (
          <Choice
            label="Original payment"
            value={payment}
            onChange={setPayment}
            options={entries
              .filter((e) => e.kind === "payment")
              .map((e) => ({
                value: e.id,
                label: e.date + " · " + birr(e.amount) + " · " + e.reference,
              }))}
          />
        )}
        <p className="text-sm text-muted-foreground">
          A cash refund returns money and reopens the balance. Add a credit as well when cancelling
          the charge.
        </p>
        <TextField label="Amount (ETB)" value={amount} onChange={setAmount} required />
        <DateField label="Transaction date" value={date} onChange={setDate} />
        <TextField label="Payment method" value={method} onChange={setMethod} />
        <TextField label="Reference" value={reference} onChange={setReference} />
        <TextField
          label="Reason"
          value={reason}
          onChange={setReason}
          required={kind !== "payment"}
        />
        <Button type="submit" disabled={action.busy}>
          Record transaction
        </Button>
        <Feedback action={action} />
      </form>
    </div>
  );
}
export function FinancialReports() {
  const { id, products } = useProduct();
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const [from, setFrom] = useState(""),
    [to, setTo] = useState(() => new Date().toISOString().slice(0, 10)),
    [customer, setCustomer] = useState("");
  const query = useQuery({
    queryKey: ["financial-report", id, from, to, customer],
    queryFn: () =>
      request<any>(
        "/admin/products/" +
          id +
          "/finance/report?" +
          new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}), customer }),
      ),
    enabled: config.data?.viewer.role === "admin",
  });
  const page = useListPage<any>(query.data?.balances ?? [], from + to + customer + id);
  if (config.isPending) return <Spinner />;
  if (config.data?.viewer.role !== "admin")
    return <ErrorNote message="Financial reports require an admin account." />;
  return (
    <div className="report-page flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Financial reports</h1>
        <p>
          ETB only. Sales and cash flows use their own dates. Outstanding is cumulative through the
          end date.
        </p>
        <Link to="/reports" className="text-primary underline">
          Operational reports
        </Link>
      </div>
      <div className="table-toolbar print:hidden">
        <DateField label="From" value={from} onChange={setFrom} placeholder="All dates" />
        <DateField label="Through / as of" value={to} onChange={setTo} />
        <TextField label="Customer" value={customer} onChange={setCustomer} />
      </div>
      {query.error && <ErrorNote message={query.error.message} />}
      {query.isPending && <Spinner />}
      {query.data && (
        <>
          <p className="report-scope text-sm text-muted-foreground">
            Product: {products.find((p) => p.id === id)?.name ?? id} ({id}) · Customer:{" "}
            {customer || "All customers"} · Period: {from || "All dates"} through {query.data.asOf}{" "}
            (UTC) · Balances as of: {query.data.asOf} · Currency: ETB
          </p>
          <dl className="grid gap-4 sm:grid-cols-3">
            {[
              ["Sales value", "salesValue"],
              ["Payments received", "received"],
              ["Refunds paid", "refunds"],
              ["Net receipts", "netReceived"],
              ["Credits issued", "credits"],
              ["Outstanding as of " + query.data.asOf, "outstanding"],
            ].map(([label, key]) => (
              <div key={key}>
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd className="text-xl font-semibold">{birr(query.data[key])}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap gap-2 print:hidden">
            {["sales", "entries", "balances"].map((k) => (
              <ActionButton
                key={k}
                icon={Download}
                label={"Export " + k + " CSV"}
                disabled={!query.data[k].length || query.isFetching}
                onClick={() => exportRows(k + "-ETB-minor-units.csv", query.data[k])}
              />
            ))}
            <Button onClick={() => window.print()}>Print / Save PDF</Button>
          </div>
          <p className="text-sm text-muted-foreground">
            CSV amounts use integer santim (100 = ETB 1.00). Historical balances include all sales
            through the end date.
          </p>
          <Card className="report-screen">
            <p className="px-5 py-2 text-xs text-muted-foreground sm:hidden">
              Scroll the table horizontally to see all amounts and actions.
            </p>
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  {["Customer", "Sale date", "Sale value", "Net receipts", "Outstanding"].map(
                    (h) => (
                      <TableHead key={h}>{h}</TableHead>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.customer}</TableCell>
                    <TableCell>{s.date}</TableCell>
                    <TableCell className="text-right">{birr(s.amount)}</TableCell>
                    <TableCell className="text-right">{birr(s.netReceived)}</TableCell>
                    <TableCell className="text-right">{birr(s.outstanding)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ListPagination {...page} />
          </Card>
          <div className="report-print">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Sale date</th>
                  <th>Sale value ETB</th>
                  <th>Net receipts ETB</th>
                  <th>Outstanding ETB</th>
                </tr>
              </thead>
              <tbody>
                {query.data.balances.map((s: any) => (
                  <tr key={s.id}>
                    <td>{s.customer}</td>
                    <td>{s.date}</td>
                    <td>{birr(s.amount)}</td>
                    <td>{birr(s.netReceived)}</td>
                    <td>{birr(s.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
