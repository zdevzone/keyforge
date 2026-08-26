/**
 * Types for generate.mjs. Hand-written rather than generated: the scaffolder
 * ships as plain ESM with no build step, and these let the server's TypeScript
 * test suite check the generated config against the real config schema.
 */

import type { PlatformAnswers } from "./platforms.d.mts";
import type { PackageManagerId, RuntimeId } from "./toolchain.d.mts";

export type DatabaseId = "sqlite" | "postgres";
export type UseCaseId = "count" | "time" | "features" | "blank";
export type AdminFeature = "operators" | "sessions" | "bans" | "impersonation";
export type AuthScope = "core" | "full" | string[];

export interface Choice<Id extends string> {
  id: Id;
  title: string;
  description: string;
}

export const ADMIN_FEATURES: AdminFeature[];
export const DATABASES: Choice<DatabaseId>[];
export const AUTH_SCOPES: Choice<"core" | "full">[];
export const USE_CASES: Choice<UseCaseId>[];

export function isUseCase(value: unknown): value is UseCaseId;
export function isDatabase(value: unknown): value is DatabaseId;
export function parseAuthScope(value: unknown): AuthScope;
export function toPackageName(directoryName: string): string;
export function toProductName(directoryName: string): string;
export function toKeyPrefix(productName: string): string;

export interface ConfigAnswers {
  productName: string;
  keyPrefix: string;
  useCase: UseCaseId;
  authScope: AuthScope;
}

export function buildConfig(answers: ConfigAnswers): Record<string, unknown>;

export interface EnvAnswers {
  productName: string;
  database: DatabaseId;
  /** Only for the "generate the key with …" comment; no secret depends on it. */
  packageManager: PackageManagerId;
  adminToken: string;
  authSecret: string;
}

export function buildEnvLocal(answers: EnvAnswers): string;
export function buildEnvExample(answers: Omit<EnvAnswers, "adminToken" | "authSecret">): string;

export function buildPackageJson(
  templatePackageJson: Record<string, unknown>,
  answers: {
    packageName: string;
    productName: string;
    packageManager: PackageManagerId;
    runtime: RuntimeId;
  },
): Record<string, unknown>;

/** Rewrites template scripts that shell out to npm by name. */
export function retargetScripts(
  scripts: Record<string, string> | undefined,
  packageManager: PackageManagerId,
): Record<string, string> | undefined;

/** Rewrites npm invocations inside any text (scripts, CI workflow). */
export function retargetNpmCommands(text: string, packageManager: PackageManagerId): string;

/** Rewrites the GitHub Actions workflow, and installs the manager on the runner. */
export function retargetWorkflow(contents: string, packageManager: PackageManagerId): string;

/** Rewrites the copied Dockerfile's install lines; throws if they moved. */
export function retargetDockerfileContents(
  contents: string,
  packageManagerOrAnswers: PackageManagerId | { packageManager: PackageManagerId },
): string;

export function nextSteps(
  answers: PlatformAnswers & { relativeDirectory: string; installed: boolean },
): string[];

export function buildReadme(answers: ConfigAnswers & PlatformAnswers): string;
