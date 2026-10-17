import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";

import { Input } from "@/components/ui/input";

import { request } from "../api";
import { Button, Card, ErrorNote, Spinner, TextField } from "../components";
import { Choice } from "../components/Choice";

type Product = { id: string; name: string; plans: { id: string; description: string }[] };
export default function RequestLicense() {
  const query = useQuery({
    queryKey: ["public-license-catalog"],
    queryFn: () => request<{ products: Product[] }>("/v1/license-request-catalog"),
  });
  const [product, setProduct] = useState(""),
    [plan, setPlan] = useState(""),
    [name, setName] = useState(""),
    [email, setEmail] = useState("");
  const [identity] = useState(() => ({
    id: crypto.randomUUID(),
    secret: Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join(""),
  }));
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: () =>
      request("/v1/license-requests", {
        method: "POST",
        headers: { authorization: "Bearer " + identity.secret },
        body: { id: identity.id, productId: product, plan, name: name.trim(), email: email.trim() },
      }),
    onSuccess: () => navigate("/license-request/" + identity.id + "#" + identity.secret),
  });
  const selected = query.data?.products.find((v) => v.id === product);
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-start px-4 py-10 sm:py-16">
      <Card className="w-full p-6 sm:p-8">
        <h1 className="text-xl font-semibold">Request a license</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          No installation needed. Submit your details and save the private status link to retrieve
          your key after an operator approves it.
        </p>
        {query.isPending ? (
          <Spinner />
        ) : query.error ? (
          <ErrorNote message={query.error.message} />
        ) : (
          <form
            className="mt-6 flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            <TextField label="Your name" value={name} onChange={setName} required />
            <TextField label="Email" type="email" value={email} onChange={setEmail} required />
            <Choice
              label="Product"
              value={product}
              required
              onChange={(value) => {
                setProduct(value);
                setPlan("");
              }}
              options={(query.data?.products ?? []).map((v) => ({ value: v.id, label: v.name }))}
            />
            <Choice
              label="Requested plan"
              value={plan}
              required
              onChange={setPlan}
              disabled={!selected}
              options={(selected?.plans ?? []).map((v) => ({
                value: v.id,
                label: v.id + (v.description ? " · " + v.description : ""),
              }))}
            />
            <p className="text-sm text-muted-foreground">
              This is a request, not a payment or purchase confirmation. No email is sent; keep your
              private status link.
            </p>
            {mutation.error && <ErrorNote message={mutation.error.message} />}
            <Button type="submit" disabled={mutation.isPending || !product || !plan}>
              {mutation.isPending ? "Submitting…" : "Request license"}
            </Button>
          </form>
        )}
        <Link className="mt-5 inline-block text-sm text-primary underline" to="/login">
          Operator sign in
        </Link>
      </Card>
    </main>
  );
}
export function RequestStatus() {
  const { id } = useParams(),
    location = useLocation();
  const secret = location.hash.slice(1);
  const headers = { authorization: "Bearer " + secret };
  const query = useQuery({
    queryKey: ["private-license-request", id, secret],
    queryFn: () => request<any>("/v1/license-requests/" + id, { headers }),
    refetchInterval: 15000,
    retry: false,
  });
  const [key, setKey] = useState(""),
    [copied, setCopied] = useState(false);
  const collect = useMutation({
    mutationFn: () =>
      request<{ key: string }>("/v1/license-requests/" + id + "/collect", {
        method: "POST",
        headers,
      }),
    onSuccess: (result) => {
      setKey(result.key);
      void query.refetch();
    },
  });
  const link = window.location.href;
  return (
    <main className="mx-auto min-h-screen w-full max-w-xl px-4 py-10 sm:py-16">
      <Card className="flex flex-col gap-5 p-6 sm:p-8">
        <h1 className="text-xl font-semibold">Your license request</h1>
        <p className="text-sm text-muted-foreground">
          Keep this private link. Anyone with it can retrieve your license; it is not emailed to
          you.
        </p>
        <label className="grid gap-2 text-sm font-medium">
          Private status link
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
        </label>
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard
              .writeText(link)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          {copied ? "Link copied" : "Copy private link"}
        </Button>
        {query.isPending ? (
          <Spinner />
        ) : query.error ? (
          <ErrorNote message={query.error.message} />
        ) : (
          <>
            <p>
              {query.data.request.name} · {query.data.request.plan}
            </p>
            <output className="block">
              {query.data.request.status === "requested"
                ? "Awaiting operator approval. You can return to this link later."
                : "Your license is ready."}
            </output>
            {query.data.request.status === "issued" && (
              <Button onClick={() => collect.mutate()} disabled={collect.isPending}>
                {collect.isPending ? "Retrieving…" : "Retrieve license key"}
              </Button>
            )}
            {query.data.delivery?.error && <ErrorNote message={query.data.delivery.error} />}
          </>
        )}
        {collect.error && <ErrorNote message={collect.error.message} />}
        {key && (
          <>
            <code className="select-all break-all rounded-md bg-muted p-4">{key}</code>
            <p className="text-sm text-muted-foreground">
              Copy this key into the application after installing. Activation and license validation
              still apply.
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
