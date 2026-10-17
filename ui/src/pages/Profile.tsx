import { useState } from "react";

import { authClient, useSession } from "../auth-client";
import { Button, FormFields, TextField, Spinner } from "../components";
import { ProfileImage } from "../components/ProfileImage";
import { SettingsProfile1 } from "../components/settings-profile1";
import { Feedback, useAction } from "../platform-ui";
export default function Profile({ embedded = false }: { embedded?: boolean }) {
  const { data: session, refetch } = useSession();
  if (!session) return <Spinner label="Loading profile…" />;
  return (
    <Editor
      key={session.user.id}
      user={session.user}
      refresh={() => void refetch()}
      embedded={embedded}
    />
  );
}
function Editor({
  user,
  refresh,
  embedded,
}: {
  user: any;
  refresh: () => void;
  embedded: boolean;
}) {
  const [name, setName] = useState(user.name),
    [image, setImage] = useState(user.image || "");
  const [phone, setPhone] = useState(user.phone || ""),
    [jobTitle, setJob] = useState(user.jobTitle || "");
  const [timezone, setTimezone] = useState(
    user.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [imageBusy, setImageBusy] = useState(false);
  const action = useAction(refresh);
  return (
    <div className="space-y-8">
      {!embedded && (
        <div>
          <h1 className="text-xl font-semibold">Your profile</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Contact information for your operator account.
          </p>
        </div>
      )}
      <SettingsProfile1>
        <form
          className="flex max-w-3xl flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const result = await authClient.updateUser({
                name,
                image: image || null,
                phone,
                jobTitle,
                timezone,
              });
              if (result.error) throw new Error(result.error.message);
            });
          }}
        >
          <ProfileImage value={image} onChange={setImage} name={name} onBusy={setImageBusy} />
          <TextField label="Name" value={name} onChange={setName} required />
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Use an image URL instead
            </summary>
            <div className="mt-3">
              <TextField
                label="Avatar URL (HTTPS)"
                value={image.startsWith("data:") ? "" : image}
                onChange={setImage}
              />
            </div>
          </details>
          <FormFields>
            <TextField label="Phone" value={phone} onChange={setPhone} />
            <TextField label="Job title" value={jobTitle} onChange={setJob} />
          </FormFields>
          <TextField label="Timezone" value={timezone} onChange={setTimezone} />
          <p className="text-sm text-muted-foreground">
            Login email: {user.email}. Your administrator manages your email and role.
          </p>
          <Button type="submit" disabled={action.busy || imageBusy}>
            {action.busy ? "Saving…" : "Save profile"}
          </Button>
          <Feedback action={action} />
        </form>
      </SettingsProfile1>
    </div>
  );
}
