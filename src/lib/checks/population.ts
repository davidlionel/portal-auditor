import type { ObjectType } from "../hubspot/properties";
import { COUNT_CHECKS } from "./records/count-checks";
import type { Finding } from "./types";

const OBJECT_NOUNS: Record<ObjectType, [string, string]> = {
  contacts: ["contact", "contacts"],
  companies: ["company", "companies"],
  deals: ["deal", "deals"],
};

// Property checks measure custom properties; the dropdown checks only look
// at custom dropdowns.
const PROPERTY_NOUNS: Record<string, [string, string]> = {
  "properties.dropdown-variants": ["dropdown property", "dropdown properties"],
  "properties.dropdown-plural-variants": ["dropdown property", "dropdown properties"],
};

// What a check's population is called: "customers", "open deals",
// "properties", or the object's own name.
export function populationNoun(finding: Pick<Finding, "checkId" | "category" | "objectType" | "population">): string {
  const [singular, plural] =
    finding.category === "Properties"
      ? (PROPERTY_NOUNS[finding.checkId] ?? ["property", "properties"])
      : (COUNT_CHECKS.find((c) => c.checkId === finding.checkId)?.populationNoun ?? OBJECT_NOUNS[finding.objectType]);
  return finding.population === 1 ? singular : plural;
}

// "10 of 139 companies affected (7.2%)": the numbers behind a finding's score.
export function rateText(finding: Pick<Finding, "checkId" | "category" | "objectType" | "population" | "affected">): string {
  const rate = finding.population > 0 ? Math.min(1, finding.affected / finding.population) : 0;
  const shown = +(rate * 100).toFixed(rate < 0.01 ? 2 : 1);
  // A tiny but real rate shouldn't read as "0%".
  const pct = shown === 0 && finding.affected > 0 ? "<0.01%" : `${shown}%`;
  return `${finding.affected.toLocaleString("en-US")} of ${finding.population.toLocaleString("en-US")} ${populationNoun(finding)} affected (${pct})`;
}
