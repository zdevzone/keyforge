import { useEffect, useState } from "react";

import { productPath, request } from "../api";
import { Button, Card, TextField } from "../components";
import { Feedback, useAction } from "../platform-ui";
export default function ProductKey({
  license,
}: {
  license: { id: string; keyReference: string; keyStored: boolean };
}) {
  const [password, setPassword] = useState(""),
    [revealed, setRevealed] = useState("");
  const action = useAction();
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(""), 60000);
    return () => clearTimeout(timer);
  }, [revealed]);
  return (
    <Card className="p-5">
      <h2 className="font-semibold">Product key</h2>
      <p className="mt-2 font-mono text-sm">{license.keyReference}</p>
      <p className="mt-2 text-sm text-slate-600">
        Admin-only reveal is audited. Plaintext is hidden again after one minute.
      </p>
      <form
        className="mt-4 max-w-md space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setRevealed("");
          void action.run(async () => {
            const result = await request<{ key: string }>(
              productPath("/licenses/" + license.id + "/key"),
              { method: "POST", body: { password } },
            );
            setRevealed(result.key);
            setPassword("");
          }, "Key revealed.");
        }}
      >
        <TextField
          label="Current password"
          type="password"
          value={password}
          onChange={setPassword}
          required
        />
        <Button type="submit" disabled={action.busy || !license.keyStored}>
          Reveal key
        </Button>
        <Feedback action={action} />
      </form>
      {revealed && (
        <div className="mt-4 space-y-3">
          <code className="block select-all break-all rounded-lg bg-slate-100 p-3 text-sm">
            {revealed}
          </code>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                void action.run(() => navigator.clipboard.writeText(revealed), "Key copied.")
              }
            >
              Copy key
            </Button>
            <Button variant="secondary" onClick={() => setRevealed("")}>
              Hide
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
