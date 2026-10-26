import { CHECKS_CONFIG } from "@/config/checks";
import { isCustom, type ObjectType, type PropertyDef } from "@/lib/hubspot/properties";
import type { Finding } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

// Which custom properties are worth measuring. The scan only spends search
// calls on these.
export function fillRateCandidates(props: PropertyDef[], now = Date.now()): PropertyDef[] {
  const minAgeMs = CHECKS_CONFIG.fillRate.minAgeDays * DAY_MS;
  return props.filter((p) => {
    if (!isCustom(p) || p.calculated || p.hasFormula) return false;
    // Unknown creation date: measure it rather than silently skip.
    if (!p.createdAt) return true;
    return now - Date.parse(p.createdAt) >= minAgeMs;
  });
}

export function checkFillRate(
  objectType: ObjectType,
  candidates: PropertyDef[],
  filled: Map<string, number>,
  totalRecords: number,
): Finding[] {
  if (totalRecords === 0) return [];

  const low = candidates
    .filter((p) => filled.has(p.name))
    .map((p) => ({ p, rate: filled.get(p.name)! / totalRecords }))
    .filter(({ rate }) => rate < CHECKS_CONFIG.fillRate.nearZeroThreshold)
    .sort((a, b) => a.rate - b.rate);
  if (!low.length) return [];

  const pct = (CHECKS_CONFIG.fillRate.nearZeroThreshold * 100).toString();
  return [
    {
      checkId: "properties.near-zero-fill",
      title: `Custom properties filled on under ${pct}% of records`,
      category: "Properties",
      objectType,
      severity: "medium",
      count: low.length,
      samples: low
        .slice(0, CHECKS_CONFIG.sampleCap)
        .map(({ p, rate }) => `${p.name} (${(rate * 100).toFixed(2)}%)`),
      why: "Unused fields clutter forms and records, and reports built on them show misleading blanks.",
      fix: "Confirm nobody relies on each one, then archive it or start populating it through a form or workflow.",
    },
  ];
}
