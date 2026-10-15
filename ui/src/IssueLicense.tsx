import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

import {
  fetchAdminConfig,
  issueLicense,
  productPath,
  request,
  type IssuedLicense,
  type AdminConfig,
} from "./api";
import { Button, ErrorNote, Modal, TextField, Spinner } from "./components";
import { Checkbox } from "./components/Checkbox";
import { Choice } from "./components/Choice";
import { PaymentFields } from "./components/PaymentFields";
import { birr } from "./pages/Finance";

type Recipients = {
  requests: { id: string; name: string; email: string; plan: string }[];
  installations: { id: string; name: string; email: string }[];
};
export default function IssueLicense({
  onClose,
  initialRequestId,
}: {
  onClose: () => void;
  initialRequestId?: string;
}) {
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const recipients = useQuery({
    queryKey: ["license-recipients"],
    queryFn: () => request<Recipients>(productPath("/license-recipients")),
  });
  if (!config.data || !recipients.data)
    return (
      <Modal title="Issue a license" onClose={onClose}>
        {config.error || recipients.error ? (
          <ErrorNote message={(config.error || recipients.error)!.message} />
        ) : (
          <Spinner label="Loading plans and customers…" />
        )}
      </Modal>
    );
  return (
    <IssueForm
      config={config.data}
      recipients={recipients.data}
      initialRequestId={initialRequestId}
      onClose={onClose}
    />
  );
}
function IssueForm({
  config,
  recipients,
  initialRequestId,
  onClose,
}: {
  config: AdminConfig;
  recipients: Recipients;
  initialRequestId?: string;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const [recipient, setRecipient] = useState(initialRequestId ? "request:" + initialRequestId : "");
  const [customer, setCustomer] = useState("");
  const [subjectKind, setSubjectKind] = useState<"installation" | "service">("installation");
  const [plan, setPlan] = useState(
    recipients.requests.find((v) => v.id === initialRequestId)?.plan || config.licenses.defaultPlan,
  );
  const [paid, setPaid] = useState(false),
    [method, setMethod] = useState("Bank transfer"),
    [reference, setReference] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const [paymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [issued, setIssued] = useState<IssuedLicense | null>(null);
  const selected = config.licenses.planPresets[plan];
  const mutation = useMutation({
    mutationFn: issueLicense,
    onSuccess: (result) => {
      setIssued(result);
      for (const key of [
        "licenses",
        "finance",
        "financial-report",
        "license-requests",
        "license-recipients",
        "reports",
      ])
        void cache.invalidateQueries({ queryKey: [key] });
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.isPending || !selected || selected.price == null) return;
    mutation.mutate({
      requestId,
      plan,
      subjectKind,
      expectedPrice: selected.price,
      planRevision: selected.revision,
      issuedTo: customer.trim(),
      ...(recipient.startsWith("request:")
        ? { licenseRequestId: recipient.slice(8) }
        : recipient.startsWith("installation:")
          ? { installationId: recipient.slice(13) }
          : {}),
      ...(paid ? { payment: { date: paymentDate, method, reference } } : {}),
    });
  }
  if (issued) return <KeyReveal result={issued} onClose={onClose} />;
  return (
    <Modal title="Issue a license" onClose={() => !mutation.isPending && onClose()}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Choice
          label="Customer / delivery"
          value={recipient}
          onChange={(value) => {
            setRecipient(value);
            const r = recipients.requests.find((v) => "request:" + v.id === value);
            if (r && config.licenses.planPresets[r.plan]) setPlan(r.plan);
          }}
          required
          options={[
            ...recipients.requests.map((v) => ({
              value: "request:" + v.id,
              label: v.name + " · " + v.email + " · License request",
            })),
            ...recipients.installations.map((v) => ({
              value: "installation:" + v.id,
              label: (v.name || v.email || v.id) + " · " + v.id,
            })),
            { value: "manual", label: "Manual delivery / service customer" },
          ]}
        />
        {recipient === "manual" && (
          <>
            <TextField label="Customer name" value={customer} onChange={setCustomer} required />
            <p className="text-sm text-muted-foreground">
              Copy and share the key yourself, or ask the customer to use the public license request
              page.
            </p>
          </>
        )}
        <Choice
          label="License subject"
          value={subjectKind}
          onChange={(v) => setSubjectKind(v as typeof subjectKind)}
          options={[
            { value: "installation", label: "Application installation" },
            { value: "service", label: "Service deployment" },
          ]}
        />
        <Choice
          label="Plan"
          value={plan}
          onChange={(value) => {
            setPlan(value);
            setPaid(false);
          }}
          required
          options={Object.keys(config.licenses.planPresets).map((value) => ({
            value,
            label: value,
          }))}
        />
        {selected ? (
          <section aria-label="Selected plan terms" className="rounded-md bg-muted p-4">
            <p className="font-medium break-words">
              {plan} · {selected.price == null ? "Price not configured" : birr(selected.price)}
            </p>
            {selected.description && (
              <p className="mt-1 text-sm text-muted-foreground">{selected.description}</p>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Activation seats</dt>
                <dd>{selected.activationLimit}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Duration</dt>
                <dd>{selected.durationDays ? selected.durationDays + " days" : "Perpetual"}</dd>
              </div>
            </dl>
            <h3 className="mt-3 text-sm font-medium">Entitlements</h3>
            {!Object.keys(selected.entitlements).length && (
              <p className="mt-1 text-sm text-muted-foreground">No additional entitlements.</p>
            )}
            <ul className="mt-1 flex flex-col gap-1 text-sm break-words">
              {Object.entries(selected.entitlements).map(([key, value]) => (
                <li key={key}>
                  {key}: {String(value)}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted-foreground">
              Terms and price are copied from this plan. Payment does not control license
              validation.
            </p>
          </section>
        ) : (
          <p>
            No active plans.{" "}
            <Link className="text-primary underline" to="/entitlements" onClick={onClose}>
              Create a plan
            </Link>{" "}
            first.
          </p>
        )}
        {selected?.price == null && (
          <ErrorNote message="Configure a price in Plans before issuing. Use 0 for a complimentary license." />
        )}
        <div className="arc-theme">
          <Checkbox
            label="Already paid"
            checked={paid}
            disabled={!selected?.price}
            onCheckedChange={(v) => setPaid(v === true)}
            description={
              selected?.price === 0
                ? "Complimentary license; no payment required."
                : paid
                  ? "A receipt for the full plan price will be recorded."
                  : "Leave unchecked to record an unpaid sale."
            }
          />
        </div>
        {paid && (
          <PaymentFields
            method={method}
            reference={reference}
            date={paymentDate}
            onMethod={setMethod}
            onReference={setReference}
          />
        )}
        {mutation.error && <ErrorNote message={mutation.error.message} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={mutation.isPending || !recipient || selected?.price == null}
          >
            {mutation.isPending ? "Issuing…" : "Issue license"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function KeyReveal({ result, onClose }: { result: IssuedLicense; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="License issued" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p>
          License created for <strong>{result.license.issuedTo}</strong>.
        </p>
        <p>
          {birr(result.sale.amount)} ·{" "}
          {result.sale.status === "complimentary"
            ? "Complimentary"
            : result.sale.status === "paid"
              ? "Paid"
              : "Unpaid"}{" "}
          ·{" "}
          <Link className="text-primary underline" to="/sales" onClick={onClose}>
            View sale
          </Link>
        </p>
        <output className="block text-sm text-muted-foreground">
          {result.delivery.status === "manual"
            ? "Manual delivery: copy and share this key with the customer."
            : "Delivery: key available to the selected customer. Awaiting retrieval through their private request link or dependent app."}
        </output>
        {result.delivery.error && <ErrorNote message={result.delivery.error} />}
        <div className="flex flex-wrap gap-2">
          <code className="min-w-0 flex-1 select-all break-all rounded-md bg-muted p-3">
            {result.key}
          </code>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(result.key)
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy key"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          The key is stored encrypted. Customers must activate it normally; delivery does not
          consume an activation seat.
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
