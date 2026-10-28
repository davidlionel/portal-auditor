import type { PropertyDef } from "@/lib/hubspot/properties";
import type { SearchRow } from "@/lib/hubspot/search";

export const DAY_MS = 24 * 60 * 60 * 1000;

// A fixed "now" so age-based tests don't depend on the clock.
export const NOW = Date.parse("2026-10-27T12:00:00Z");

export const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

// A described, custom, 90-day-old text property. Tests override only what
// they're about.
export function prop(overrides: Partial<PropertyDef> & { name: string }): PropertyDef {
  return {
    label: overrides.name,
    description: "Test property.",
    type: "string",
    fieldType: "text",
    hubspotDefined: false,
    calculated: false,
    hasFormula: false,
    externalOptions: false,
    archived: false,
    createdAt: daysAgo(90),
    options: [],
    ...overrides,
  };
}

// A custom dropdown with the given option labels.
export function dropdown(name: string, labels: string[], overrides: Partial<PropertyDef> = {}) {
  return prop({
    name,
    type: "enumeration",
    fieldType: "select",
    options: labels.map((label) => ({ label, value: label, hidden: false })),
    ...overrides,
  });
}

// A search result row with the given field values.
export function row(id: string, properties: Record<string, string | null>): SearchRow {
  return { id, properties };
}
