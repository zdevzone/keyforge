import type { ReactNode } from "react";

import type { Entitlements, EntitlementValue, LiveStatus } from "./api";

export function Card(props: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white shadow-sm ${props.className ?? ""}`}
    >
      {props.children}
    </div>
  );
}

const statusStyles: Record<LiveStatus, string> = {
  active: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  expired: "bg-amber-50 text-amber-700 ring-amber-600/20",
  revoked: "bg-red-50 text-red-700 ring-red-600/20",
};

export function StatusBadge(props: { status: LiveStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyles[props.status]}`}
    >
      {props.status}
    </span>
  );
}

export function Spinner(props: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
      <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
      {props.label ?? "Loading…"}
    </div>
  );
}

export function Modal(props: { title: string; onClose?: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <h2 className="text-base font-semibold">{props.title}</h2>
          {props.onClose && (
            <button
              onClick={props.onClose}
              aria-label="Close"
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              ✕
            </button>
          )}
        </div>
        <div className="mt-4">{props.children}</div>
      </div>
    </div>
  );
}

const buttonStyles = {
  primary: "bg-slate-900 text-white hover:bg-slate-700",
  secondary: "border border-slate-300 text-slate-700 hover:bg-slate-100",
  danger: "bg-red-600 text-white hover:bg-red-500",
} as const;

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: keyof typeof buttonStyles;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type={props.type ?? "button"}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${buttonStyles[props.variant ?? "primary"]} ${props.className ?? ""}`}
    >
      {props.children}
    </button>
  );
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{props.label}</span>
      <input
        type={props.type ?? "text"}
        required={props.required}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none"
      />
    </label>
  );
}

/** "allowance=200,000 · pro=true" — compact display of a license's entitlements. */
export function entitlementsSummary(entitlements: Entitlements): string {
  const parts = Object.entries(entitlements).map(([name, value]) => {
    const rendered = typeof value === "number" ? value.toLocaleString() : String(value);
    return `${name}=${rendered}`;
  });
  return parts.join(" · ");
}

/** "true"/"false" become booleans, numerics become numbers, the rest stays text. */
export function parseEntitlementValue(raw: string): EntitlementValue {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) return Number(trimmed);
  return trimmed;
}

export interface EntitlementRow {
  name: string;
  value: string;
}

export function entitlementsToRows(entitlements: Entitlements): EntitlementRow[] {
  return Object.entries(entitlements).map(([name, value]) => ({ name, value: String(value) }));
}

export function rowsToEntitlements(rows: EntitlementRow[]): Entitlements {
  const result: Entitlements = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) result[name] = parseEntitlementValue(row.value);
  }
  return result;
}

/** Key/value rows for a license's entitlements, with add and remove. */
export function EntitlementsEditor(props: {
  rows: EntitlementRow[];
  onChange: (rows: EntitlementRow[]) => void;
}) {
  const { rows, onChange } = props;
  const update = (index: number, patch: Partial<EntitlementRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <div className="space-y-2">
      <span className="text-sm font-medium text-slate-700">Entitlements</span>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            placeholder="name (e.g. allowance)"
            value={row.name}
            onChange={(event) => update(index, { name: event.target.value })}
            className="w-2/5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          <input
            placeholder="value (number, true/false, or text)"
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          <button
            type="button"
            aria-label="Remove entitlement"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { name: "", value: "" }])}
        className="text-sm text-slate-500 hover:text-slate-900"
      >
        + Add entitlement
      </button>
    </div>
  );
}

export function ErrorNote(props: { message: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {props.message}
    </div>
  );
}

export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
