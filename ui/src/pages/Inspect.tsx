import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import type { Entitlements, LiveStatus } from "../api";
import { Card, StatusBadge, entitlementsSummary, formatDateTime } from "../components";

/**
 * The web twin of `npm run license inspect`: paste a token an installation is
 * holding, see what it claims. Decoding happens entirely in the browser — the
 * payload is the base64url half before the signature — and, like the CLI, this
 * does not verify the signature; only the app's embedded public key does that.
 */

interface DecodedToken {
  v?: number;
  licenseId?: string;
  plan?: string;
  /** v2 tokens carry entitlements; v1 tokens carried a bare allowance. */
  entitlements?: Entitlements;
  allowance?: number;
  issuedTo?: string;
  installationId?: string;
  issuedAt?: string;
  expiresAt?: string | null;
  offlineGraceUntil?: string;
  status?: string;
  [key: string]: unknown;
}

function decodeToken(input: string): { payload: DecodedToken } | { error: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const body = trimmed.split(".")[0];
  try {
    const base64 = body.replaceAll("-", "+").replaceAll("_", "/");
    const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
    const payload = JSON.parse(json) as DecodedToken;
    if (typeof payload !== "object" || payload === null) throw new Error("not an object");
    return { payload };
  } catch {
    return { error: "That does not decode as a license token." };
  }
}

function Field(props: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{props.label}</dt>
      <dd className="mt-1 text-sm">{props.value}</dd>
    </div>
  );
}

export default function Inspect() {
  const [input, setInput] = useState("");
  const decoded = useMemo(() => decodeToken(input), [input]);

  const payload = decoded && "payload" in decoded ? decoded.payload : null;
  const grace = payload?.offlineGraceUntil ? new Date(payload.offlineGraceUntil) : null;
  const graceExpired = grace !== null && !Number.isNaN(grace.getTime()) && grace < new Date();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Token inspector</h1>
        <p className="mt-1 text-sm text-slate-500">
          Paste a license token from an installation to read what it claims.
        </p>
      </div>

      <Card className="p-5">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Paste a token (or just its payload half)…"
          rows={4}
          className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-500 focus:outline-none"
        />
      </Card>

      {decoded && "error" in decoded && (
        <Card className="p-5 text-sm text-red-700">{decoded.error}</Card>
      )}

      {payload && (
        <Card className="p-5">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold">
              {payload.issuedTo || <span className="text-slate-400">(unnamed)</span>}
            </h2>
            {typeof payload.status === "string" &&
              ["active", "expired", "revoked"].includes(payload.status) && (
                <StatusBadge status={payload.status as LiveStatus} />
              )}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
            <Field
              label="License"
              value={
                payload.licenseId ? (
                  <Link
                    to={`/licenses/${payload.licenseId}`}
                    className="font-mono text-xs text-slate-900 underline"
                  >
                    {payload.licenseId}
                  </Link>
                ) : (
                  "—"
                )
              }
            />
            <Field label="Plan" value={payload.plan ?? "—"} />
            <Field
              label="Entitlements"
              value={
                payload.entitlements
                  ? entitlementsSummary(payload.entitlements) || "—"
                  : typeof payload.allowance === "number"
                    ? `allowance=${payload.allowance.toLocaleString()}`
                    : "—"
              }
            />
            <Field
              label="Installation"
              value={<span className="font-mono text-xs">{payload.installationId ?? "—"}</span>}
            />
            <Field label="Issued" value={formatDateTime(payload.issuedAt ?? null)} />
            <Field label="Expires" value={formatDateTime(payload.expiresAt ?? null)} />
            <Field
              label="Offline grace until"
              value={
                <span className={graceExpired ? "text-amber-700" : ""}>
                  {formatDateTime(payload.offlineGraceUntil ?? null)}
                  {graceExpired ? " (lapsed — the app must revalidate)" : ""}
                </span>
              }
            />
            <Field label="Format version" value={String(payload.v ?? "—")} />
          </dl>
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-slate-500">Raw payload</summary>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-100 p-3 font-mono text-xs">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </details>
          <p className="mt-4 text-xs text-slate-400">
            Decoded only — the app verifies the Ed25519 signature with its embedded public key; this
            page does not.
          </p>
        </Card>
      )}
    </div>
  );
}
