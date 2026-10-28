import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import type { ObjectType } from "@/lib/hubspot/properties";
import type { FilterGroup } from "@/lib/hubspot/search";
import { CATEGORY_FOR_OBJECT, type CheckMeta, type Finding, type Severity } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;

// A record check answered by Search: `total` is the count, the first results
// are the samples, and paging up to the work-list cap gives the export IDs.
export type CountCheck = {
  checkId: string;
  objectType: ObjectType;
  // A function when the title names a configured threshold.
  title: string | ((config: ChecksConfig) => string);
  severity: Severity;
  // Every property the filter uses. The scan skips the check, with a note,
  // when the portal doesn't have one of them.
  requiredProps: string[];
  filterGroups: (now: number, config: ChecksConfig) => FilterGroup[];
  // The records the rate is measured against, when that's narrower than all
  // records of the object (Customers, open deals). One more Search total.
  populationFilterGroups?: () => FilterGroup[];
  // What that narrower population is called, singular and plural, for "35 of
  // 66 customers affected". Without it, the object's own name is used.
  populationNoun?: [string, string];
  why: string;
  fix: string;
};

const missing = (propertyName: string) => ({ propertyName, operator: "NOT_HAS_PROPERTY" });
const eq = (propertyName: string, value: string) => ({ propertyName, operator: "EQ", value });

const openDeals = () => [{ filters: [eq("hs_is_closed", "false")] }];

export const COUNT_CHECKS: CountCheck[] = [
  {
    checkId: "contacts.missing-lifecycle-stage",
    objectType: "contacts",
    title: "Contacts with no lifecycle stage",
    severity: "medium",
    requiredProps: ["lifecyclestage"],
    filterGroups: () => [{ filters: [missing("lifecyclestage")] }],
    why: "Contacts without a stage drop out of funnel reports and stage-based workflows.",
    fix: "Set a default stage on forms and imports, then bulk-update these contacts to the right stage.",
  },
  {
    checkId: "contacts.customer-without-won-deal",
    objectType: "contacts",
    title: "Customers with no closed-won deal",
    severity: "medium",
    requiredProps: ["lifecyclestage", "recent_deal_close_date"],
    filterGroups: () => [
      { filters: [eq("lifecyclestage", "customer"), missing("recent_deal_close_date")] },
    ],
    populationFilterGroups: () => [{ filters: [eq("lifecyclestage", "customer")] }],
    populationNoun: ["customer", "customers"],
    why: "Customer counts and revenue attribution disagree when contacts are Customers with no won deal behind them.",
    fix: "Check each contact: associate the won deal (a deal on the company alone doesn't count here), or move the contact back to the right stage.",
  },
  {
    checkId: "contacts.missing-email",
    objectType: "contacts",
    title: "Contacts with no email address",
    severity: "medium",
    requiredProps: ["email"],
    filterGroups: () => [{ filters: [missing("email")] }],
    why: "Contacts without an email can't be emailed, and HubSpot can't dedupe them by email.",
    fix: "Find the email from the source system or the owner, or archive contacts nobody can reach.",
  },
  {
    checkId: "companies.no-contacts",
    objectType: "companies",
    title: "Companies with no associated contacts",
    severity: "low",
    requiredProps: ["num_associated_contacts"],
    filterGroups: () => [
      { filters: [eq("num_associated_contacts", "0")] },
      { filters: [missing("num_associated_contacts")] },
    ],
    why: "Empty companies inflate account counts and usually mean contacts were never linked to them.",
    fix: "Turn on automatic company association by email domain, associate the right contacts, or archive the empty companies.",
  },
  {
    checkId: "deals.missing-amount",
    objectType: "deals",
    title: "Open or won deals with no amount",
    severity: "high",
    requiredProps: ["amount", "hs_is_closed", "hs_is_closed_won"],
    filterGroups: () => [
      { filters: [missing("amount"), eq("hs_is_closed", "false")] },
      { filters: [missing("amount"), eq("hs_is_closed_won", "true")] },
    ],
    populationFilterGroups: () => [
      { filters: [eq("hs_is_closed", "false")] },
      { filters: [eq("hs_is_closed_won", "true")] },
    ],
    populationNoun: ["open or won deal", "open or won deals"],
    why: "Deals without an amount count as zero in the forecast and revenue reports.",
    fix: "Make Amount required at the deal stages where it's known, then fill it in on these deals.",
  },
  {
    checkId: "deals.missing-close-date",
    objectType: "deals",
    title: "Open deals with no close date",
    severity: "medium",
    requiredProps: ["closedate", "hs_is_closed"],
    filterGroups: () => [{ filters: [missing("closedate"), eq("hs_is_closed", "false")] }],
    populationFilterGroups: openDeals,
    populationNoun: ["open deal", "open deals"],
    why: "Deals without a close date fall out of every forecast period.",
    fix: "Make Close date required when a deal is created, then set an expected date on these deals.",
  },
  {
    checkId: "deals.stale",
    objectType: "deals",
    title: (config) => `Open deals with no stage change in ${config.records.staleDealDays}+ days`,
    severity: "medium",
    requiredProps: ["hs_is_closed", "hs_v2_date_entered_current_stage"],
    filterGroups: (now, config) => [
      {
        filters: [
          eq("hs_is_closed", "false"),
          {
            propertyName: "hs_v2_date_entered_current_stage",
            operator: "LT",
            value: String(now - config.records.staleDealDays * DAY_MS),
          },
        ],
      },
    ],
    populationFilterGroups: openDeals,
    populationNoun: ["open deal", "open deals"],
    why: "Deals stuck in one stage make the pipeline look bigger than it is.",
    fix: "Review each deal with its owner: move it forward, close it as lost, or update the close date.",
  },
];

export function countCheckTitle(check: CountCheck, config: ChecksConfig = CHECKS_CONFIG): string {
  return typeof check.title === "function" ? check.title(config) : check.title;
}

export function countCheckMeta(check: CountCheck, config: ChecksConfig = CHECKS_CONFIG): CheckMeta {
  return { checkId: check.checkId, title: countCheckTitle(check, config), severity: check.severity };
}

// `total` matched the filter; `ids` are the first of them (up to the
// work-list cap); `population` is what the rate is measured against.
export function countFinding(
  check: CountCheck,
  result: { total: number; population: number; ids: string[] },
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const { total, population, ids } = result;
  if (total === 0) return [];
  return [
    {
      ...countCheckMeta(check, config),
      category: CATEGORY_FOR_OBJECT[check.objectType],
      objectType: check.objectType,
      count: total,
      affected: total,
      population,
      samples: [],
      recordSamples: ids.slice(0, config.sampleCap).map((id) => [id]),
      records: ids.slice(0, config.records.workListCap).map((id) => ({ id })),
      why: check.why,
      fix: check.fix,
    },
  ];
}
