/** Layout adapted from @shadcnblocks/settings-profile1; fields and persistence belong to KeyForge. */
import type { ReactNode } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
export function SettingsProfile1({ children }: { children: ReactNode }) {
  return (
    <Card className="console-card gap-0 py-0 shadow-none">
      <CardHeader className="border-b px-6 py-5">
        <CardTitle>Profile information</CardTitle>
        <CardDescription>
          Manage your photo and the contact details associated with your operator account.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-6">{children}</CardContent>
    </Card>
  );
}
