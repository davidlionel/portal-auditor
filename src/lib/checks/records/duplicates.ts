import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import type { SearchRow } from "@/lib/hubspot/search";
import { normalizeCompany, normalizeDomain, normalizeName } from "@/lib/text";
import { CATEGORY_FOR_OBJECT, type Finding } from "../types";

// Duplicates in a duplicate group shown per sample.
const MAX_IDS_PER_GROUP = 5;

export const DUPLICATE_TOOL_PATH = {
  contacts:
    "CRM > Contacts, then the ⋮ menu > Manage duplicates (or Data Management > Data Quality > Manage Duplicates)",
  companies:
    "CRM > Companies, then the ⋮ menu > Manage duplicates (or Data Management > Data Quality > Manage Duplicates)",
};

// Puts each row in a bucket by key and returns the buckets holding two or
// more rows. One pass over the rows; no pair-by-pair comparison. Rows with
// an empty key are skipped.
export function groupByKey(rows: SearchRow[], keyOf: (row: SearchRow) => string): string[][] {
  const buckets = new Map<string, string[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    buckets.set(key, [...(buckets.get(key) ?? []), row.id]);
  }
  return [...buckets.values()].filter((ids) => ids.length > 1);
}

const value = (row: SearchRow, name: string) => row.properties[name] ?? "";

// Same first name, last name and company name text. All three must be set.
export function contactNameKey(row: SearchRow): string {
  const first = normalizeName(value(row, "firstname"));
  const last = normalizeName(value(row, "lastname"));
  const company = normalizeCompany(value(row, "company"));
  return first && last && company ? `${first}|${last}|${company}` : "";
}

function duplicateFinding(
  base: Omit<Finding, "count" | "samples" | "recordSamples">,
  groups: string[][],
  config: ChecksConfig,
): Finding[] {
  if (!groups.length) return [];
  // Largest groups first: they're the worst offenders.
  const sorted = [...groups].sort((a, b) => b.length - a.length);
  return [
    {
      ...base,
      count: groups.length,
      samples: [],
      recordSamples: sorted
        .slice(0, config.sampleCap)
        .map((ids) => ids.slice(0, MAX_IDS_PER_GROUP)),
    },
  ];
}

export function checkDuplicateContacts(
  rows: SearchRow[],
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  return duplicateFinding(
    {
      checkId: "contacts.duplicate-name-company",
      title: "Likely duplicate contacts (same name and company)",
      category: CATEGORY_FOR_OBJECT.contacts,
      objectType: "contacts",
      severity: "high",
      why: "Duplicates split activity history between records, so owners miss context and reports double-count people.",
      fix: `Review and merge them in HubSpot's duplicate tool: ${DUPLICATE_TOOL_PATH.contacts}. Merges can't be undone, so check each pair first.`,
    },
    groupByKey(rows, contactNameKey),
    config,
  );
}

export function checkDuplicateDomains(
  rows: SearchRow[],
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  return duplicateFinding(
    {
      checkId: "companies.duplicate-domain",
      title: "Companies sharing the same domain",
      category: CATEGORY_FOR_OBJECT.companies,
      objectType: "companies",
      severity: "high",
      why: "Contacts and deals get split across copies of the same company, so account views and revenue roll-ups are incomplete.",
      fix: `Review and merge them in HubSpot's duplicate tool: ${DUPLICATE_TOOL_PATH.companies}. Merges can't be undone, so check each pair first.`,
    },
    groupByKey(rows, (row) => normalizeDomain(value(row, "domain"))),
    config,
  );
}
