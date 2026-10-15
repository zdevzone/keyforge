/** Same human-readable units accepted by the deployment rate-limit policy. */
export function durationMs(value: string): number {
  const match =
    /^\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|w|weeks?)\s*$/i.exec(
      value,
    );
  if (!match) return NaN;
  const unit = match[2].toLowerCase();
  const scale =
    unit.startsWith("ms") || unit.startsWith("millisecond")
      ? 1
      : unit.startsWith("s")
        ? 1000
        : unit.startsWith("m")
          ? 60000
          : unit.startsWith("h")
            ? 3600000
            : unit.startsWith("d")
              ? 86400000
              : 604800000;
  return Number(match[1]) * scale;
}
