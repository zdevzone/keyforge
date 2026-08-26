import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { fetchAdminConfig, issueLicense, type License } from "./api";
import {
  Button,
  EntitlementsEditor,
  ErrorNote,
  Modal,
  TextField,
  entitlementsToRows,
  rowsToEntitlements,
  type EntitlementRow,
} from "./components";

/**
 * Issue flow in two modals: the form, then the one-time key reveal. The key is
 * in this response and nowhere else, ever — the server keeps only its hash —
 * so the reveal step is deliberately loud and requires an explicit dismissal.
 *
 * Plan presets come from the deployment config; picking one fills the
 * entitlements, seat count and expiry, all still editable per license.
 */
export default function IssueLicense(props: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data: config } = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const [issuedTo, setIssuedTo] = useState("");
  const [plan, setPlan] = useState<string | null>(null);
  const [rows, setRows] = useState<EntitlementRow[] | null>(null);
  const [activationLimit, setActivationLimit] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState("");
  const [issued, setIssued] = useState<{ license: License; key: string } | null>(null);

  const defaultPlan = config?.licenses.defaultPlan ?? "standard";
  const effectivePlan = plan ?? defaultPlan;
  const presets = config?.licenses.planPresets ?? {};
  const preset = presets[effectivePlan];
  const effectiveRows = rows ?? entitlementsToRows(preset?.entitlements ?? {});
  const effectiveLimit =
    activationLimit ??
    String(preset?.activationLimit ?? config?.licenses.defaultActivationLimit ?? 1);

  function applyPlan(name: string) {
    setPlan(name);
    const next = presets[name];
    // Switching plans re-seeds the editable fields from the preset.
    setRows(entitlementsToRows(next?.entitlements ?? {}));
    setActivationLimit(
      String(next?.activationLimit ?? config?.licenses.defaultActivationLimit ?? 1),
    );
    if (next?.durationDays) {
      // applyPlan runs from the plan button's onClick, never during render.
      // The purity rule cannot see that: it flags any impure call inside a
      // function declared in the component body. Restructuring correct code
      // to satisfy it would be worse than saying so here.
      // oxlint-disable-next-line react/purity
      const expires = new Date(Date.now() + next.durationDays * 24 * 60 * 60 * 1000);
      setExpiresAt(expires.toISOString().slice(0, 10));
    }
  }

  const mutation = useMutation({
    mutationFn: issueLicense,
    onSuccess: (result) => {
      setIssued(result);
      void queryClient.invalidateQueries({ queryKey: ["licenses"] });
    },
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({
      issuedTo: issuedTo.trim(),
      plan: effectivePlan.trim() || defaultPlan,
      entitlements: rowsToEntitlements(effectiveRows),
      activationLimit: Number(effectiveLimit),
      expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59Z`).toISOString() : null,
    });
  }

  if (issued) {
    return <KeyReveal license={issued.license} licenseKey={issued.key} onClose={props.onClose} />;
  }

  const planNames = Object.keys(presets);

  return (
    <Modal title="Issue a license" onClose={props.onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <TextField
          label="Customer"
          value={issuedTo}
          onChange={setIssuedTo}
          placeholder="Customer name"
        />
        <label className="block text-sm">
          <span className="font-medium text-slate-700">Plan</span>
          {planNames.length > 0 ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {planNames.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => applyPlan(name)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    effectivePlan === name
                      ? "bg-slate-900 text-white"
                      : "border border-slate-300 text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {name}
                </button>
              ))}
              <input
                value={effectivePlan}
                onChange={(event) => setPlan(event.target.value)}
                className="w-28 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
              />
            </div>
          ) : (
            <input
              value={effectivePlan}
              onChange={(event) => setPlan(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none"
            />
          )}
        </label>
        <EntitlementsEditor rows={effectiveRows} onChange={setRows} />
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="Activation limit"
            type="number"
            required
            value={effectiveLimit}
            onChange={setActivationLimit}
          />
          <TextField
            label="Expires (optional)"
            type="date"
            value={expiresAt}
            onChange={setExpiresAt}
          />
        </div>
        {mutation.error && <ErrorNote message={(mutation.error as Error).message} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending ? "Issuing…" : "Issue license"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function KeyReveal(props: { license: License; licenseKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.licenseKey);
      setCopied(true);
    } catch {
      // Clipboard can be unavailable (permissions, http) — the key stays
      // selectable below either way.
    }
  }

  return (
    <Modal title="Product key issued">
      <p className="text-sm text-slate-600">
        License for <span className="font-medium">{props.license.issuedTo || "(unnamed)"}</span>{" "}
        created.
      </p>
      <div className="mt-4 flex items-center gap-2">
        <code className="flex-1 select-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm">
          {props.licenseKey}
        </code>
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
        This key is shown <strong>only once</strong> — the server stores just a hash. Save it before
        closing.
      </p>
      <div className="mt-4 flex justify-end">
        <Button onClick={props.onClose}>I saved the key</Button>
      </div>
    </Modal>
  );
}
