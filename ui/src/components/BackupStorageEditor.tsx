import { useState } from "react";

import { FieldGroup } from "@/components/ui/field";

import { request } from "../api";
import { Button, Modal, TextField } from "../components";
import { Feedback, useAction } from "../platform-ui";
import { Checkbox } from "./Checkbox";

export interface StorageMetadata {
  revision: number;
  source: string;
  bucket?: string;
  region?: string;
  endpoint?: string;
  hasCredentials: boolean;
  hasSessionToken: boolean;
  verifiedAt?: string;
  editable: boolean;
}
export function BackupStorageEditor({
  id,
  name,
  settings,
  done,
  close,
}: {
  id: string;
  name: string;
  settings: StorageMetadata;
  done: () => void;
  close: () => void;
}) {
  const object = id === "s3" || id === "r2";
  const [bucket, setBucket] = useState(settings.bucket ?? "");
  const [region, setRegion] = useState(settings.region ?? (id === "r2" ? "auto" : "us-east-1"));
  const [endpoint, setEndpoint] = useState(settings.endpoint ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [clearSessionToken, setClearSessionToken] = useState(false);
  const [token, setToken] = useState("");
  const action = useAction();
  return (
    <Modal title={name + " storage settings"} onClose={action.busy ? undefined : close}>
      <p className="mt-3 text-sm text-muted-foreground">
        Bring your own storage account. Credentials are encrypted in the database and never
        displayed again. Leave credential fields blank to retain saved values. Keep a separate
        recovery copy.
      </p>
      <form
        className="mt-5 flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void action
            .run(
              () =>
                request("/admin/backups/providers/" + id, {
                  method: "PUT",
                  body: {
                    revision: settings.revision,
                    ...(object
                      ? {
                          bucket,
                          region,
                          endpoint,
                          accessKeyId,
                          secretAccessKey,
                          sessionToken,
                          clearSessionToken,
                        }
                      : { token }),
                  },
                }),
              "Storage settings saved.",
            )
            .then((ok) => {
              if (ok) done();
            });
        }}
      >
        <FieldGroup>
          {object ? (
            <>
              <TextField label="Bucket" value={bucket} onChange={setBucket} required />
              <TextField label="Region" value={region} onChange={setRegion} required />
              <TextField
                label={id === "r2" ? "R2 HTTPS endpoint" : "Custom HTTPS endpoint (optional)"}
                type="url"
                value={endpoint}
                onChange={setEndpoint}
                required={id === "r2"}
              />
              <TextField
                label="Access key ID"
                type="password"
                value={accessKeyId}
                onChange={setAccessKeyId}
                required={!settings.hasCredentials}
              />
              <TextField
                label="Secret access key"
                type="password"
                value={secretAccessKey}
                onChange={setSecretAccessKey}
                required={!settings.hasCredentials}
              />
              <TextField
                label="Session token (optional)"
                type="password"
                value={sessionToken}
                onChange={setSessionToken}
              />
              {settings.hasSessionToken && (
                <Checkbox
                  label="Remove saved session token"
                  checked={clearSessionToken}
                  onCheckedChange={(value) => setClearSessionToken(value === true)}
                />
              )}
            </>
          ) : (
            <TextField
              label={id === "blob" ? "Private Blob read/write token" : "UploadThing token"}
              type="password"
              value={token}
              onChange={setToken}
              required={!settings.hasCredentials}
            />
          )}
        </FieldGroup>
        <p className="text-sm text-muted-foreground">
          After saving, use Test connection to verify upload, download and deletion. A storage test
          does not replace a verified database backup.
        </p>
        <Feedback action={action} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={close} disabled={action.busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={action.busy || !settings.editable}>
            {action.busy ? "Saving…" : "Save storage settings"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
