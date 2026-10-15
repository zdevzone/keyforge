/** Optional Node-only auto-detection. The core @zdevzone/keyforge-client entry point never imports this. */
import { createLinuxDeviceSignalsProvider, type LinuxDeviceSignalsOptions } from "./linux.js";
import { createMacOSDeviceSignalsProvider, type MacOSDeviceSignalsOptions } from "./macos.js";
import type { DeviceSignalsProvider } from "./types.js";
import { createWindowsDeviceSignalsProvider, type WindowsDeviceSignalsOptions } from "./windows.js";

export {
  DeviceSignalQueryError,
  hashDeviceIdentifier,
  normalizeDeviceIdentifier,
} from "./device-signals-node.js";
export interface DeviceSignalsOptions {
  platform?: string;
  windows?: Omit<WindowsDeviceSignalsOptions, "platform">;
  linux?: Omit<LinuxDeviceSignalsOptions, "platform">;
  macos?: Omit<MacOSDeviceSignalsOptions, "platform">;
}
export function createDeviceSignalsProvider(
  options: DeviceSignalsOptions = {},
): DeviceSignalsProvider {
  const platform = options.platform ?? process.platform;
  if (platform === "win32")
    return createWindowsDeviceSignalsProvider({ ...options.windows, platform });
  if (platform === "linux") return createLinuxDeviceSignalsProvider({ ...options.linux, platform });
  if (platform === "darwin")
    return createMacOSDeviceSignalsProvider({ ...options.macos, platform });
  // Other runtimes retain installation licensing; no fake fingerprint is manufactured.
  return async () => ({ signals: [], diagnostics: [] });
}
