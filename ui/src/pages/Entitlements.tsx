import { useQuery } from "@tanstack/react-query";

import {
  fetchAdminConfig,
  fetchEntitlementCatalog,
  type EntitlementUsage,
  type PlanPreset,
} from "../api";
import { Card, ErrorNote, Spinner } from "../components";

/**
 * What the ledger actually contains, as opposed to what anyone intended.
 *
 * Entitlements are free-form key/value pairs typed by hand on the issue form
 * and the license editor. Nothing rejects `seat` where every other license says
 * `seats`, and nothing rejects the string "12" where the rest hold the number
 * 12. Both are invisible per-license — a customer's app checks `seats`, finds
 * nothing, and quietly withholds what was paid for.
 *
 * This page is read-only on purpose: presets belong in keyforge.config.json,
 * where they are reviewable and survive a redeploy, and a bulk edit across
 * every customer's entitlements is not something to offer behind one click.
 */
export default function Entitlements() {
  const catalogQuery = useQuery({
    queryKey: ["entitlement-catalog"],
    queryFn: fetchEntitlementCatalog,
  });
  const { data: config } = useQuery({
    queryKey: ["admin-config"],
    queryFn: fetchAdminConfig,
    staleTime: Infinity,
  });

  if (catalogQuery.isPending) return <Spinner label="Reading the ledger" />;
  if (catalogQuery.isError) {
    return <ErrorNote message={(catalogQuery.error as Error).message} />;
  }

  const { catalog, licensesScanned } = catalogQuery.data;
  const presets = config?.licenses.planPresets ?? {};
  const suspects = findNearDuplicates(catalog.map((entry) => entry.name));
  const declared = new Set(
    Object.values(presets).flatMap((preset) => Object.keys(preset.entitlements ?? {})),
  );
  const inUse = new Set(catalog.map((entry) => entry.name));
  const undeclared = [...inUse].filter((name) => !declared.has(name)).sort();
  const unused = [...declared].filter((name) => !inUse.has(name)).sort();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Entitlements</h1>
        <p className="mt-1 text-sm text-slate-500">
          Every entitlement key across {licensesScanned.toLocaleString()}{" "}
          {licensesScanned === 1 ? "license" : "licenses"}, and the plan presets that seed them.
          Entitlements are free-form, so this is the only place a typo becomes visible.
        </p>
      </div>

      {(suspects.length > 0 || catalog.some(hasMixedTypes)) && (
        <Problems catalog={catalog} suspects={suspects} />
      )}

      <Card className="p-5">
        <h2 className="text-base font-semibold">Keys in use</h2>
        {catalog.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No license carries an entitlement yet. Add them when issuing, or set them as a plan
            preset in <code className="font-mono">keyforge.config.json</code>.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="pb-2 pr-4 font-medium">Key</th>
                  <th className="pb-2 pr-4 font-medium">Type</th>
                  <th className="pb-2 pr-4 font-medium">Licenses</th>
                  <th className="pb-2 pr-4 font-medium">Active</th>
                  <th className="pb-2 pr-4 font-medium">Values</th>
                  <th className="pb-2 font-medium">Plans</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((entry) => (
                  <tr key={entry.name} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-4 font-mono">{entry.name}</td>
                    <td className="py-2 pr-4">
                      {hasMixedTypes(entry) ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          {entry.types.join(" + ")}
                        </span>
                      ) : (
                        <span className="text-slate-500">{entry.types.join("") || "—"}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{entry.licenseCount}</td>
                    <td className="py-2 pr-4 tabular-nums text-slate-500">
                      {entry.activeLicenseCount}
                    </td>
                    <td className="py-2 pr-4 text-slate-500">
                      {entry.values.map((value) => `${value.value} (${value.count})`).join(", ")}
                      {entry.moreValues > 0 && ` +${entry.moreValues} more`}
                    </td>
                    <td className="py-2 text-slate-500">{entry.plans.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="text-base font-semibold">Plan presets</h2>
        <p className="mt-1 text-sm text-slate-500">
          What the issue form starts from. Presets are defaults, not enforcement — every value stays
          editable per license. Change them in{" "}
          <code className="font-mono">keyforge.config.json</code>; they apply at restart.
        </p>
        <div className="mt-3 space-y-3">
          {Object.entries(presets).map(([plan, preset]) => (
            <PresetRow
              key={plan}
              plan={plan}
              preset={preset}
              isDefault={plan === config?.licenses.defaultPlan}
            />
          ))}
          {Object.keys(presets).length === 0 && (
            <p className="text-sm text-slate-500">No plan presets are configured.</p>
          )}
        </div>
      </Card>

      {(undeclared.length > 0 || unused.length > 0) && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">Presets and reality</h2>
          <p className="mt-1 text-sm text-slate-500">
            Drift between what the presets declare and what licenses actually carry. Neither list is
            necessarily wrong — per-license additions are a normal thing to do.
          </p>
          {undeclared.length > 0 && (
            <div className="mt-3">
              <div className="text-xs uppercase tracking-wide text-slate-400">
                In use, declared by no preset
              </div>
              <div className="mt-1 font-mono text-sm">{undeclared.join(", ")}</div>
            </div>
          )}
          {unused.length > 0 && (
            <div className="mt-3">
              <div className="text-xs uppercase tracking-wide text-slate-400">
                Declared by a preset, on no license
              </div>
              <div className="mt-1 font-mono text-sm">{unused.join(", ")}</div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function PresetRow(props: { plan: string; preset: PlanPreset; isDefault: boolean }) {
  const entries = Object.entries(props.preset.entitlements ?? {});
  const extras = [
    props.preset.durationDays ? `expires after ${props.preset.durationDays} days` : null,
    props.preset.activationLimit ? `${props.preset.activationLimit} activations` : null,
  ].filter(Boolean);
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        <span className="font-medium">{props.plan}</span>
        {props.isDefault && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">default</span>
        )}
      </div>
      <div className="mt-1 font-mono text-sm text-slate-600">
        {entries.length > 0
          ? entries.map(([name, value]) => `${name}=${String(value)}`).join(" · ")
          : "no preset entitlements"}
      </div>
      {extras.length > 0 && <div className="mt-1 text-xs text-slate-500">{extras.join(" · ")}</div>}
    </div>
  );
}

/** The two problems this page exists to surface, stated plainly and up front. */
function Problems(props: { catalog: EntitlementUsage[]; suspects: string[][] }) {
  const mixed = props.catalog.filter(hasMixedTypes);
  return (
    <Card className="border-amber-200 bg-amber-50 p-5">
      <h2 className="text-base font-semibold text-amber-900">Worth a look</h2>
      {mixed.length > 0 && (
        <div className="mt-2">
          <div className="text-sm text-amber-900">
            <span className="font-medium">Mixed types.</span> The same key holds different types on
            different licenses. An app doing <code className="font-mono">typeof</code> or a numeric
            comparison will handle some and silently ignore the rest.
          </div>
          <ul className="mt-1 space-y-0.5 text-sm text-amber-800">
            {mixed.map((entry) => (
              <li key={entry.name}>
                <span className="font-mono">{entry.name}</span> — {entry.types.join(" and ")} across{" "}
                {entry.licenseCount} licenses
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.suspects.length > 0 && (
        <div className="mt-3">
          <div className="text-sm text-amber-900">
            <span className="font-medium">Near-duplicate keys.</span> These differ only in case,
            punctuation, or a character. If one is a typo, those licenses carry an entitlement
            nothing in your app reads.
          </div>
          <ul className="mt-1 space-y-0.5 text-sm text-amber-800">
            {props.suspects.map((group) => (
              <li key={group.join("|")} className="font-mono">
                {group.join("  ·  ")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function hasMixedTypes(entry: EntitlementUsage): boolean {
  return entry.types.length > 1;
}

/** Case, separators and pluralisation ignored — how these typos actually look. */
function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Group keys that are probably the same key typed two ways.
 *
 * Exact match after normalising catches `Seats`/`seats`/`seat_count`; an edit
 * distance of one catches `seats`/`seat`, which is the common one and which
 * normalising alone misses. Reported, never corrected — only the vendor knows
 * whether `seat` and `seats` are one concept or two.
 */
export function findNearDuplicates(names: string[]): string[][] {
  const groups: string[][] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < names.length; i += 1) {
    if (claimed.has(names[i])) continue;
    const group = [names[i]];
    for (let j = i + 1; j < names.length; j += 1) {
      if (claimed.has(names[j])) continue;
      const a = normalizeKey(names[i]);
      const b = normalizeKey(names[j]);
      if (a === b || withinOneEdit(a, b)) group.push(names[j]);
    }
    if (group.length > 1) {
      group.forEach((name) => claimed.add(name));
      groups.push(group);
    }
  }
  return groups;
}

/**
 * True when one insert, delete or substitution turns a into b.
 *
 * The two edit kinds are not equally suspicious, so they have different length
 * floors. An inserted or deleted character is usually a plural
 * (`seat`/`seats`) and is worth flagging even on short keys. A substitution on
 * a short key is usually two unrelated keys — `api` and `abi` are one edit
 * apart and have nothing to do with each other — so it takes a longer key
 * before that is evidence of anything.
 */
const MIN_LENGTH_FOR_INDEL = 3;
const MIN_LENGTH_FOR_SUBSTITUTION = 5;

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  const sameLength = a.length === b.length;
  const floor = sameLength ? MIN_LENGTH_FOR_SUBSTITUTION : MIN_LENGTH_FOR_INDEL;
  if (Math.min(a.length, b.length) < floor) return false;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let short = 0;
  let long = 0;
  let edited = false;
  while (short < shorter.length && long < longer.length) {
    if (shorter[short] === longer[long]) {
      short += 1;
      long += 1;
      continue;
    }
    if (edited) return false;
    edited = true;
    // Same length means a substitution; otherwise skip the extra character.
    if (shorter.length === longer.length) short += 1;
    long += 1;
  }
  return true;
}
