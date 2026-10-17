import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, SlidersHorizontal, KeyRound } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

import { fetchAdminConfig, request } from "../api";
import { Button, Card, Modal, TextField, Spinner, ErrorNote } from "../components";
import { ActionButton } from "../components/ActionButton";
import { Choice } from "../components/Choice";
import { SortableDataTable, type DataColumn } from "../components/data-table12";
import { useProduct, useAction, Feedback, type Product } from "../platform-ui";
export default function Products() {
  const { id, products, select, isPending, error } = useProduct(),
    cache = useQueryClient();
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const [adding, setAdding] = useState(false);
  const [panel, setPanel] = useState<{ id: string; mode: "policy" | "keys" } | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [name, setName] = useState(""),
    [slug, setSlug] = useState("");
  const action = useAction(() => void cache.invalidateQueries({ queryKey: ["products"] }));
  const admin = config.data?.viewer.role === "admin";
  const product = products.find((p) => p.id === panel?.id);
  const rows = products
    .filter(
      (p) =>
        (status === "all" || (status === "archived") === p.archived) &&
        (p.name + " " + p.id).toLowerCase().includes(search.toLowerCase()),
    )
    .map((p) => ({
      ...p,
      status: p.archived ? "Archived" : "Active",
      trials: p.trial.enabled ? "Enabled" : "Off",
    }));
  type ProductRow = (typeof rows)[number];
  const columns: DataColumn<ProductRow>[] = [
    {
      key: "name",
      label: "Product",
      render: (_, p) => (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{p.name}</span>
          <span className="text-xs text-muted-foreground">{p.id}</span>
          {p.id === id && <span className="text-xs text-primary">Current product</span>}
        </div>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (_, p) => <Badge variant="outline">{p.status}</Badge>,
    },
    { key: "graceDays", label: "Offline grace", render: (_, p) => <span>{p.graceDays} days</span> },
    {
      key: "trials",
      label: "Machine trials",
      render: (_, product) => <span>Trials {product.trial.enabled ? "enabled" : "off"}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      sortable: false,
      width: "28%",
      align: "right",
      render: (_, p) => (
        <div className="flex flex-wrap justify-end gap-2">
          <ActionButton
            compact
            label="Use product"
            icon={ArrowRightLeft}
            disabled={p.id === id}
            onClick={() => select(p.id)}
          />
          <ActionButton
            compact
            label={admin ? "Edit policy" : "View policy"}
            icon={SlidersHorizontal}
            onClick={() => setPanel({ id: p.id, mode: "policy" })}
          />
          <ActionButton
            compact
            label="Signing keys"
            icon={KeyRound}
            onClick={() => setPanel({ id: p.id, mode: "keys" })}
          />
        </div>
      ),
    },
  ];
  if (isPending) return <Spinner label="Loading products…" />;
  if (error) return <ErrorNote message={error.message} />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Products</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Separate policy, keys, licenses and usage for each product or service.
          </p>
        </div>
        {admin && <Button onClick={() => setAdding(true)}>Add product</Button>}
      </div>
      {config.error && <ErrorNote message={(config.error as Error).message} />}
      <Card className="p-5">
        <div className="mb-4">
          <div>
            <h2 className="font-medium">Product directory</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose a product to work with its licenses, or manage its policy and keys.
            </p>
          </div>
        </div>
        <div className="arc-theme console-product-table">
          <SortableDataTable
            toolbar={
              <>
                <label htmlFor="product-filter" className="grid gap-2 text-sm font-medium">
                  Filter products
                  <Input
                    id="product-filter"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Name or product ID"
                  />
                </label>
                <Choice
                  label="Product status"
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: "all", label: "All products" },
                    { value: "active", label: "Active" },
                    { value: "archived", label: "Archived" },
                  ]}
                />
              </>
            }
            rows={rows}
            columns={columns}
            rowKey="id"
            caption="Products"
            defaultSort={{ key: "name", direction: "asc" }}
            emptyMessage="No products match your filters."
            itemName={{ one: "product", other: "products" }}
          />
        </div>
      </Card>
      {product && panel && (
        <ProductEditor
          key={product.id + ":" + product.revision + ":" + panel.mode}
          product={product}
          admin={admin}
          mode={panel.mode}
          close={() => setPanel(null)}
        />
      )}
      {admin && adding && (
        <Modal title="Add a product" onClose={() => setAdding(false)}>
          <form
            className="mt-4 max-w-xl space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void action
                .run(
                  () => request("/admin/products", { method: "POST", body: { id: slug, name } }),
                  "Product created. Select it to configure licensing.",
                )
                .then((saved) => {
                  if (saved) {
                    setAdding(false);
                    setName("");
                    setSlug("");
                  }
                });
            }}
          >
            <TextField label="Name" value={name} onChange={setName} required />
            <TextField
              label="Permanent product ID"
              value={slug}
              onChange={setSlug}
              placeholder="photo-editor"
              required
            />
            <p className="text-sm text-muted-foreground">
              Use lowercase letters, digits and hyphens. Private signing material is encrypted using
              the external data key.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={action.busy}>
                {action.busy ? "Creating…" : "Create product"}
              </Button>
            </div>
            <Feedback action={action} />
          </form>
        </Modal>
      )}
    </div>
  );
}
function ProductEditor({
  product,
  admin,
  mode,
  close,
}: {
  product: Product;
  admin: boolean;
  mode: "policy" | "keys";
  close: () => void;
}) {
  const productPath = (suffix: string) =>
    "/admin/products/" + encodeURIComponent(product.id) + suffix;
  const cache = useQueryClient();
  const action = useAction(() => {
    void cache.invalidateQueries({ queryKey: ["products"] });
    void cache.invalidateQueries({ queryKey: ["admin-config"] });
  });
  const [name, setName] = useState(product.name),
    [grace, setGrace] = useState(String(product.graceDays)),
    [archived, setArchived] = useState(product.archived);
  const [trial, setTrial] = useState(product.trial.enabled),
    [allowance, setAllowance] = useState(
      product.trial.allowance === null ? "" : String(product.trial.allowance),
    ),
    [duration, setDuration] = useState(
      product.trial.durationDays === null ? "" : String(product.trial.durationDays),
    );
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Modal title={product.name + (mode === "policy" ? " policy" : " signing keys")} onClose={close}>
      {mode === "policy" ? (
        <>
          <form
            className="mt-4 max-w-xl space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void action
                .run(() =>
                  request(productPath(""), {
                    method: "PATCH",
                    body: {
                      name,
                      graceDays: Number(grace),
                      archived,
                      trial: {
                        enabled: trial,
                        allowance: allowance === "" ? null : Number(allowance),
                        durationDays: duration === "" ? null : Number(duration),
                      },
                      revision: product.revision,
                    },
                  }),
                )
                .then((ok) => {
                  if (ok) close();
                });
            }}
          >
            <fieldset disabled={!admin || action.busy} className="flex flex-col gap-4">
              <TextField label="Product name" value={name} onChange={setName} required />
              <TextField
                label="Offline grace days"
                type="number"
                value={grace}
                onChange={setGrace}
              />
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={trial}
                  onChange={(e) => setTrial(e.target.checked)}
                  disabled={!admin}
                />
                Enable machine trials
              </label>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  label="Trial allowance (empty for time-only)"
                  type="number"
                  value={allowance}
                  onChange={setAllowance}
                />
                <TextField
                  label="Trial days (empty for allowance-only)"
                  type="number"
                  value={duration}
                  onChange={setDuration}
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                  disabled={!admin}
                />
                Archive product and refuse device calls
              </label>
              {admin && (
                <Button type="submit" disabled={action.busy}>
                  Save policy
                </Button>
              )}
            </fieldset>
            <Feedback action={action} />
          </form>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Distribute a staged public key to dependent apps before activating it. Retain old
            trusted keys while grants remain in use.
          </p>
          {product.keys.map((k) => (
            <div key={k.kid} className="mt-5 border-t border-slate-200 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-mono text-xs">
                  {k.kid} · {k.pending ? "Staged" : k.retiredAt ? "Retired" : "Active"}
                </span>
                <Button
                  variant="secondary"
                  onClick={() =>
                    void action.run(
                      () => navigator.clipboard.writeText(k.publicKeyPem),
                      "Public key copied.",
                    )
                  }
                >
                  Copy public key
                </Button>
              </div>
              <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-50 p-3 text-xs">
                {k.publicKeyPem}
              </pre>
              {admin && k.pending && (
                <div className="mt-4 space-y-3">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    Dependent apps now trust this public key
                  </label>
                  <Button
                    disabled={!confirmed || action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          request(productPath("/keys/" + encodeURIComponent(k.kid) + "/activate"), {
                            method: "POST",
                            body: { confirm: true, revision: product.revision },
                          }),
                        "Signing key activated.",
                      )
                    }
                  >
                    Activate staged key
                  </Button>
                </div>
              )}
            </div>
          ))}
          {admin && !product.keys.some((k) => k.pending) && (
            <Button
              variant="secondary"
              className="mt-5"
              disabled={action.busy}
              onClick={() =>
                void action.run(
                  () =>
                    request(productPath("/keys/stage"), {
                      method: "POST",
                      body: { revision: product.revision },
                    }),
                  "Key staged. Distribute its public half before activation.",
                )
              }
            >
              Stage new signing key
            </Button>
          )}
          <Feedback action={action} />
        </>
      )}
    </Modal>
  );
}
