import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode, type ComponentProps } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button as UIButton } from "@/components/ui/button";
import { Card as UICard } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TableCell as UITableCell, TableHead as UITableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { productPath, request } from "./api";
import type { Entitlements, EntitlementValue, LiveStatus } from "./api";
import { Choice } from "./components/Choice";
import { DateField } from "./components/DateField";
export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableFooter,
  TableCaption,
} from "@/components/ui/table";
export { Textarea } from "@/components/ui/textarea";
export function TableCell(props: ComponentProps<typeof UITableCell>) {
  return <UITableCell {...props} className={cn("whitespace-normal", props.className)} />;
}
export function TableHead(props: ComponentProps<typeof UITableHead>) {
  return <UITableHead scope="col" {...props} />;
}
export function Card(props: { children: ReactNode; className?: string }) {
  return (
    <UICard className={cn("console-card block gap-0 py-0 shadow-none", props.className)}>
      {props.children}
    </UICard>
  );
}
const statusStyles: Record<LiveStatus, string> = {
  active: "bg-success/10 text-success",
  expired: "bg-warning/10 text-warning",
  revoked: "bg-destructive/10 text-destructive",
};
export function StatusBadge(props: { status: LiveStatus }) {
  return (
    <Badge variant="outline" className={cn("border-0 capitalize", statusStyles[props.status])}>
      {props.status}
    </Badge>
  );
}
export function Spinner(props: { label?: string }) {
  return (
    <output
      aria-live="polite"
      className="flex items-center justify-center gap-2 py-16 text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-input border-t-foreground"
      />
      {props.label ?? "Loading…"}
    </output>
  );
}
export function Modal(props: { title: string; onClose?: () => void; children: ReactNode }) {
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(
    () => () => {
      const target = returnFocus.current;
      requestAnimationFrame(() => {
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    },
    [],
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose?.();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={Boolean(props.onClose)}
        className="console-modal max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader className="text-left">
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <div>{props.children}</div>
      </DialogContent>
    </Dialog>
  );
}
const buttonVariants = { primary: "default", secondary: "outline", danger: "destructive" } as const;
export function Button(
  props: Omit<ComponentProps<typeof UIButton>, "variant"> & {
    variant?: keyof typeof buttonVariants;
  },
) {
  const { variant = "primary", ...native } = props;
  return (
    <UIButton
      {...native}
      className={cn("w-fit max-w-full", props.className)}
      type={props.type ?? "button"}
      variant={buttonVariants[variant]}
    />
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
  const id = useId();
  if (props.type === "date")
    return <DateField label={props.label} value={props.value} onChange={props.onChange} />;
  return (
    <Field className={cn("console-text-field", props.type === "number" && "console-number-field")}>
      <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
      <Input
        id={id}
        type={props.type ?? "text"}
        required={props.required}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Field>
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
  type?: "number" | "string" | "boolean";
}

export function entitlementsToRows(entitlements: Entitlements): EntitlementRow[] {
  return Object.entries(entitlements).map(([name, value]) => ({
    name,
    value: String(value),
    type: typeof value as EntitlementRow["type"],
  }));
}

export function rowsToEntitlements(rows: EntitlementRow[]): Entitlements {
  const result: Entitlements = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name)
      result[name] =
        row.type === "string"
          ? row.value
          : row.type === "boolean"
            ? row.value === "true"
            : row.type === "number"
              ? Number(row.value)
              : parseEntitlementValue(row.value);
  }
  return result;
}

/** Key/value rows for a license's entitlements, with add and remove. */
export function EntitlementsEditor(props: {
  rows: EntitlementRow[];
  onChange: (rows: EntitlementRow[]) => void;
}) {
  const { rows, onChange } = props;
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () =>
      request<{
        definitions: {
          id: string;
          type: string;
          archived: boolean;
          defaultValue?: EntitlementValue;
        }[];
      }>(productPath("/catalog")),
  });
  const definitions =
    catalog.data?.definitions.filter((d) => !d.archived && d.type !== "mixed") ?? [];
  const update = (index: number, patch: Partial<EntitlementRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-slate-700">Entitlements</span>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Choice
            hideLabel
            label="Entitlement value type"
            value={row.type ?? "string"}
            onChange={(value) => update(index, { type: value as EntitlementRow["type"] })}
            options={[
              { value: "string", label: "Text" },
              { value: "number", label: "Number" },
              { value: "boolean", label: "Boolean" },
            ]}
          />
          <Choice
            hideLabel
            label="Entitlement key"
            value={row.name}
            onChange={(value) => {
              const definition = definitions.find((d) => d.id === value);
              update(index, {
                name: value,
                type: definition?.type as EntitlementRow["type"],
                value:
                  definition?.defaultValue === undefined ? "" : String(definition.defaultValue),
              });
            }}
            options={[
              { value: "", label: "Choose entitlement" },
              ...(row.name && !definitions.some((d) => d.id === row.name)
                ? [{ value: row.name, label: row.name + " (unavailable)" }]
                : []),
              ...definitions.map((d) => ({ value: d.id, label: d.id })),
            ]}
          />
          <Input
            aria-label="Entitlement value"
            placeholder="value (number, true/false, or text)"
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
          />
          <button
            type="button"
            aria-label="Remove entitlement"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            className="rounded p-1 text-muted-foreground hover:bg-slate-100 hover:text-muted-foreground"
          >
            <X size={18} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { name: "", value: "" }])}
        className="self-start text-sm text-primary hover:underline"
      >
        Add entitlement
      </button>
      {!definitions.length && (
        <p className="text-sm text-muted-foreground">
          Create active entitlement definitions in Entitlements & plans before adding grants.
        </p>
      )}
    </div>
  );
}

export function ErrorNote(props: { message: string }) {
  return (
    <Alert variant="destructive" className="border-destructive/25 bg-destructive/5">
      <AlertDescription>{props.message}</AlertDescription>
    </Alert>
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
