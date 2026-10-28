import type { ObjectType } from "../hubspot/properties";
import type { Filter, FilterGroup } from "../hubspot/search";

// A deterministic fake HubSpot portal for the dev simulator and the scale
// test. Records are generated from their index on demand, so a 250,000-contact
// portal costs no memory. Index 0 is the most recently created record.

export type PortalSize = {
  records: Record<ObjectType, number>;
  customProperties: Record<ObjectType, number>;
};

export const SIZE_250K: PortalSize = {
  records: { contacts: 250_000, companies: 30_000, deals: 15_000 },
  customProperties: { contacts: 200, companies: 60, deals: 40 },
};

export const SIZE_SMALL: PortalSize = {
  records: { contacts: 900, companies: 120, deals: 60 },
  customProperties: { contacts: 12, companies: 6, deals: 4 },
};

type RawProperty = {
  name: string;
  label: string;
  description: string;
  type: string;
  fieldType: string;
  hubspotDefined: boolean;
  createdAt: string;
  options: { label: string; value: string; hidden: boolean }[];
  // Simulator-only: share of records that have a value.
  fill: number;
};

// Built-in properties the checks rely on.
const BUILT_IN: Record<ObjectType, string[]> = {
  contacts: ["firstname", "lastname", "company", "email", "lifecyclestage", "recent_deal_close_date", "createdate"],
  companies: ["domain", "num_associated_contacts", "createdate"],
  deals: ["amount", "closedate", "hs_is_closed", "hs_is_closed_won", "hs_v2_date_entered_current_stage", "createdate"],
};

// Planted record problems, as a share of the object's records. Each check's
// filter is recognized by the properties it uses.
const MATCH_RATES: { objectType: ObjectType; signature: string; rate: number }[] = [
  // Contacts
  { objectType: "contacts", signature: "lifecyclestage:NOT_HAS_PROPERTY", rate: 0.04 },
  { objectType: "contacts", signature: "lifecyclestage:EQ:customer&recent_deal_close_date:NOT_HAS_PROPERTY", rate: 0.0026 },
  { objectType: "contacts", signature: "lifecyclestage:EQ:customer", rate: 0.08 },
  { objectType: "contacts", signature: "email:NOT_HAS_PROPERTY", rate: 0.01 },
  // Companies
  { objectType: "companies", signature: "num_associated_contacts:EQ:0|num_associated_contacts:NOT_HAS_PROPERTY", rate: 0.15 },
  // Deals
  { objectType: "deals", signature: "amount:NOT_HAS_PROPERTY&hs_is_closed:EQ:false|amount:NOT_HAS_PROPERTY&hs_is_closed_won:EQ:true", rate: 0.06 },
  { objectType: "deals", signature: "hs_is_closed:EQ:false|hs_is_closed_won:EQ:true", rate: 0.63 },
  { objectType: "deals", signature: "closedate:NOT_HAS_PROPERTY&hs_is_closed:EQ:false", rate: 0.02 },
  { objectType: "deals", signature: "hs_is_closed:EQ:false", rate: 0.4 },
  { objectType: "deals", signature: "hs_is_closed:EQ:false&hs_v2_date_entered_current_stage:LT", rate: 0.14 },
];

// Filters as text, ignoring values that change every run (the stale-deal
// cutoff timestamp). Groups joined by |, filters by &.
export function filterSignature(groups: FilterGroup[]): string {
  const one = (f: Filter) =>
    f.operator === "LT" || f.operator === "GT" || f.value === undefined
      ? `${f.propertyName}:${f.operator}`
      : `${f.propertyName}:${f.operator}:${f.value}`;
  return groups.map((g) => g.filters.map(one).join("&")).join("|");
}

const DAY_MS = 24 * 60 * 60 * 1000;

function customProperty(objectType: ObjectType, i: number, now: number): RawProperty {
  const name = `sim_${objectType}_${i}`;
  // Every 50th label repeats the previous one: a duplicate label.
  const labelIndex = i % 50 === 7 ? i - 1 : i;
  const dropdown = i % 20 === 1;
  const options = dropdown
    ? ["Webinar", "Trade Show", "Referral", ...(i % 40 === 1 ? ["webinar"] : [])].map((label) => ({
        label,
        value: label,
        hidden: false,
      }))
    : [];
  return {
    name,
    label: `Sim ${objectType} field ${labelIndex}`,
    // One in five has no description.
    description: i % 5 === 0 ? "" : "Simulated property.",
    type: dropdown ? "enumeration" : "string",
    fieldType: dropdown ? "select" : "text",
    hubspotDefined: false,
    createdAt: new Date(now - 120 * DAY_MS).toISOString(),
    options,
    // One in ten is nearly empty.
    fill: i % 10 === 3 ? 0.002 : 0.35,
  };
}

export function createPortal(size: PortalSize = SIZE_250K, now = Date.now()) {
  const properties = Object.fromEntries(
    (Object.keys(size.records) as ObjectType[]).map((objectType) => [
      objectType,
      [
        ...BUILT_IN[objectType].map((name) => ({
          name,
          label: name,
          description: "HubSpot property.",
          type: "string",
          fieldType: "text",
          hubspotDefined: true,
          createdAt: new Date(now - 3000 * DAY_MS).toISOString(),
          options: [],
          fill: 0.9,
        })),
        ...Array.from({ length: size.customProperties[objectType] }, (_, i) => customProperty(objectType, i, now)),
      ],
    ]),
  ) as Record<ObjectType, RawProperty[]>;

  // How many records match a search's filters.
  function total(objectType: ObjectType, groups: FilterGroup[]): number {
    const records = size.records[objectType];
    if (!groups.length) return records;
    const signature = filterSignature(groups);
    // Fill-rate counts: one HAS_PROPERTY filter.
    const has = /^([\w]+):HAS_PROPERTY$/.exec(signature);
    if (has) {
      const prop = properties[objectType].find((p) => p.name === has[1]);
      return Math.round(records * (prop?.fill ?? 0));
    }
    const rule = MATCH_RATES.find((r) => r.objectType === objectType && r.signature === signature);
    return rule ? Math.round(records * rule.rate) : 0;
  }

  // Field values for the recent-records window. Planted: a duplicate pair
  // every 100 contacts, a typo email every 250, a 6-company group sharing a
  // domain, and a duplicate domain every 50 companies.
  function record(objectType: ObjectType, index: number): { id: string; properties: Record<string, string | null> } {
    const id = String(objectType === "contacts" ? 100_000_000 + index : objectType === "companies" ? 200_000_000 + index : 300_000_000 + index);
    if (objectType === "contacts") {
      const person = index % 100 === 50 ? index - 1 : index;
      return {
        id,
        properties: {
          firstname: `First${person}`,
          lastname: `Last${person}`,
          company: `Company ${person % 3000}`,
          email: index % 250 === 7 ? `person${index}@gmial.com` : `person${index}@example.com`,
        },
      };
    }
    if (objectType === "companies") {
      const domain =
        index < 6 ? "acmegrinding.example" : `company${index % 50 === 10 ? index - 1 : index}.example`;
      return { id, properties: { domain } };
    }
    return { id, properties: {} };
  }

  // IDs for records matching a check's filters, spread across the index range.
  function matchId(objectType: ObjectType, signature: string, i: number): string {
    let hash = 0;
    for (const ch of signature) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return String(400_000_000 + (hash % 1000) * 100_000 + i);
  }

  return { size, properties, total, record, matchId };
}

export type SimPortal = ReturnType<typeof createPortal>;
