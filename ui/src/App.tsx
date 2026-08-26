import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";

import { fetchAdminConfig, fetchMeta } from "./api";
import { signOut, useSession } from "./auth-client";
import { Spinner } from "./components";
import Audit from "./pages/Audit";
import Entitlements from "./pages/Entitlements";
import Inspect from "./pages/Inspect";
import Installations from "./pages/Installations";
import LicenseDetail from "./pages/LicenseDetail";
import Licenses from "./pages/Licenses";
import Login from "./pages/Login";
import Operators from "./pages/Operators";
import Settings from "./pages/Settings";

function RequireSession(props: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  if (isPending) return <Spinner label="Checking session…" />;
  if (!session) return <Navigate to="/login" replace />;
  return <>{props.children}</>;
}

/** Deployment identity; drives titles everywhere, cached for the session. */
export function useBranding(): string {
  const { data } = useQuery({ queryKey: ["meta"], queryFn: fetchMeta, staleTime: Infinity });
  const name = data?.name ?? "License Console";
  useEffect(() => {
    document.title = name;
  }, [name]);
  return name;
}

function Shell() {
  const { data: session } = useSession();
  const name = useBranding();
  const { data: config } = useQuery({
    queryKey: ["admin-config"],
    queryFn: fetchAdminConfig,
    staleTime: Infinity,
  });
  const features = config?.features;
  const isAdmin = config?.viewer.role === "admin";
  const navItems = [
    { to: "/", label: "Licenses", enabled: true },
    { to: "/entitlements", label: "Entitlements", enabled: true },
    { to: "/installations", label: "Installations", enabled: features?.registry ?? true },
    { to: "/inspect", label: "Inspector", enabled: true },
    { to: "/audit", label: "Audit", enabled: features?.audit ?? true },
    // Operator management is an admin job, and the server enforces that too.
    { to: "/operators", label: "Operators", enabled: isAdmin },
    { to: "/settings", label: "Settings", enabled: true },
  ].filter((item) => item.enabled);
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <div className="font-semibold">{name}</div>
            <nav className="flex gap-1 text-sm">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    `rounded-lg px-3 py-1.5 ${
                      isActive
                        ? "bg-slate-100 font-medium text-slate-900"
                        : "text-slate-500 hover:text-slate-900"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <span>
              {session?.user.email}
              {config?.viewer.role === "support" && (
                <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                  support
                </span>
              )}
            </span>
            <button
              onClick={() => void signOut().then(() => window.location.assign("/login"))}
              className="rounded-lg border border-slate-300 px-3 py-1 hover:bg-slate-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireSession>
            <Shell />
          </RequireSession>
        }
      >
        <Route path="/" element={<Licenses />} />
        <Route path="/licenses/:id" element={<LicenseDetail />} />
        <Route path="/entitlements" element={<Entitlements />} />
        <Route path="/installations" element={<Installations />} />
        <Route path="/inspect" element={<Inspect />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/operators" element={<Operators />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
