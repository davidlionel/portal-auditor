import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { isCustom, type ObjectType, type PropertyDef } from "@/lib/hubspot/properties";
import type { CheckMeta, Finding } from "../types";

export const NO_DESCRIPTION: CheckMeta = {
  checkId: "properties.no-description",
  title: "Custom properties with no description",
  severity: "low",
};

// Every custom property is checked.
export const noDescriptionPopulation = (props: PropertyDef[]) => props.filter(isCustom).length;

export function checkNoDescription(
  objectType: ObjectType,
  props: PropertyDef[],
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const missing = props.filter((p) => isCustom(p) && !p.description.trim());
  if (!missing.length) return [];

  return [
    {
      ...NO_DESCRIPTION,
      category: "Properties",
      objectType,
      count: missing.length,
      affected: missing.length,
      population: noDescriptionPopulation(props),
      samples: missing.slice(0, config.sampleCap).map((p) => p.name),
      why: "Without a description, users guess what a field means and fill it inconsistently.",
      fix: "Add a one-line description to each property saying what it holds and who fills it.",
    },
  ];
}
