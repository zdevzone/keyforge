import { useState } from "react";
import { Link } from "react-router-dom";

import { request, productPath } from "../api";
import { Textarea } from "../components";
import { Button, Card } from "../components";
import { Feedback, useAction } from "../platform-ui";
export default function Inspect() {
  const [token, setToken] = useState(""),
    [result, setResult] = useState<any>(null);
  const action = useAction();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Token diagnostics</h1>
        <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">
          The dependent app receives a token when it activates or refreshes a license. Copy that
          stored token from the app's support diagnostics to check its signature, product and
          current binding here. A product key is not a token.
        </p>
      </div>
      <Card className="p-6">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setResult(null);
            void action.run(
              async () =>
                setResult(
                  await request(productPath("/diagnostics"), {
                    method: "POST",
                    body: { token: token.trim() },
                  }),
                ),
              "Diagnostics complete.",
            );
          }}
        >
          <label htmlFor="diagnostic-token" className="text-sm font-medium">
            Signed license or trial token
          </label>
          <Textarea
            id="diagnostic-token"
            required
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setResult(null);
            }}
            rows={5}
            className="block w-full rounded-lg border border-slate-300 p-3 font-mono text-xs"
            placeholder="Two base64url segments separated by a dot"
          />
          <Button type="submit" disabled={action.busy}>
            Verify and inspect
          </Button>
          <Feedback action={action} />
        </form>
      </Card>
      {result && (
        <Card className="p-6">
          <h2 className="font-semibold">Verification results</h2>
          <dl className="mt-4 grid gap-5 sm:grid-cols-3">
            {Object.entries({
              Signature: result.signatureValid ? "Verified" : "Invalid or unknown key",
              "Payload schema": result.schemaValid ? "Supported" : "Unsupported or wrong product",
              "Current ledger authorization": result.currentAuthorization,
            }).map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-muted-foreground">{label}</dt>
                <dd
                  className={
                    "mt-1 font-medium " + (!result.signatureValid ? "text-destructive" : "")
                  }
                >
                  {String(value)}
                </dd>
              </div>
            ))}
          </dl>
          {result.signatureValid && result.schemaValid && result.payload.licenseId && (
            <Link
              to={"/licenses/" + result.payload.licenseId}
              className="mt-5 inline-block text-sm underline"
            >
              Open license record
            </Link>
          )}
          <details className="mt-5">
            <summary className="cursor-pointer text-sm font-medium">
              Decoded claims {result.signatureValid ? "" : "(untrusted)"}
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-50 p-3 text-xs">
              {JSON.stringify(result.payload, null, 2)}
            </pre>
          </details>
          <p className="mt-4 text-sm text-muted-foreground">
            A verified signature proves origin and integrity. The dependent app must still enforce
            its identity, product, expiry, offline deadline and remaining local quota.
          </p>
        </Card>
      )}
    </div>
  );
}
