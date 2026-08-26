import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { fetchAdminConfig } from "../api";
import { changePassword, useSession } from "../auth-client";
import { Button, Card, ErrorNote, TextField } from "../components";

export default function Settings() {
  const { data: config } = useQuery({
    queryKey: ["admin-config"],
    queryFn: fetchAdminConfig,
    staleTime: Infinity,
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-slate-500">Your operator account and service backups.</p>
      </div>
      <ChangePassword />
      {/* The public key is what vendors embed in their app; both roles may read
          it, and it is the only place to recover it after keygen scrolls away. */}
      {config?.signingKey && <SigningKey signingKey={config.signingKey} />}
      {/* Downloading the ledger is an admin action; support never sees it. */}
      {config?.viewer.role === "admin" && (config?.features.backups ?? true) && (
        <Backups ledgerBackup={config?.features.ledgerBackup ?? true} />
      )}
    </div>
  );
}

function ChangePassword() {
  const { data: session } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    setSubmitting(true);
    // Other sessions are revoked on success — a password change usually means
    // the old one should stop working everywhere, this browser excepted.
    const { error: apiError } = await changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setSubmitting(false);
    if (apiError) {
      setError(apiError.message ?? "Password change failed.");
      return;
    }
    setDone(true);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Change password</h2>
      <p className="mt-1 text-sm text-slate-500">
        Signed in as <span className="font-medium">{session?.user.email}</span>. Changing your
        password signs out every other session.
      </p>
      <form onSubmit={onSubmit} className="mt-4 max-w-sm space-y-4">
        <TextField
          label="Current password"
          type="password"
          required
          value={currentPassword}
          onChange={setCurrentPassword}
        />
        <div className="grid grid-cols-2 gap-4">
          <TextField
            label="New password"
            type="password"
            required
            value={newPassword}
            onChange={setNewPassword}
          />
          <TextField
            label="Confirm"
            type="password"
            required
            value={confirmPassword}
            onChange={setConfirmPassword}
          />
        </div>
        {error && <ErrorNote message={error} />}
        {done && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            Password changed. If this operator is seeded at boot (LICENSE_SEED_ADMIN_PASSWORD), the
            stored password stays as you set it here — seeding never overwrites an existing user.
          </div>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Changing…" : "Change password"}
        </Button>
      </form>
    </Card>
  );
}

/**
 * The service's public signing key.
 *
 * This exists because `npm run license keygen` prints the public key once and
 * nothing else ever did. A vendor who lost that output had no way to check that
 * the key their server signs with is the one their shipped app verifies
 * against — and that mismatch is silent from both ends: the server reports
 * success, every token fails in the field.
 *
 * The fingerprint is the part worth comparing; the PEM is here to paste.
 */
function SigningKey(props: {
  signingKey: { keyType: string; fingerprint: string; publicKeyPem: string };
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.signingKey.publicKeyPem);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure origin, permissions policy).
      // The PEM is on screen and selectable, so this is not worth an error.
      setCopied(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Signing key</h2>
      <p className="mt-1 text-sm text-slate-500">
        The public half of the key this service signs licenses with. It must match the key embedded
        in your application — if they differ, every token this server issues will fail verification
        even though issuing appears to succeed. The private key never leaves the server.
      </p>
      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Algorithm</dt>
          <dd className="mt-0.5 text-sm">{props.signingKey.keyType}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-400">Fingerprint</dt>
          <dd className="mt-0.5 font-mono text-sm">{props.signingKey.fingerprint}</dd>
        </div>
      </dl>
      <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
        {props.signingKey.publicKeyPem.trim()}
      </pre>
      <div className="mt-3 flex items-center gap-3">
        <Button type="button" onClick={copy}>
          {copied ? "Copied" : "Copy public key"}
        </Button>
        <span className="text-xs text-slate-500">
          Compare with <code className="font-mono">npm run license keycheck</code>
        </span>
      </div>
    </Card>
  );
}

function Backups(props: { ledgerBackup: boolean }) {
  // On Postgres the ledger is dumped with pg_dump, not downloaded from here,
  // so the button is replaced by a pointer to the docs rather than a 501.
  const targets = [
    ...(props.ledgerBackup
      ? [
          {
            key: "licenses",
            title: "License database",
            description: "Licenses, activations, installations, and the audit log.",
          },
          {
            key: "auth",
            title: "Auth database",
            description: "Console operators and their sessions.",
          },
        ]
      : []),
  ];
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Backups</h2>
      {props.ledgerBackup ? (
        <p className="mt-1 text-sm text-slate-500">
          Download a consistent SQLite snapshot (taken via SQLite's online backup API, safe while
          the service is running). Downloads are recorded in the audit log.
        </p>
      ) : (
        <p className="mt-1 text-sm text-slate-500">
          This deployment runs on Postgres, so backups are taken with Postgres' own tooling rather
          than downloaded from here — <code className="font-mono text-xs">pg_dump</code> against
          your <code className="font-mono text-xs">DATABASE_URL</code>. See{" "}
          <code className="font-mono text-xs">docs/backups.md</code>. Operator accounts live in the
          same database, so one dump covers both.
        </p>
      )}
      <div className="mt-4 divide-y divide-slate-100">
        {targets.map((target) => (
          <div key={target.key} className="flex items-center justify-between gap-4 py-3">
            <div>
              <div className="text-sm font-medium">{target.title}</div>
              <div className="text-xs text-slate-500">{target.description}</div>
            </div>
            <a
              href={`/admin/backup/${target.key}`}
              download
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Download
            </a>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Store backups as carefully as the live databases — the license ledger and operator
        credentials live in them.
      </p>
    </Card>
  );
}
