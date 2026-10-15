/** Optional Node-only Linux adapter. No sudo, dmidecode, disk reads or shell scripts. */
import {
  createSignalProvider,
  DeviceSignalQueryError,
  executeQuery,
  readIdentifier,
} from "./device-signals-node.js";
import type { DeviceSignalKind, DeviceSignalsProvider } from "./types.js";

export interface LinuxDeviceSignalsOptions {
  platform?: string;
  /** Inject read-only OS operations for integration tests. */
  readFile?: (path: string) => Promise<string>;
  execute?: (file: string, args: readonly string[]) => Promise<string>;
}
export function createLinuxDeviceSignalsProvider(
  options: LinuxDeviceSignalsOptions = {},
): DeviceSignalsProvider {
  const read = options.readFile ?? readIdentifier,
    execute = options.execute ?? executeQuery;
  const query = async (kind: DeviceSignalKind): Promise<string> => {
    if (kind === "linux-machine-id") {
      try {
        const value = await read("/etc/machine-id");
        if (value.trim()) return value;
      } catch (error) {
        if (
          !(error instanceof DeviceSignalQueryError && error.status === "unavailable") &&
          (error as { code?: string })?.code !== "ENOENT"
        )
          throw error;
      }
      return read("/var/lib/dbus/machine-id");
    }
    if (kind === "smbios-uuid") return read("/sys/class/dmi/id/product_uuid");
    for (const file of ["/usr/bin/findmnt", "/bin/findmnt"]) {
      try {
        return await execute(file, ["--noheadings", "--raw", "--output", "UUID", "--target", "/"]);
      } catch (error) {
        if (
          !(error instanceof DeviceSignalQueryError && error.status === "unavailable") &&
          (error as { code?: string })?.code !== "ENOENT"
        )
          throw error;
      }
    }
    throw new DeviceSignalQueryError("unavailable");
  };
  return createSignalProvider(
    "linux",
    ["linux-machine-id", "smbios-uuid", "root-volume-uuid"],
    { ...options, query },
    query,
  );
}
