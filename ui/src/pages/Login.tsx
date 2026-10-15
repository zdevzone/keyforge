import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";

import { Input } from "@/components/ui/input";

import { useBranding } from "../App";
import { signIn, useSession } from "../auth-client";
import { Button, Card, ErrorNote } from "../components";

export default function Login() {
  const name = useBranding();
  const { data: session, isPending, refetch } = useSession();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!isPending && session) return <Navigate to="/" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: signInError } = await signIn.email({ email, password });
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message ?? "Sign-in failed.");
      return;
    }
    // Navigate only from the observed authenticated session above. A root redirect
    // before the session hook settles would send a successful sign-in to /welcome.
    await refetch();
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm p-8">
        <div className="console-brand-mark mb-6">
          <KeyRound className="size-5" />
        </div>
        <h1 className="text-lg font-semibold">{name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to manage licenses.</p>
        {params.get("reset") === "complete" && (
          <output className="mt-4 block text-sm text-success">
            Application data was reset. Sign in with the preserved seeded administrator account.
          </output>
        )}
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label htmlFor="login-email" className="block text-sm">
            <span className="font-medium text-slate-700">Email</span>
            <Input
              id="login-email"
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none"
            />
          </label>
          <label htmlFor="login-password" className="block text-sm">
            <span className="font-medium text-slate-700">Password</span>
            <Input
              id="login-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none"
            />
          </label>
          {error && <ErrorNote message={error} />}
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-4 text-sm">
          <Link className="text-primary underline" to="/request-license">
            Request a license before installing
          </Link>
        </p>
        <p className="mt-4 text-xs text-muted-foreground">
          Ask your administrator for an operator account.
        </p>
        <p className="mt-4 text-sm">
          <Link className="text-primary underline" to="/welcome">
            About KeyForge
          </Link>
        </p>
      </Card>
    </div>
  );
}
