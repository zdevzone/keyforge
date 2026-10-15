import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

import { fetchAdminConfig } from "../api";
import { changePassword, useSession } from "../auth-client";
import { Button, Card, ErrorNote, TextField } from "../components";
import { AccountSessions } from "../components/AccountSessions";
import { Choice } from "../components/Choice";
import { useTheme, setTheme } from "../components/ThemeControl";
import Backups from "./Backups";
import Notifications, { NotificationPreferences } from "./Notifications";
import Profile from "./Profile";
import System from "./System";

export default function Settings() {
  const config = useQuery({ queryKey: ["admin-config"], queryFn: fetchAdminConfig });
  const [params, setParams] = useSearchParams();
  const theme = useTheme();
  const admin = config.data?.viewer.role === "admin";
  const requested = params.get("tab") || "account";
  const tab =
    ["account", "preferences", "notifications"].includes(requested) ||
    (admin &&
      (requested === "system" || (requested === "backups" && config.data?.features.backups)))
      ? requested
      : "account";
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your account, personal preferences and service configuration.
        </p>
      </div>
      <Tabs
        className="settings-tabs"
        value={tab}
        onValueChange={(value) => setParams({ tab: value })}
      >
        <TabsList variant="line" aria-label="Settings sections">
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          {admin && config.data?.features.backups && (
            <TabsTrigger value="backups">Backups</TabsTrigger>
          )}
          {admin && <TabsTrigger value="system">System</TabsTrigger>}
        </TabsList>
        <TabsContent value="account">
          <div className="flex flex-col gap-6">
            <Profile embedded />
            <ChangePassword />
            <AccountSessions />
          </div>
        </TabsContent>
        <TabsContent value="preferences">
          <div className="flex flex-col gap-6">
            <Card className="p-5">
              <h2 className="font-semibold">Appearance</h2>
              <p className="mt-2 mb-4 text-sm text-muted-foreground">
                Your theme is saved in this browser and applies throughout the console.
              </p>
              <Choice
                label="Theme"
                searchable={false}
                value={theme}
                onChange={(value) => setTheme(value as "light" | "dark")}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </Card>
            <NotificationPreferences />
          </div>
        </TabsContent>
        <TabsContent value="notifications">
          <Notifications embedded />
        </TabsContent>
        {admin && config.data?.features.backups && (
          <TabsContent value="backups">
            <Backups embedded />
          </TabsContent>
        )}
        {admin && (
          <TabsContent value="system">
            <System embedded />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

function ChangePassword() {
  const { data: session } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    setSubmitting(true);
    // Other sessions are revoked on success — a password change usually means
    // the old one should stop working everywhere, this browser excepted.
    const { error: apiError } = await changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setSubmitting(false);
    if (apiError) {
      setError(apiError.message ?? "Password change failed.");
      return;
    }
    setDone(true);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Change password</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Signed in as <span className="font-medium">{session?.user.email}</span>. Changing your
        password signs out every other session.
      </p>
      <form onSubmit={onSubmit} className="mt-5 flex max-w-3xl flex-col gap-5">
        <TextField
          label="Current password"
          type="password"
          required
          value={currentPassword}
          onChange={setCurrentPassword}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="New password"
            type="password"
            required
            value={newPassword}
            onChange={setNewPassword}
          />
          <TextField
            label="Confirm"
            type="password"
            required
            value={confirmPassword}
            onChange={setConfirmPassword}
          />
        </div>
        {error && <ErrorNote message={error} />}
        {done && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            Password changed. If this operator is seeded at boot (LICENSE_SEED_ADMIN_PASSWORD), the
            stored password stays as you set it here — seeding never overwrites an existing user.
          </div>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Changing…" : "Change password"}
        </Button>
      </form>
    </Card>
  );
}
