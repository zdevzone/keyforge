import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useState } from "react";

import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

import { fetchAdminConfig, productPath, request } from "../api";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components";
import {
  Button,
  Modal,
  Card,
  TextField,
  FormFields,
  Spinner,
  ErrorNote,
  EntitlementsEditor,
  entitlementsToRows,
  rowsToEntitlements,
  type EntitlementRow,
} from "../components";
import { ActionButton } from "../components/ActionButton";
import { Choice } from "../components/Choice";
import { useListPage, ListPagination } from "../components/ListPagination";
import { useAction, Feedback, Select } from "../platform-ui";
import { birr, minor } from "./Finance";
export default function Entitlements() {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: ["catalog"],
    queryFn: () => request<any>(productPath("/catalog")),
  });
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const [tab, setTab] = useState("definitions"),
    [editing, setEditing] = useState<any>(null);
  const refresh = () => {
    void cache.invalidateQueries({ queryKey: ["catalog"] });
    void cache.invalidateQueries({ queryKey: ["admin-config"] });
  };
  const list = useListPage<any>(query.data?.[tab] ?? [], tab);
  if (query.isPending) return <Spinner label="Loading product catalog…" />;
  if (query.error) return <ErrorNote message={(query.error as Error).message} />;
  const c = query.data,
    admin = config.data?.viewer.role === "admin";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Entitlements & plans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Define what your product grants, build plans, and see where they are used.
        </p>
      </div>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          setEditing(null);
        }}
      >
        <TabsList aria-label="Catalog sections">
          <TabsTrigger value="definitions">Definitions</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="grid gap-6">
          {tab === "usage" ? (
            <Card className="overflow-x-auto p-5">
              <h2 className="font-semibold">Entitlement adoption</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Definition usage across {c.licensesScanned} licenses. This is not consumption; open
                Metering for consumed units.
              </p>
              <Table className="mt-5 w-full text-left text-sm">
                <TableHeader>
                  <TableRow>
                    {["Entitlement", "Types", "Licenses", "Active", "Plans"].map((h) => (
                      <TableHead key={h} className="py-3 pr-4">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.rows.map((u: any) => (
                    <TableRow key={u.name} className="border-t border-slate-200">
                      <TableCell className="py-3 pr-4 font-mono">{u.name}</TableCell>
                      <TableCell className="pr-4">{u.types.join(", ") || "Unused"}</TableCell>
                      <TableCell className="pr-4">{u.licenseCount}</TableCell>
                      <TableCell className="pr-4">{u.activeLicenseCount}</TableCell>
                      <TableCell>{u.plans.join(", ") || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <ListPagination {...list} />
              {!c.usage.length && (
                <p className="py-6 text-sm text-muted-foreground">
                  Add definitions and issue a license to see usage.
                </p>
              )}
            </Card>
          ) : (
            <>
              <Card className="p-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-semibold">
                    {tab === "definitions" ? "Defined entitlements" : "Plans"}
                  </h2>
                  {admin && (
                    <Button onClick={() => setEditing({})}>
                      Add {tab === "definitions" ? "entitlement" : "plan"}
                    </Button>
                  )}
                </div>
                <div className="mt-4 divide-y divide-slate-200">
                  {list.rows.map((item: any) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-4 py-4"
                    >
                      <div>
                        <p className="font-medium">
                          {item.id}{" "}
                          {item.archived && (
                            <span className="text-xs text-muted-foreground">Archived</span>
                          )}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {item.description || "No description"}
                          {tab === "definitions"
                            ? " · " + item.type
                            : " · " +
                              item.activationLimit +
                              " activation seats · " +
                              (c.planUsage.find((u: any) => u.id === item.id)?.licenseCount || 0) +
                              " licenses" +
                              (admin
                                ? " · " +
                                  (item.price == null ? "Price not configured" : birr(item.price))
                                : "")}
                        </p>
                      </div>
                      {admin && (
                        <ActionButton icon={Pencil} label="Edit" onClick={() => setEditing(item)} />
                      )}
                    </div>
                  ))}
                </div>
                <ListPagination {...list} />
                {!c[tab].length && (
                  <p className="py-6 text-sm text-muted-foreground">
                    {tab === "definitions"
                      ? "Define your first feature or quota."
                      : "Create a plan to issue licenses from consistent defaults."}
                  </p>
                )}
              </Card>
              {editing &&
                admin &&
                (tab === "definitions" ? (
                  <DefinitionEditor
                    key={editing.id || "new"}
                    value={editing}
                    done={() => {
                      setEditing(null);
                      refresh();
                    }}
                  />
                ) : (
                  <PlanEditor
                    key={editing.id || "new"}
                    value={editing}
                    done={() => {
                      setEditing(null);
                      refresh();
                    }}
                  />
                ))}
            </>
          )}
        </TabsContent>
      </Tabs>
      {admin && <CatalogImport refresh={refresh} />}
    </div>
  );
}
function DefinitionEditor({ value, done }: { value: any; done: () => void }) {
  const [id, setId] = useState(value.id || ""),
    [description, setDescription] = useState(value.description || ""),
    [type, setType] = useState(value.type === "mixed" ? "number" : value.type || "number"),
    [defaultValue, setDefault] = useState(
      value.defaultValue === undefined ? "" : String(value.defaultValue),
    ),
    [minimum, setMin] = useState(value.minimum === undefined ? "" : String(value.minimum)),
    [maximum, setMax] = useState(value.maximum === undefined ? "" : String(value.maximum)),
    [archived, setArchived] = useState(value.archived || false);
  const action = useAction(done);
  return (
    <Modal title={value.id ? "Edit definition" : "Add entitlement"} onClose={done}>
      <form
        className="mt-4 max-w-xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() =>
            request(productPath("/definitions/" + encodeURIComponent(id)), {
              method: "PUT",
              body: {
                id,
                description,
                type,
                archived,
                ...(defaultValue !== ""
                  ? {
                      defaultValue:
                        type === "number"
                          ? Number(defaultValue)
                          : type === "boolean"
                            ? defaultValue === "true"
                            : defaultValue,
                    }
                  : {}),
                ...(minimum !== "" ? { minimum: Number(minimum) } : {}),
                ...(maximum !== "" ? { maximum: Number(maximum) } : {}),
                ...(value.revision ? { revision: value.revision } : {}),
              },
            }),
          );
        }}
      >
        <FormFields>
          <TextField
            label="Permanent key"
            required
            disabled={Boolean(value.id)}
            value={id}
            onChange={setId}
          />
          <TextField label="Description" value={description} onChange={setDescription} />
        </FormFields>
        <FormFields>
          <Select
            label="Value type"
            value={type}
            onChange={setType}
            options={["number", "string", "boolean"].map((v) => ({ value: v, label: v }))}
          />
          {type === "boolean" ? (
            <Select
              label="Default (optional)"
              value={defaultValue}
              onChange={setDefault}
              options={[
                { value: "", label: "No default" },
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ]}
            />
          ) : (
            <TextField
              label="Default value (optional)"
              type={type === "number" ? "number" : "text"}
              value={defaultValue}
              onChange={setDefault}
            />
          )}
        </FormFields>
        {type === "number" && (
          <FormFields>
            <TextField label="Minimum (optional)" type="number" value={minimum} onChange={setMin} />
            <TextField label="Maximum (optional)" type="number" value={maximum} onChange={setMax} />
          </FormFields>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Archive definition
        </label>
        <p className="text-sm text-muted-foreground">
          A used key cannot be renamed or silently change type. Existing license grants remain
          snapshots.
        </p>
        <div className="flex gap-3">
          <Button type="submit" disabled={action.busy}>
            Save entitlement
          </Button>
          <Button variant="secondary" onClick={done}>
            Cancel
          </Button>
        </div>
        <Feedback action={action} />
      </form>
    </Modal>
  );
}
function PlanEditor({ value, done }: { value: any; done: () => void }) {
  const [id, setId] = useState(value.id || ""),
    [description, setDescription] = useState(value.description || ""),
    [rows, setRows] = useState<EntitlementRow[]>(entitlementsToRows(value.entitlements || {})),
    [days, setDays] = useState(
      value.durationDays === null || value.durationDays === undefined
        ? ""
        : String(value.durationDays),
    ),
    [price, setPrice] = useState(value.price == null ? "" : String(value.price / 100)),
    [limit, setLimit] = useState(String(value.activationLimit || 1)),
    [archived, setArchived] = useState(value.archived || false);
  const action = useAction(done);
  return (
    <Modal title={value.id ? "Edit plan" : "Add plan"} onClose={done}>
      <form
        className="mt-4 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() =>
            request(productPath("/plans/" + encodeURIComponent(id)), {
              method: "PUT",
              body: {
                id,
                description,
                entitlements: rowsToEntitlements(rows),
                durationDays: days === "" ? null : Number(days),
                activationLimit: Number(limit),
                archived,
                price: minor(price),
                currency: "ETB",
                ...(value.revision ? { revision: value.revision } : {}),
              },
            }),
          );
        }}
      >
        <FormFields>
          <TextField
            label="Permanent plan ID"
            required
            disabled={Boolean(value.id)}
            value={id}
            onChange={setId}
          />
          <TextField label="Description" value={description} onChange={setDescription} />
        </FormFields>
        <FormFields>
          <TextField label="Price (ETB)" value={price} onChange={setPrice} required />
          <Choice
            label="Currency"
            value="ETB"
            onChange={() => {}}
            options={[{ value: "ETB", label: "ETB · Ethiopian birr" }]}
          />
        </FormFields>
        <p className="text-sm text-muted-foreground">
          Use 0 for a complimentary license. Existing sale amounts never change.
        </p>
        <EntitlementsEditor rows={rows} onChange={setRows} />
        <FormFields>
          <TextField
            label="Duration days (empty for perpetual)"
            type="number"
            value={days}
            onChange={setDays}
          />
          <TextField label="Activation seats" type="number" value={limit} onChange={setLimit} />
        </FormFields>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Archive plan
        </label>
        <p className="text-sm text-muted-foreground">
          Changes affect newly issued licenses. Existing licenses keep their entitlement, expiry and
          seat snapshots.
        </p>
        <div className="flex gap-3">
          <Button type="submit" disabled={action.busy}>
            Save plan
          </Button>
          <Button variant="secondary" onClick={done}>
            Cancel
          </Button>
        </div>
        <Feedback action={action} />
      </form>
    </Modal>
  );
}
function CatalogImport({ refresh }: { refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(""),
    [preview, setPreview] = useState<any>(null);
  const action = useAction(refresh);
  async function exportCatalog() {
    const value = await request<any>(productPath("/catalog/export"));
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "product-catalog.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Import or export catalog
      </Button>
      {open && (
        <Modal title="Import or export catalog" onClose={() => setOpen(false)}>
          <p className="mt-3 text-sm text-muted-foreground">
            Configuration transfer includes definitions and plans, never secrets. Preview changes
            before applying them.
          </p>
          <div className="table-toolbar mt-4">
            <Button
              variant="secondary"
              onClick={() => void action.run(exportCatalog, "Catalog exported.")}
            >
              Export JSON
            </Button>
            <Field className="console-text-field">
              <FieldLabel htmlFor="catalog-upload">Load JSON</FieldLabel>
              <Input
                id="catalog-upload"
                aria-label="Load catalog JSON"
                type="file"
                accept=".json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f)
                    void f.text().then((t) => {
                      setText(t);
                      setPreview(null);
                    });
                }}
              />
            </Field>
          </div>
          {text && (
            <>
              <Button
                className="mt-4"
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    async () =>
                      setPreview(
                        await request(productPath("/catalog/import"), {
                          method: "POST",
                          body: { catalog: JSON.parse(text), preview: true },
                        }),
                      ),
                    "Preview ready.",
                  )
                }
              >
                Preview import
              </Button>
              {preview && (
                <div className="mt-4">
                  <p className="text-sm">
                    {preview.definitions} definitions and {preview.plans} plans will be created or
                    updated. Existing licenses stay unchanged.
                  </p>
                  <Button
                    className="mt-3"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        () =>
                          request(productPath("/catalog/import"), {
                            method: "POST",
                            body: {
                              catalog: JSON.parse(text),
                              preview: false,
                              fingerprint: preview.fingerprint,
                            },
                          }),
                        "Catalog imported.",
                      )
                    }
                  >
                    Apply previewed changes
                  </Button>
                </div>
              )}
            </>
          )}
          <Feedback action={action} />
        </Modal>
      )}
    </>
  );
}
