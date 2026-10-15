import { useQuery } from "@tanstack/react-query";
import {
  Fingerprint,
  Boxes,
  ChartNoAxesCombined,
  CircleHelp,
  ChevronDown,
  LogOut,
  KeyRound,
  ListChecks,
  MessagesSquare,
  MonitorSmartphone,
  ScrollText,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import { lazy, Suspense, useEffect, type ReactNode, type ComponentProps } from "react";
import { Link, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";

import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

import { fetchAdminConfig, fetchMeta } from "./api";
import { signOut, useSession } from "./auth-client";
import { Spinner } from "./components";
import { ApplicationShell1 } from "./components/application-shell1";
import { Choice } from "./components/Choice";
import { GlobalCommand } from "./components/GlobalCommand";
import { ThemeControl } from "./components/ThemeControl";
import Audit from "./pages/Audit";
import Entitlements from "./pages/Entitlements";
import Finance, { FinancialReports } from "./pages/Finance";
import Inspect from "./pages/Inspect";
import Installations from "./pages/Installations";
import LicenseDetail from "./pages/LicenseDetail";
import LicenseRequests from "./pages/LicenseRequests";
import Licenses from "./pages/Licenses";
import Login from "./pages/Login";
import Machines from "./pages/Machines";
import Metering from "./pages/Metering";
import { NotificationBell } from "./pages/Notifications";
import Operators from "./pages/Operators";
import Products from "./pages/Products";
import Reports from "./pages/Reports";
import RequestLicense, { RequestStatus } from "./pages/RequestLicense";
import Settings from "./pages/Settings";
import Support from "./pages/Support";
import SupportDetail from "./pages/SupportDetail";
import Welcome from "./pages/Welcome";
import { ProductProvider, useProduct } from "./platform-ui";

const Docs = lazy(() => import("./pages/Docs"));

/** Close the mobile drawer when a navigation link is selected. */
function SidebarLink(props: ComponentProps<typeof Link>) {
  const { setOpenMobile } = useSidebar();
  return (
    <Link
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        if (
          !event.defaultPrevented &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        )
          setOpenMobile(false);
      }}
    />
  );
}
function RequireSession(props: { children: ReactNode }) {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  if (isPending) return <Spinner label="Checking session…" />;
  if (!session) return <Navigate to={location.pathname === "/" ? "/welcome" : "/login"} replace />;
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

/**
 * The console's navigation.
 *
 * Grouped rather than flat: the tabs it replaced were one undifferentiated row,
 * and at nine of them the last few were colliding with the operator's email.
 * Grouping also says something the row could not — that Licenses and
 * Entitlements are about what was sold, while Installations and Machines are
 * about what is running in the field, and an operator arrives already knowing
 * which half of that they are looking for.
 */
interface NavItem {
  to: string;
  label: string;
  icon: typeof KeyRound;
  enabled: boolean;
  /** Shown when the sidebar is collapsed to icons, where labels are gone. */
  hint: string;
  /**
   * Extra path prefixes this item is responsible for.
   *
   * Licenses lives at "/", which cannot be prefix-matched without swallowing
   * every other route — so the detail page it owns, /licenses/:id, has to be
   * named. Without this a license detail page highlights nothing, and the
   * sidebar silently stops answering "where am I?" on the one page you reach
   * by clicking rather than by navigating.
   */
  owns?: string[];
}

function Shell() {
  const { data: session } = useSession();
  const { id: productId, products, select } = useProduct();
  const name = useBranding();
  const location = useLocation();
  const { data: config } = useQuery({
    queryKey: ["admin-config"],
    queryFn: fetchAdminConfig,
    staleTime: Infinity,
  });
  const features = config?.features;
  const isAdmin = config?.viewer.role === "admin";
  const registry = features?.registry ?? true;

  const groups: { label: string; items: NavItem[] }[] = [
    {
      label: "Licensing",
      items: [
        {
          to: "/products",
          label: "Products",
          icon: Boxes,
          enabled: true,
          hint: "Products and policy",
        },
        {
          to: "/metering",
          label: "Metering",
          icon: ChartNoAxesCombined,
          enabled: true,
          hint: "Usage quotas",
        },
        {
          to: "/",
          label: "Licenses",
          icon: KeyRound,
          enabled: true,
          hint: "Licenses",
          owns: ["/licenses", "/license-requests"],
        },
        {
          to: "/entitlements",
          label: "Entitlements",
          icon: ListChecks,
          enabled: true,
          hint: "Entitlements",
        },
      ],
    },
    {
      label: "Field",
      items: [
        {
          to: "/installations",
          label: "Installations",
          icon: MonitorSmartphone,
          enabled: registry,
          hint: "Installations",
        },
        // The trial ledger lives behind the same switch as the census; with the
        // registry off the server 404s both, so offering the link would be a lie.
        {
          to: "/machines",
          label: "Machines",
          icon: Fingerprint,
          enabled: registry,
          hint: "Machines",
        },
      ],
    },
    {
      label: "Service",
      items: [
        {
          to: "/support",
          label: "Support",
          icon: MessagesSquare,
          enabled: true,
          hint: "Support inbox",
        },
        {
          to: "/sales",
          label: "Sales & payments",
          icon: ChartNoAxesCombined,
          enabled: isAdmin,
          hint: "Sales & payments",
        },

        { to: "/inspect", label: "Inspector", icon: ShieldCheck, enabled: true, hint: "Inspector" },

        // Operator management is an admin job, and the server enforces that too.
        { to: "/operators", label: "Operators", icon: Users, enabled: isAdmin, hint: "Operators" },

        {
          to: "/settings",
          label: "Settings",
          icon: Settings2,
          enabled: true,
          hint: "Account, preferences and system",
        },
      ],
    },
    {
      label: "Reports",
      items: [
        {
          to: "/reports",
          label: "Reports",
          icon: ChartNoAxesCombined,
          enabled: true,
          hint: "Operational reports",
        },
        {
          to: "/reports/financial",
          label: "Financial Report",
          icon: ChartNoAxesCombined,
          enabled: isAdmin,
          hint: "Sales, payments and outstanding balances",
        },
        {
          to: "/audit",
          label: "Audit",
          icon: ScrollText,
          enabled: features?.audit ?? true,
          hint: "Audit",
        },
      ],
    },
  ]
    .map((group) => ({ ...group, items: group.items.filter((item) => item.enabled) }))
    .filter((group) => group.items.length > 0);

  // "/" would prefix-match every route, so it is compared exactly and the pages
  // it owns are listed explicitly; everything else matches by prefix.
  const isCurrent = (item: NavItem) => {
    const path = location.pathname;
    if (item.owns?.some((prefix) => path.startsWith(prefix))) return true;
    return item.to === "/" || item.to === "/reports" ? path === item.to : path.startsWith(item.to);
  };

  return (
    <ApplicationShell1
      sidebar={
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton size="lg" asChild>
                  <SidebarLink to="/" className="console-brand">
                    <div className="console-brand-mark">
                      <KeyRound className="size-5" />
                    </div>
                    <div className="grid flex-1 text-left leading-tight">
                      <span className="truncate font-semibold">{name}</span>
                      <span className="truncate text-xs text-slate-500">License console</span>
                    </div>
                  </SidebarLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>

          <SidebarContent>
            {groups.map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton asChild isActive={isCurrent(item)} tooltip={item.hint}>
                          <SidebarLink
                            to={item.to}
                            aria-current={isCurrent(item) ? "page" : undefined}
                          >
                            <item.icon />
                            <span>{item.label}</span>
                          </SidebarLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </SidebarContent>

          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Help & documentation">
                  <SidebarLink to="/docs">
                    <CircleHelp />
                    <span>Help & documentation</span>
                  </SidebarLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
      }
      header={
        <>
          <SidebarTrigger aria-label="Toggle Sidebar" />
          <Breadcrumb className="console-route-label">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{currentTitle(groups, isCurrent)}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <GlobalCommand
            items={groups.flatMap((g) =>
              g.items.map((item) => ({
                id: item.to,
                label: item.label,
                group: g.label,
                icon: <item.icon />,
              })),
            )}
          />
          <div className="console-product">
            <Choice
              hideLabel
              label="Active product"
              value={productId}
              onChange={select}
              options={products.map((p) => ({
                value: p.id,
                label: p.name + (p.archived ? " (archived)" : ""),
              }))}
            />
          </div>
          <ThemeControl />
          <NotificationBell />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="console-account" aria-label="Open account menu">
                <Avatar>
                  <AvatarImage src={session?.user.image ?? undefined} alt="" />
                  <AvatarFallback>
                    {(session?.user.name || session?.user.email || "?").slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <ChevronDown className="size-4 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="end" className="w-64">
              <DropdownMenuLabel>
                <div className="space-y-1">
                  <p className="truncate">{session?.user.name}</p>
                  <p className="truncate text-xs font-normal">{session?.user.email}</p>
                  <p className="text-xs font-normal capitalize">
                    {config?.viewer.role ?? "Operator"}
                  </p>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <SidebarLink to="/settings">
                  <Settings2 />
                  Settings
                </SidebarLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href="/docs" target="_blank" rel="noreferrer">
                  Help & documentation
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => void signOut().then(() => window.location.assign("/login"))}
              >
                <LogOut />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <div
        id="console-content"
        tabIndex={-1}
        className="console-content"
        aria-label={
          location.pathname === "/profile"
            ? "Profile"
            : location.pathname === "/settings"
              ? "Settings"
              : currentTitle(groups, isCurrent)
        }
      >
        <Outlet key={`${productId}:${location.search}`} />
      </div>
    </ApplicationShell1>
  );
}

/** The active item's label, so the collapsed sidebar still leaves a signpost. */
function currentTitle(
  groups: { items: NavItem[] }[],
  isCurrent: (item: NavItem) => boolean,
): string {
  for (const group of groups) {
    for (const item of group.items) {
      if (isCurrent(item)) return item.label;
    }
  }
  return "";
}

export default function App() {
  return (
    <Suspense fallback={<Spinner label="Loading documentation…" />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:slug" element={<Docs />} />
        <Route path="/help" element={<Navigate to="/docs" replace />} />
        <Route path="/request-license" element={<RequestLicense />} />
        <Route path="/license-request/:id" element={<RequestStatus />} />
        <Route
          element={
            <RequireSession>
              <ProductProvider>
                <Shell />
              </ProductProvider>
            </RequireSession>
          }
        >
          <Route path="/" element={<Licenses />} />
          <Route path="/license-requests" element={<LicenseRequests />} />
          <Route path="/licenses/:id" element={<LicenseDetail />} />
          <Route path="/entitlements" element={<Entitlements />} />
          <Route path="/installations" element={<Installations />} />
          <Route path="/machines" element={<Machines />} />
          <Route path="/support" element={<Support />} />
          <Route path="/support/:id" element={<SupportDetail />} />
          <Route path="/inspect" element={<Inspect />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/operators" element={<Operators />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/profile" element={<Navigate to="/settings?tab=account" replace />} />
          <Route path="/sales" element={<Finance />} />
          <Route
            path="/notifications"
            element={<Navigate to="/settings?tab=notifications" replace />}
          />
          <Route path="/reports/financial" element={<FinancialReports />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/products" element={<Products />} />
          <Route path="/metering" element={<Metering />} />
          <Route path="/backups" element={<Navigate to="/settings?tab=backups" replace />} />
          <Route path="/system" element={<Navigate to="/settings?tab=system" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
