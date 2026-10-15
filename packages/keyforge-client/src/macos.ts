/** Optional Node-only macOS adapter; fixed read-only Apple system utilities. */
import { createSignalProvider, executeQuery } from "./device-signals-node.js";
import type { DeviceSignalsProvider } from "./types.js";

export interface MacOSDeviceSignalsOptions {
  platform?: string;
  /** Test seam. Raw utility output stays local and is never returned in reports. */
  execute?: (file: string, args: readonly string[]) => Promise<string>;
}
export function createMacOSDeviceSignalsProvider(
  options: MacOSDeviceSignalsOptions = {},
): DeviceSignalsProvider {
  const execute = options.execute ?? ((file, args) => executeQuery(file, args, 65536));
  return createSignalProvider(
    "darwin",
    ["macos-platform-uuid", "root-volume-uuid"],
    options,
    async (kind) => {
      if (kind === "macos-platform-uuid") {
        const value = await execute("/usr/sbin/ioreg", [
          "-r",
          "-d",
          "1",
          "-c",
          "IOPlatformExpertDevice",
          "-w",
          "0",
        ]);
        if (Buffer.byteLength(value, "utf8") > 65536) throw new Error("query_failed");
        return /"IOPlatformUUID"\s*=\s*"([^"\r\n]{0,256})"/.exec(value)?.[1] ?? "";
      }
      const value = await execute("/usr/sbin/diskutil", ["info", "-plist", "/"]);
      if (Buffer.byteLength(value, "utf8") > 65536) throw new Error("query_failed");
      // Read one known plist scalar, not arbitrary XML/entities or snapshot identifiers.
      return /<key>VolumeUUID<\/key>\s*<string>([^<\r\n]{0,256})<\/string>/.exec(value)?.[1] ?? "";
    },
  );
}
