import { Badge } from "@/components/ui/badge";

import type { DeviceSummary } from "../api";

const labels: Record<string, string> = {
  "machine-guid": "Windows ID",
  "smbios-uuid": "System UUID",
  "volume-serial": "Volume",
  "linux-machine-id": "Linux ID",
  "macos-platform-uuid": "Mac UUID",
  "root-volume-uuid": "Root volume",
};
export function SignalAvailability({
  kinds,
  availability,
}: {
  kinds: string[];
  availability: DeviceSummary["signalAvailability"];
}) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Badge variant="outline">{availability}</Badge>
      <span className="text-xs text-muted-foreground">
        {kinds.map((kind) => labels[kind] ?? kind).join(" · ") || "No signals reported"}
      </span>
    </div>
  );
}
export function DeviceIdentity({ device }: { device: DeviceSummary }) {
  return (
    <div className="flex min-w-40 flex-col gap-2">
      {device.machineGroups.map((group) => (
        <span key={group.id} title={group.id} className="font-mono text-xs">
          {group.supportReference}
        </span>
      ))}
      {!device.machineGroups.length && (
        <span className="text-xs text-muted-foreground">No reported group</span>
      )}
      <SignalAvailability kinds={device.signalKinds} availability={device.signalAvailability} />
    </div>
  );
}
