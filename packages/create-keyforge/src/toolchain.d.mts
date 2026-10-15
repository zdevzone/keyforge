/**
 * Types for toolchain.mjs. Hand-written for the same reason as the other
 * .d.mts files here: the scaffolder ships as plain ESM with no build step, and
 * the server's TypeScript test suite checks its output.
 */

import type { Choice } from "./generate.d.mts";

export type PackageManagerId = "vp" | "npm" | "pnpm" | "yarn" | "bun";
export type RuntimeId = "node";

export const PACKAGE_MANAGERS: Choice<PackageManagerId>[];
export const RUNTIMES: Choice<RuntimeId>[];

export interface PackageManagerCommands {
  install: string;
  frozenInstall: string;
  run(script: string): string;
  /** Adds npm's `--` separator; every other manager passes flags through. */
  runWithFlags(script: string, flags: string): string;
  exec(binary: string): string;
  /** Same three, scoped to a sub-package directory such as `ui`. */
  installIn(dir: string): string;
  frozenInstallIn(dir: string): string;
  runIn(dir: string, script: string): string;
  lockfile: string;
  corepack: boolean;
}

export interface RuntimeConfig {
  version: string;
  dockerImage: string;
  dockerSlimImage: string;
  startCommand: string;
}

export interface DevEngines {
  runtime: { name: string; version: string; onFail: string };
  packageManager: { name: string; version: string; onFail: string };
}

export function commands(id: PackageManagerId): PackageManagerCommands;
export function packageManagerField(id: PackageManagerId): string;
export function runtimeConfig(id: RuntimeId): RuntimeConfig;
export function devEngines(packageManager: PackageManagerId, runtime: RuntimeId): DevEngines;
export function isPackageManager(value: unknown): value is PackageManagerId;
export function isRuntime(value: unknown): value is RuntimeId;

export const DEFAULT_PACKAGE_MANAGER: PackageManagerId;
export const DEFAULT_RUNTIME: RuntimeId;
