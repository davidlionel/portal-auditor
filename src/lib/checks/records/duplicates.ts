import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { CompanyStore, matchCompanies } from "@/lib/dedupe/companies";
import { ContactStore, matchContacts } from "@/lib/dedupe/contacts";
import { TIERS, groupMatches, signalText, type Match, type Tier } from "@/lib/dedupe/match";
import type { SearchRow } from "@/lib/hubspot/search";
import { CATEGORY_FOR_OBJECT, type CheckMeta, type Finding, type WorkRecord } from "../types";

// Duplicates in a duplicate group shown per sample.
const MAX_IDS_PER_GROUP = 5;
// Signal combinations listed on a finding.
const SUMMARY_SIZE = 3;

export const DUPLICATE_TOOL_PATH = {
  contacts:
    "CRM > Contacts, then the three vertical dots icon > Manage duplicates (or Data Management > Data Quality > Manage Duplicates)",
  companies:
    "CRM > Companies, then the three vertical dots icon > Manage duplicates (or Data Management > Data Quality > Manage Duplicates)",
};

type DuplicateObject = "contacts" | "companies";

const TIER_TITLES: Record<Tier, (noun: string) => string> = {
  high: (noun) => `Likely duplicate ${noun} (high confidence)`,
  medium: (noun) => `Possible duplicate ${noun} (medium confidence)`,
  low: (noun) => `Possible duplicate ${noun} (low confidence)`,
};

// One check per object and tier. Only High is scored: Medium and Low are
// unconfirmed until someone who knows the records checks them.
export const duplicateMeta = (objectType: DuplicateObject, tier: Tier): CheckMeta => ({
  checkId: `${objectType}.duplicates-${tier}`,
  title: TIER_TITLES[tier](objectType),
  severity: tier,
  ...(tier !== "high" && { scored: false as const }),
});

export const DUPLICATE_METAS: Record<DuplicateObject, CheckMeta[]> = {
  contacts: TIERS.map((tier) => duplicateMeta("contacts", tier)),
  companies: TIERS.map((tier) => duplicateMeta("companies", tier)),
};

const WHY: Record<DuplicateObject, string> = {
  contacts: "Duplicates split activity history between records, so owners miss context and reports double-count people.",
  companies: "Contacts and deals get split across copies of the same company, so account views and revenue roll-ups are incomplete.",
};

function fixText(objectType: DuplicateObject, tier: Tier): string {
  if (tier === "high") {
    return `Review and merge them in HubSpot's duplicate tool (Professional and Enterprise plans): ${DUPLICATE_TOOL_PATH[objectType]}. Each group in the export says why it matched. Merges can't be undone, so check each pair first.`;
  }
  return `Not scored: these share some details but not enough to be sure. Ask each record's owner to confirm, then merge the real duplicates. Each group in the export says why it matched.`;
}

// Whole groups, largest first, numbered so the export keeps them together.
// Stops before a group that would pass the cap, unless it's the first.
function workList(groups: { ids: string[]; signals: string }[], cap: number): WorkRecord[] {
  const records: WorkRecord[] = [];
  for (const [i, { ids, signals }] of groups.entries()) {
    if (records.length && records.length + ids.length > cap) break;
    records.push(...ids.map((id) => ({ id, group: i + 1, signals })));
  }
  return records;
}

// Turns matched pairs into one finding per tier that found something.
export function duplicateFindings(
  objectType: DuplicateObject,
  matches: Match[],
  ids: string[],
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const groups = groupMatches(matches, config.duplicates.maxGroupSize);
  return TIERS.flatMap((tier) => {
    const inTier = groups
      .filter((g) => g.tier === tier)
      .map((g) => ({ ids: g.rows.map((row) => ids[row]), signals: signalText(g.signals), strength: g.signals.length }))
      // Largest groups first, then the ones with the most agreeing signals.
      .sort((a, b) => b.ids.length - a.ids.length || b.strength - a.strength);
    if (!inTier.length) return [];
    const combos = new Map<string, number>();
    for (const g of inTier) combos.set(g.signals, (combos.get(g.signals) ?? 0) + 1);
    return [
      {
        ...duplicateMeta(objectType, tier),
        category: CATEGORY_FOR_OBJECT[objectType],
        objectType,
        count: inTier.length,
        // Every record in a group needs review, so a group of six weighs more than a pair.
        affected: new Set(inTier.flatMap((g) => g.ids)).size,
        population: ids.length,
        samples: [],
        recordSamples: inTier.slice(0, config.sampleCap).map((g) => g.ids.slice(0, MAX_IDS_PER_GROUP)),
        records: workList(inTier, config.records.workListCap),
        matchSummary: [...combos]
          .sort((a, b) => b[1] - a[1])
          .slice(0, SUMMARY_SIZE)
          .map(([signals, count]) => ({ signals, groups: count })),
        why: WHY[objectType],
        fix: fixText(objectType, tier),
      },
    ];
  });
}

// For tests and small inputs: the whole contact check on raw rows.
export function checkDuplicateContacts(
  rows: SearchRow[],
  config: ChecksConfig = CHECKS_CONFIG,
  companyDomainOf?: (companyId: number) => number,
): Finding[] {
  const store = new ContactStore(new Set(config.duplicates.freeEmailDomains));
  for (const row of rows) store.add(row);
  return duplicateFindings("contacts", matchContacts(store, config, companyDomainOf).matches, store.ids, config);
}

export function checkDuplicateCompanies(rows: SearchRow[], config: ChecksConfig = CHECKS_CONFIG): Finding[] {
  const store = new CompanyStore();
  for (const row of rows) store.add(row);
  return duplicateFindings("companies", matchCompanies(store, config).matches, store.ids, config);
}
