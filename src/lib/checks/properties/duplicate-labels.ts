import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { isCustom, type ObjectType, type PropertyDef } from "@/lib/hubspot/properties";
import { differOnlyInDigits, levenshtein, normalizeLabel } from "@/lib/text";
import type { Finding } from "../types";

const describe = (p: PropertyDef) => `${p.name} ("${p.label}")`;

export function checkDuplicateLabels(
  objectType: ObjectType,
  props: PropertyDef[],
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const live = props.filter((p) => !p.archived);
  const { nearMinLength, nearMaxDistance } = config.duplicateLabels;

  // Exact duplicates: same label once case, spacing and punctuation are ignored.
  const byNormalized = new Map<string, PropertyDef[]>();
  for (const p of live) {
    const key = normalizeLabel(p.label);
    byNormalized.set(key, [...(byNormalized.get(key) ?? []), p]);
  }
  const exactGroups = [...byNormalized.values()].filter(
    (group) => group.length > 1 && group.some(isCustom),
  );

  // Near duplicates: labels a couple of typos apart, excluding exact matches.
  const nearPairs: [PropertyDef, PropertyDef][] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (!isCustom(a) && !isCustom(b)) continue;
      const na = normalizeLabel(a.label);
      const nb = normalizeLabel(b.label);
      if (na === nb || Math.min(na.length, nb.length) < nearMinLength) continue;
      if (Math.abs(na.length - nb.length) > nearMaxDistance) continue;
      if (differOnlyInDigits(na, nb)) continue;
      if (levenshtein(na, nb) <= nearMaxDistance) nearPairs.push([a, b]);
    }
  }

  const findings: Finding[] = [];
  if (exactGroups.length) {
    findings.push({
      checkId: "properties.duplicate-labels",
      title: "Properties with the same label",
      category: "Properties",
      objectType,
      severity: "medium",
      count: exactGroups.length,
      samples: exactGroups
        .slice(0, config.sampleCap)
        .map((group) => group.map(describe).join(" / ")),
      why: "Users can't tell which field to use, so data splits across both and reports undercount.",
      fix: "Pick one property to keep, migrate values from the other, then archive the duplicate.",
    });
  }
  if (nearPairs.length) {
    findings.push({
      checkId: "properties.near-duplicate-labels",
      title: "Properties with near-identical labels",
      category: "Properties",
      objectType,
      severity: "medium",
      count: nearPairs.length,
      samples: nearPairs
        .slice(0, config.sampleCap)
        .map(([a, b]) => `${describe(a)} / ${describe(b)}`),
      why: "Labels a typo apart are usually the same field created twice, which splits data between them.",
      fix: "Check whether each pair means the same thing; if so, merge into one property and archive the other.",
    });
  }
  return findings;
}
