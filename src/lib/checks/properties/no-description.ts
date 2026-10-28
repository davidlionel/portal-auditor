import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { isCustom, type ObjectType, type PropertyDef } from "@/lib/hubspot/properties";
import type { Finding } from "../types";

export function checkNoDescription(
  objectType: ObjectType,
  props: PropertyDef[],
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const missing = props.filter((p) => isCustom(p) && !p.description.trim());
  if (!missing.length) return [];

  return [
    {
      checkId: "properties.no-description",
      title: "Custom properties with no description",
      category: "Properties",
      objectType,
      severity: "low",
      count: missing.length,
      samples: missing.slice(0, config.sampleCap).map((p) => p.name),
      why: "Without a description, users guess what a field means and fill it inconsistently.",
      fix: "Add a one-line description to each property saying what it holds and who fills it.",
    },
  ];
}
