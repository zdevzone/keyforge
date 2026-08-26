/** Types for platforms.mjs — see generate.d.mts for why these are hand-written. */

import type { DatabaseId } from "./generate.d.mts";
import type { PackageManagerId, RuntimeId } from "./toolchain.d.mts";

export type PlatformId = "local" | "docker" | "render" | "fly" | "railway" | "koyeb" | "cpanel";

export interface PlatformAnswers {
  platform: PlatformId;
  packageName: string;
  productName: string;
  database: DatabaseId;
  /** Decides the install and run commands every manifest embeds. */
  packageManager: PackageManagerId;
  /** Decides NODE_VERSION and, later, the base image and start command. */
  runtime: RuntimeId;
  cpanelUser?: string;
}

export interface Platform {
  id: PlatformId;
  title: string;
  description: string;
  cost: "always-free" | "trial-credit" | "self-hosted" | "your-own-host";
  persistence: "durable" | "ephemeral" | "local";
  files: (answers: PlatformAnswers) => Record<string, string>;
  keep: string[];
  steps: (answers: PlatformAnswers) => string[];
  notes: (answers: PlatformAnswers) => string[];
}

export const PLATFORMS: Platform[];
export const PLATFORM_PATHS: string[];
export const DEFAULT_PLATFORM: PlatformId;

export function isPlatform(value: unknown): value is PlatformId;
export function getPlatform(id: PlatformId | string): Platform;
export function platformFiles(answers: PlatformAnswers): Record<string, string>;
export function platformKeeps(answers: PlatformAnswers): string[];
export function platformSteps(answers: PlatformAnswers): string[];
export function platformNotes(answers: PlatformAnswers): string[];
export function platformSecrets(): string[];
