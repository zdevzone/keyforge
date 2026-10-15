/** App-owned adaptation of @shadcnblocks/application-shell1; all links and account actions are supplied by KeyForge. */
import type { ReactNode, CSSProperties } from "react";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
export function ApplicationShell1({
  sidebar,
  header,
  children,
}: {
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarProvider
      style={{ "--sidebar-width": "15rem", "--sidebar-width-icon": "3.5rem" } as CSSProperties}
    >
      <a className="skip-link" href="#console-content">
        Skip to content
      </a>
      {sidebar}
      <SidebarInset>
        <header className="console-header">{header}</header>
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
