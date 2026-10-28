import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { isCustom, type ObjectType, type PropertyDef } from "@/lib/hubspot/properties";
import { normalizeLabel } from "@/lib/text";
import type { CheckMeta, Finding } from "../types";

export const DROPDOWN_VARIANTS: CheckMeta = {
  checkId: "properties.dropdown-variants",
  title: "Dropdown options that differ only by case, spacing or punctuation",
  severity: "high",
};

export const DROPDOWN_PLURAL_VARIANTS: CheckMeta = {
  checkId: "properties.dropdown-plural-variants",
  title: "Dropdown options that are singular and plural of each other",
  severity: "medium",
};

const isCheckable = (p: PropertyDef) => isCustom(p) && !p.externalOptions && p.options.length >= 2;

// Custom dropdowns with at least two options of their own.
export const dropdownPopulation = (props: PropertyDef[]) => props.filter(isCheckable).length;

// Ignores case, punctuation and all spacing, so "Trade Show" and "Tradeshow"
// compare equal.
const compact = (s: string) => normalizeLabel(s).replace(/ /g, "");

// True when one option is the plural of the other: Adhesive/Adhesives,
// Box/Boxes, Category/Categories. Plain edit distance flagged real
// different words (Japanese/Javanese, Dining/Mining), so this is the only
// "possible" rule.
function isPluralPair(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return (
    long === `${short}s` ||
    long === `${short}es` ||
    (short.endsWith("y") && long === `${short.slice(0, -1)}ies`)
  );
}

// Custom properties only: HubSpot-defined option lists (hs_language,
// hs_timezone and so on) aren't something admins can fix.
export function checkDropdownVariants(
  objectType: ObjectType,
  props: PropertyDef[],
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const definite: string[] = [];
  const possible: string[] = [];
  // Properties with at least one problem, for the rate.
  const definiteProps = new Set<string>();
  const possibleProps = new Set<string>();

  for (const p of props) {
    if (!isCheckable(p)) continue;

    // Definite: options identical once case, spacing and punctuation are ignored.
    const groups = new Map<string, string[]>();
    for (const o of p.options) {
      const key = compact(o.label);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), o.label]);
    }
    for (const labels of groups.values()) {
      if (labels.length > 1) {
        definite.push(`${p.name}: ${labels.join(" / ")}`);
        definiteProps.add(p.name);
      }
    }

    // Possible: singular/plural pairs of otherwise distinct options.
    const keys = [...groups.keys()];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (isPluralPair(keys[i], keys[j])) {
          possible.push(`${p.name}: ${groups.get(keys[i])![0]} / ${groups.get(keys[j])![0]}`);
          possibleProps.add(p.name);
        }
      }
    }
  }

  const findings: Finding[] = [];
  if (definite.length) {
    findings.push({
      ...DROPDOWN_VARIANTS,
      category: "Properties",
      objectType,
      count: definite.length,
      affected: definiteProps.size,
      population: dropdownPopulation(props),
      samples: definite.slice(0, config.sampleCap),
      items: definite.slice(0, config.records.workListCap),
      why: "Records split across variants like Webinar / webinar, so segments, workflows and reports miss some of them.",
      fix: "Keep one option, bulk-update records from the others to it, then delete the extra options.",
    });
  }
  if (possible.length) {
    findings.push({
      ...DROPDOWN_PLURAL_VARIANTS,
      category: "Properties",
      objectType,
      count: possible.length,
      affected: possibleProps.size,
      population: dropdownPopulation(props),
      samples: possible.slice(0, config.sampleCap),
      items: possible.slice(0, config.records.workListCap),
      why: "Singular and plural options usually mean the same value, so records split between them.",
      fix: "Review each pair; if they mean the same thing, merge records into one option and delete the other.",
    });
  }
  return findings;
}
