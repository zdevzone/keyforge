import { randomInt } from "node:crypto";

/**
 * The trial ledger's matching rules, as pure functions.
 *
 * A first-run installation reports hashed hardware identifiers — never the
 * identifiers themselves, which is why every one of them is a 64-hex SHA-256 by
 * the time it reaches here. The question this module answers is "have we seen
 * this machine before?", and it is deliberately conservative in both
 * directions: a false match costs a paying customer their trial, and a false
 * miss costs the vendor one trial's worth of nothing much.
 *
 * Kept free of database access so the rules can be tested as arithmetic.
 */

/** The identifiers the installer can collect. Anything else is ignored. */
export const SIGNAL_KINDS = [
  "machine-guid",
  "smbios-uuid",
  "volume-serial",
  "linux-machine-id",
  "macos-platform-uuid",
  "root-volume-uuid",
] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface MachineSignal {
  kind: SignalKind;
  hash: string;
}

/** Availability is relative to an OS's expected set, not an arbitrary count of kinds. */
export function signalAvailability(
  kinds: readonly string[],
): "Available" | "Partial" | "Unavailable" {
  const reported = new Set(kinds);
  const sets = [
    ["machine-guid", "smbios-uuid", "volume-serial"],
    ["linux-machine-id", "smbios-uuid", "root-volume-uuid"],
    ["macos-platform-uuid", "root-volume-uuid"],
  ];
  return sets.some((set) => set.every((kind) => reported.has(kind)))
    ? "Available"
    : kinds.length
      ? "Partial"
      : "Unavailable";
}

/**
 * How many distinct machines may share one hash before it stops counting as
 * evidence.
 *
 * Some identifiers are not identifying at all: a VM image cloned across a lab
 * carries one SMBIOS UUID, and some OEMs ship an entire production run with the
 * same machine GUID. Left in, one such hash fuses every install that has it
 * into a single "machine" and every one of them after the first is told its
 * trial is spent. Three is low enough to catch a bad identifier early and high
 * enough to survive an honest reinstall triple.
 */
export const MAX_GROUPS_PER_HASH = 3;

/** Distinct kinds that must agree before two registrations are one machine. */
export const MIN_MATCHING_KINDS = 2;

/** How much of the product a trial is worth. Zero once it is spent. */
export const TRIAL_ALLOWANCE = 20_000;

/** SHA-256, lowercase hex. Anything else did not come from our installer. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const KNOWN_KINDS = new Set<string>(SIGNAL_KINDS);

/**
 * Take the signals worth keeping out of whatever the client sent.
 *
 * Unknown kinds are dropped rather than rejected: the installer gains new
 * identifier sources over time, and an older server refusing a registration it
 * merely does not understand would break first run for everyone on the new
 * build. Malformed hashes go the same way — a signal that cannot match anything
 * is not worth a 400.
 */
export function normalizeSignals(raw: unknown): MachineSignal[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const signals: MachineSignal[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { kind, hash } = entry as { kind?: unknown; hash?: unknown };
    if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) continue;
    if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) continue;
    const key = `${kind}:${hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    signals.push({ kind: kind as SignalKind, hash });
  }
  return signals;
}

/**
 * The alphabet support references are drawn from.
 *
 * Same reasoning as product keys: a reference is read out over the phone by a
 * customer who is already annoyed, so no 0/O and no 1/I.
 */
const REFERENCE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * A short, human-quotable name for one machine group, e.g. `K7QX-2F`.
 *
 * Six characters is about 10^9 possibilities — collisions are handled by the
 * caller retrying against a UNIQUE constraint rather than by making the
 * reference longer than a person will read aloud correctly.
 */
export function newSupportReference(rand: (max: number) => number = randomInt): string {
  const pick = (count: number) =>
    Array.from({ length: count }, () => REFERENCE_ALPHABET[rand(REFERENCE_ALPHABET.length)]).join(
      "",
    );
  return `${pick(4)}-${pick(2)}`;
}

export interface MatchCandidate {
  groupId: string;
  /** Distinct signal kinds this group agrees with the request on. */
  matchingKinds: number;
  /** Tie-break: the older record wins, so the outcome does not depend on order. */
  firstRegisteredAt: string;
}

/**
 * Choose the machine a registration belongs to, or none.
 *
 * Scored by *distinct kinds* rather than raw hashes: three volume serials
 * agreeing is one disk imaged three times, not three pieces of evidence. Below
 * MIN_MATCHING_KINDS there is no match at all — one identifier is never enough.
 *
 * When two groups both clear the bar the best-scoring one wins and the groups
 * are left separate. Merging them would be the obvious move and it is the wrong
 * one: it is irreversible, it happens without an operator present, and a single
 * bad identifier could collapse a customer's whole estate into one machine.
 * /admin/machines shows both, and clearing either one is cheap.
 */
export function pickMatch(candidates: MatchCandidate[]): MatchCandidate | null {
  let best: MatchCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.matchingKinds < MIN_MATCHING_KINDS) continue;
    if (
      !best ||
      candidate.matchingKinds > best.matchingKinds ||
      (candidate.matchingKinds === best.matchingKinds &&
        candidate.firstRegisteredAt < best.firstRegisteredAt)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Whether a machine's trial is spent, from the group's state *before* this
 * registration is counted.
 *
 * A clear grants exactly one more trial: the registration immediately after it
 * is fresh, and the one after that is spent again. Which one is "immediately
 * after" is decided by the registration counter rather than by comparing a
 * clear's timestamp against the last registration's. Timestamps tie — support
 * clears a machine and the customer retries the same second — and a tie has to
 * resolve one way or the other, so a rule built on `>` silently swallows the
 * clear while `>=` silently grants an unlimited trial. The counter cannot tie
 * with itself.
 */
export function trialVerdict(
  group: { clearedAtCount: number | null; registrationCount: number } | null,
): "fresh" | "spent" {
  if (!group) return "fresh";
  if (group.clearedAtCount !== null && group.clearedAtCount === group.registrationCount) {
    return "fresh";
  }
  return "spent";
}
