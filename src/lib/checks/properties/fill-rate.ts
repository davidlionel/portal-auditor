import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { isCustom, type ObjectType, type PropertyDef } from "@/lib/hubspot/properties";
import type { CheckMeta, Finding } from "../types";

export const nearZeroFill = (config: ChecksConfig = CHECKS_CONFIG): CheckMeta => ({
  checkId: "properties.near-zero-fill",
  title: `Custom properties filled on under ${(config.fillRate.nearZeroThreshold * 100).toString()}% of records`,
  severity: "medium",
});

// Only candidates whose fill count was actually measured.
export const fillRatePopulation = (candidates: PropertyDef[], filled: Map<string, number>) =>
  candidates.filter((p) => filled.has(p.name)).length;

const DAY_MS = 24 * 60 * 60 * 1000;

// Which custom properties are worth measuring. The scan only spends search
// calls on these.
export function fillRateCandidates(
  props: PropertyDef[],
  now = Date.now(),
  config: ChecksConfig = CHECKS_CONFIG,
): PropertyDef[] {
  const minAgeMs = config.fillRate.minAgeDays * DAY_MS;
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
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  if (totalRecords === 0) return [];

  const low = candidates
    .filter((p) => filled.has(p.name))
    .map((p) => ({ p, rate: filled.get(p.name)! / totalRecords }))
    .filter(({ rate }) => rate < config.fillRate.nearZeroThreshold)
    .sort((a, b) => a.rate - b.rate);
  if (!low.length) return [];

  return [
    {
      ...nearZeroFill(config),
      category: "Properties",
      objectType,
      count: low.length,
      affected: low.length,
      population: fillRatePopulation(candidates, filled),
      samples: low
        .slice(0, config.sampleCap)
        .map(({ p, rate }) => `${p.name} (${(rate * 100).toFixed(2)}%)`),
      why: "Unused fields clutter forms and records, and reports built on them show misleading blanks.",
      fix: "Confirm nobody relies on each one, then archive it or start populating it through a form or workflow.",
    },
  ];
}
