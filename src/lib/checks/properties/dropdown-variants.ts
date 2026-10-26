import { CHECKS_CONFIG } from "@/config/checks";
import { isCustom, type ObjectType, type PropertyDef } from "@/lib/hubspot/properties";
import { normalizeLabel } from "@/lib/text";
import type { Finding } from "../types";

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
export function checkDropdownVariants(objectType: ObjectType, props: PropertyDef[]): Finding[] {
  const definite: string[] = [];
  const possible: string[] = [];

  for (const p of props) {
    if (!isCustom(p) || p.externalOptions || p.options.length < 2) continue;

    // Definite: options identical once case, spacing and punctuation are ignored.
    const groups = new Map<string, string[]>();
    for (const o of p.options) {
      const key = compact(o.label);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), o.label]);
    }
    for (const labels of groups.values()) {
      if (labels.length > 1) definite.push(`${p.name}: ${labels.join(" / ")}`);
    }

    // Possible: singular/plural pairs of otherwise distinct options.
    const keys = [...groups.keys()];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        if (isPluralPair(keys[i], keys[j])) {
          possible.push(`${p.name}: ${groups.get(keys[i])![0]} / ${groups.get(keys[j])![0]}`);
        }
      }
    }
  }

  const findings: Finding[] = [];
  if (definite.length) {
    findings.push({
      checkId: "properties.dropdown-variants",
      title: "Dropdown options that differ only by case, spacing or punctuation",
      category: "Properties",
      objectType,
      severity: "high",
      count: definite.length,
      samples: definite.slice(0, CHECKS_CONFIG.sampleCap),
      why: "Records split across variants like Webinar / webinar, so segments, workflows and reports miss some of them.",
      fix: "Keep one option, bulk-update records from the others to it, then delete the extra options.",
    });
  }
  if (possible.length) {
    findings.push({
      checkId: "properties.dropdown-plural-variants",
      title: "Dropdown options that are singular and plural of each other",
      category: "Properties",
      objectType,
      severity: "medium",
      count: possible.length,
      samples: possible.slice(0, CHECKS_CONFIG.sampleCap),
      why: "Singular and plural options usually mean the same value, so records split between them.",
      fix: "Review each pair; if they mean the same thing, merge records into one option and delete the other.",
    });
  }
  return findings;
}
