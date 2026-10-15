import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

import { request } from "./api";
import { useSession } from "./auth-client";
import { Choice } from "./components/Choice";
export interface Product {
  id: string;
  name: string;
  archived: boolean;
  revision: number;
  graceDays: number;
  trial: { enabled: boolean; allowance: number | null; durationDays: number | null };
  keys: { kid: string; publicKeyPem: string; retiredAt: string | null; pending?: boolean }[];
}
const Context = createContext<{
  id: string;
  products: Product[];
  isPending: boolean;
  error: Error | null;
  select: (id: string) => void;
}>({
  id: "default",
  products: [],
  isPending: true,
  error: null,
  select: () => {},
});
export function ProductProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const cache = useQueryClient();
  const [id, setId] = useState(localStorage.getItem("keyforge-product") || "default");
  const { data, isPending, error } = useQuery({
    queryKey: ["products", session.data?.user.id],
    queryFn: () => request<{ products: Product[] }>("/admin/products"),
    enabled: Boolean(session.data),
  });
  const select = useCallback(
    (next: string) => {
      localStorage.setItem("keyforge-product", next);
      setId(next);
      cache.removeQueries({ predicate: (q) => q.queryKey[0] !== "products" });
    },
    [cache],
  );
  useEffect(() => {
    if (data?.products.length && !data.products.some((p) => p.id === id))
      // Synchronize a persisted preference when the external product catalog removes it.
      // eslint-disable-next-line react/set-state-in-effect
      select(data.products[0].id);
  }, [data, id, select]);
  return (
    <Context.Provider value={{ id, products: data?.products ?? [], isPending, error, select }}>
      {children}
    </Context.Provider>
  );
}
export const useProduct = () => useContext(Context);
export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return <Choice label={label} value={value} onChange={onChange} options={options} />;
}
export function useAction(refresh?: () => void | Promise<unknown>) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState("");
  async function run(work: () => Promise<unknown>, message = "Saved.") {
    setBusy(true);
    setError("");
    setDone("");
    try {
      await work();
      setDone(message);
      await refresh?.();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, done, run };
}
export function Feedback({ action }: { action: ReturnType<typeof useAction> }) {
  return (
    <div aria-live="polite">
      {action.error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {action.error}
        </p>
      )}
      {action.done && <p className="mt-3 text-sm text-success">{action.done}</p>}
    </div>
  );
}
export async function download(path: string, fallback: string) {
  const response = await fetch(path);
  if (!response.ok || response.headers.get("content-type")?.includes("json")) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || "Download failed. Try again.");
  }
  const blob = await response.blob(),
    url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download =
    response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || fallback;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
