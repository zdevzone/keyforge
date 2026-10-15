/** Internal Node-only primitives shared by opt-in desktop collectors. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, constants } from "node:fs/promises";

import type { DeviceSignalKind, DeviceSignalsProvider, DeviceSignalsReport } from "./types.js";
export const QUERY_TIMEOUT_MS = 8000;
export class DeviceSignalQueryError extends Error {
  constructor(
    public readonly status: "timeout" | "permission_denied" | "unavailable" | "query_failed",
  ) {
    super(`Device signal query: ${status}`);
  }
}
export function queryError(error: unknown): DeviceSignalQueryError {
  const value = error as { code?: string | number; killed?: boolean } | null;
  return new DeviceSignalQueryError(
    value?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? "query_failed"
      : value?.killed
        ? "timeout"
        : value?.code === "EACCES" || value?.code === "EPERM" || value?.code === 5
          ? "permission_denied"
          : value?.code === "ENOENT"
            ? "unavailable"
            : "query_failed",
  );
}
export function executeQuery(
  file: string,
  args: readonly string[],
  maxBuffer = 4096,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: QUERY_TIMEOUT_MS, maxBuffer, encoding: "utf8" },
      (error, stdout) => (error ? reject(queryError(error)) : resolve(stdout)),
    ),
  );
}
/** Fixed local files only; one bounded nonblocking read also works for size-zero sysfs files. */
export async function readIdentifier(file: string): Promise<string> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new DeviceSignalQueryError("unavailable");
      const bytes = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4096) throw new DeviceSignalQueryError("query_failed");
      return bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw error instanceof DeviceSignalQueryError ? error : queryError(error);
  }
}
/** UUIDs use lowercase unbraced hyphenated hex; volume serials use eight lowercase hex digits. */
export function normalizeDeviceIdentifier(kind: DeviceSignalKind, input: string): string | null {
  if (input.length > 256) return null;
  const value = input.trim().toLowerCase();
  if (kind === "volume-serial") {
    const hex = value.replace(/^([a-f0-9]{4})-([a-f0-9]{4})$/, "$1$2");
    return /^[a-f0-9]{8}$/.test(hex) && !/^(0{8}|f{8}|12345678)$/.test(hex) ? hex : null;
  }
  if (kind === "linux-machine-id")
    return /^[a-f0-9]{32}$/.test(value) && !/^([a-f0-9])\1{31}$/.test(value) ? value : null;
  const uuid = value.replace(/^\{([a-f0-9-]+)\}$/, "$1");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(uuid)) return null;
  const compact = uuid.replaceAll("-", "");
  if (
    /^(0{32}|f{32}|([a-f0-9])\2{31})$/.test(compact) ||
    compact === "03000200040005000006000700080009"
  )
    return null;
  return uuid;
}

/** v1: SHA-256 of UTF-8 JSON [domain, version, canonical deployment URL, product, kind, identifier]. */
export function hashDeviceIdentifier(
  context: { serverUrl: string; productId: string },
  kind: DeviceSignalKind,
  normalized: string,
): string {
  const url = new URL(context.serverUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-z][a-z0-9-]{0,59}$/.test(context.productId)
  )
    throw new Error("Invalid device signal scope");
  const deployment = url.toString().replace(/\/$/, "");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "keyforge-device-signals",
        1,
        deployment,
        context.productId,
        kind,
        normalized,
      ]),
      "utf8",
    )
    .digest("hex");
}

export function boundedQuery(
  query: (kind: DeviceSignalKind) => Promise<string>,
  kind: DeviceSignalKind,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeviceSignalQueryError("timeout")), QUERY_TIMEOUT_MS);
    Promise.resolve()
      .then(() => query(kind))
      .then(
        (value) => {
          clearTimeout(timer);
          if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4096)
            reject(new DeviceSignalQueryError("query_failed"));
          else resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

export function createSignalProvider(
  platform: string,
  kinds: readonly DeviceSignalKind[],
  options: { platform?: string; query?: (kind: DeviceSignalKind) => Promise<string> },
  nativeQuery: (kind: DeviceSignalKind) => Promise<string>,
): DeviceSignalsProvider {
  return async (context) => {
    const report: DeviceSignalsReport = { signals: [], diagnostics: [] };
    for (const kind of kinds) {
      let status: DeviceSignalsReport["diagnostics"][number]["status"] = "unsupported";
      if ((options.platform ?? process.platform) === platform) {
        try {
          const raw = await boundedQuery(options.query ?? nativeQuery, kind);
          const normalized = normalizeDeviceIdentifier(kind, raw);
          status = normalized ? "available" : raw.trim() ? "invalid" : "unavailable";
          if (normalized)
            report.signals.push({ kind, hash: hashDeviceIdentifier(context, kind, normalized) });
        } catch (error) {
          status =
            error instanceof DeviceSignalQueryError ? error.status : queryError(error).status;
        }
      }
      report.diagnostics.push({ kind, status });
    }
    return report;
  };
}
