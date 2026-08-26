/** Types for template.mjs — see generate.d.mts for why these are hand-written. */

export const DEFAULT_TEMPLATE: string;

export type Template =
  | { kind: "directory"; path: string; label: string }
  | { kind: "repository"; owner: string; repo: string; ref: string; label: string };

export function resolveTemplate(source?: string): Promise<Template>;
export function materializeTemplate(
  template: Template,
  destination: string,
  options?: { alsoPrune?: string[] },
): Promise<void>;
export function isEmptyDirectory(path: string): Promise<boolean>;
export function run(
  command: string,
  args: string[],
  options?: Record<string, unknown>,
): Promise<void>;
