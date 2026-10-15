/** Optional Node-only Windows adapter. Never imported by the framework-independent entry point. */
import { join } from "node:path";

import { createSignalProvider, executeQuery } from "./device-signals-node.js";
import type { DeviceSignalKind, DeviceSignalsProvider } from "./types.js";
export {
  DeviceSignalQueryError as WindowsQueryError,
  hashDeviceIdentifier as hashWindowsIdentifier,
  normalizeDeviceIdentifier as normalizeWindowsIdentifier,
} from "./device-signals-node.js";
const kinds = ["machine-guid", "smbios-uuid", "volume-serial"] as const;
const queries: Record<string, string> = {
  "machine-guid":
    "(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid",
  "smbios-uuid": "(Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop).UUID",
  "volume-serial":
    "(Get-CimInstance -ClassName Win32_LogicalDisk -Filter ('DeviceID=' + [char]39 + $env:SystemDrive + [char]39) -ErrorAction Stop).VolumeSerialNumber",
};

export interface WindowsDeviceSignalsOptions {
  /** Test seam: return one identifier, never command output or errors containing it. */
  query?: (kind: DeviceSignalKind) => Promise<string>;
  platform?: string;
}
function systemQuery(kind: DeviceSignalKind): Promise<string> {
  const executable = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const command =
    "$ErrorActionPreference='Stop'; try { " +
    queries[kind] +
    " } catch { if ($_.Exception -is [System.UnauthorizedAccessException] -or $_.FullyQualifiedErrorId -match 'AccessDenied|Unauthorized') { exit 5 }; exit 1 }";
  return executeQuery(executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ]);
}
export function createWindowsDeviceSignalsProvider(
  options: WindowsDeviceSignalsOptions = {},
): DeviceSignalsProvider {
  return createSignalProvider("win32", kinds, options, systemQuery);
}
