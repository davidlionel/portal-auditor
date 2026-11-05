import type { ObjectType } from "../hubspot/properties";
import type { Filter, FilterGroup } from "../hubspot/search";

// A deterministic fake HubSpot portal for the dev simulator and the scale
// test. Records are generated from their index on demand, so a 250,000-contact
// portal costs no memory. Index 0 is the most recently created record.

export type PortalSize = {
  records: Record<ObjectType, number>;
  customProperties: Record<ObjectType, number>;
  segments: number;
};

export const SIZE_250K: PortalSize = {
  records: { contacts: 250_000, companies: 30_000, deals: 15_000 },
  customProperties: { contacts: 200, companies: 60, deals: 40 },
  segments: 500,
};

// For the full duplicate scan: half a million and a million contacts.
export const SIZE_500K: PortalSize = {
  records: { contacts: 500_000, companies: 60_000, deals: 30_000 },
  customProperties: SIZE_250K.customProperties,
  segments: 500,
};

export const SIZE_1M: PortalSize = {
  records: { contacts: 1_000_000, companies: 120_000, deals: 60_000 },
  customProperties: SIZE_250K.customProperties,
  segments: 500,
};

// Record IDs: the base plus the record's index, so ascending ID order is
// index order. Index 0 is the most recently created.
export const ID_BASE: Record<ObjectType, number> = { contacts: 100_000_000, companies: 200_000_000, deals: 300_000_000 };

export const SIZE_SMALL: PortalSize = {
  records: { contacts: 900, companies: 120, deals: 60 },
  customProperties: { contacts: 12, companies: 6, deals: 4 },
  segments: 60,
};

// Properties the simulated segments filter on that aren't in the property
// lists: one archived, one deleted, and one sensitive property whose lookup
// HubSpot refuses (403).
export const SIM_ARCHIVED_PROPERTY = "sim_archived_source";
export const SIM_DELETED_PROPERTY = "sim_deleted_region";
export const SIM_SENSITIVE_PROPERTY = "sim_sensitive_notes";

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
  contacts: [
    "firstname", "lastname", "company", "email", "phone", "mobilephone", "associatedcompanyid",
    "lifecyclestage", "recent_deal_close_date", "createdate",
  ],
  companies: [
    "domain", "name", "hs_additional_domains", "city", "state", "country", "zip", "num_associated_contacts", "createdate",
  ],
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

  // Field values for the recent-records window, with planted duplicates of
  // every tier and the cases that must not match. See contactRecord and
  // companyRecord.
  function record(objectType: ObjectType, index: number): { id: string; properties: Record<string, string | null> } {
    const id = String(ID_BASE[objectType] + index);
    if (objectType === "contacts") return { id, properties: contactRecord(index) };
    if (objectType === "companies") return { id, properties: companyRecord(index) };
    return { id, properties: {} };
  }

  // IDs for records matching a check's filters, spread across the index range.
  function matchId(objectType: ObjectType, signature: string, i: number): string {
    let hash = 0;
    for (const ch of signature) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return String(400_000_000 + (hash % 1000) * 100_000 + i);
  }

  return { size, properties, total, record, matchId, segment: (index: number) => simSegment(index, size, now) };
}

export type SimPortal = ReturnType<typeof createPortal>;

// One segment, by index (its ID is 1,000 + index). Even indexes are active
// (DYNAMIC) and filter on a custom contact property plus an associated
// company's domain; odd ones are static. Planted, by index:
//   %25 = 0     created 5 days ago and empty: too young to report (no match)
//   %20 = 3     static and empty, created long ago (empty)
//   %40 = 18    active and empty, created long ago (empty)
//   %50 = 11    the one before's name in other case with "!" (duplicate name)
//   %100 = 4    filters on an archived property (missing property)
//   %100 = 6    filters on a deleted property (missing property)
//   %100 = 8    filters on a sensitive property the key can't look up (no match)
//   %100 = 10   also has an event filter, which isn't checked
// Names carry their index, so "Sim segment 12" and "Sim segment 13" are a
// numbered series, not duplicates.
function simSegment(index: number, size: PortalSize, now: number) {
  const active = index % 2 === 0;
  const young = index % 25 === 0;
  const name = index % 50 === 11 ? `SIM SEGMENT ${index - 1}!` : `Sim segment ${index}`;
  const customs = Math.max(1, size.customProperties.contacts);
  const property =
    index % 100 === 4
      ? SIM_ARCHIVED_PROPERTY
      : index % 100 === 6
        ? SIM_DELETED_PROPERTY
        : index % 100 === 8
          ? SIM_SENSITIVE_PROPERTY
          : `sim_contacts_${index % customs}`;
  const propertyFilter = (name: string) => ({
    filterType: "PROPERTY",
    property: name,
    operation: { operationType: "ALL_PROPERTY", operator: "IS_KNOWN" },
  });
  const branches = [
    { filterBranchType: "ASSOCIATION", objectTypeId: "0-2", operator: "IN_LIST", associationTypeId: 279, filterBranches: [], filters: [propertyFilter("domain")] },
    ...(index % 100 === 10
      ? [{ filterBranchType: "UNIFIED_EVENTS", eventTypeId: "0-1", operator: "HAS_COMPLETED", filterBranches: [], filters: [propertyFilter("hs_url")] }]
      : []),
  ];
  return {
    listId: String(1_000 + index),
    name,
    objectTypeId: "0-1",
    processingType: active ? "DYNAMIC" : "MANUAL",
    processingStatus: "COMPLETE",
    createdAt: new Date(now - (young ? 5 : 200) * DAY_MS).toISOString(),
    size: young || index % 20 === 3 || index % 40 === 18 ? 0 : 40 + (index % 7) * 13,
    filterBranch: active
      ? {
          filterBranchType: "OR",
          filters: [],
          filterBranches: [{ filterBranchType: "AND", filters: [propertyFilter(property)], filterBranches: branches }],
        }
      : undefined,
  };
}

// A name made of letters only, different for every n, so two simulated
// people's names are never one typo apart by accident.
function letters(n: number, length = 7): string {
  let x = (n + 1) * 2654435761;
  let out = "";
  for (let i = 0; i < length; i++) {
    x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0;
    out += String.fromCharCode(97 + (x % 26));
  }
  return out[0].toUpperCase() + out.slice(1);
}

const phone = (n: number) => `+1 (555) ${String(1_000_000 + n).slice(-7, -4)}-${String(n).padStart(4, "0").slice(-4)}`;

// One contact's fields. Everyone has their own phone and company (about
// three contacts per company); all share example.com, which is too large an
// organization to count on its own. Planted, by index:
//   %100 = 50   the same person as the one before: exact name + company (High)
//   %200 = 120  "Bob" for the one before's "Robert", same phone (High)
//   %200 = 160  "Micheal" for "Michael", same phone and company (Medium)
//   %300 = 210  no name, the one before's phone and company (Medium)
//   %500 = 333  last name only, the one before's phone, other company (Low)
//   %1000 = 700 the one before's sibling: same last name and home phone (no match)
//   0-19        twenty colleagues on one switchboard number (no match)
//   %250 = 7    a typo email domain
//   %20000 = 13000  the same person as contact index - 12,000 (High), which
//               only a full duplicate scan sees: it's outside the newest 10,000
function contactRecord(index: number): Record<string, string | null> {
  const before = index - 1;
  const base = (n: number) => ({
    firstname: letters(n),
    lastname: letters(n + 1_000_000, 8),
    company: `Company ${n % 3000}`,
    email: `person${index}@example.com`,
    phone: phone(n),
    mobilephone: null as string | null,
    associatedcompanyid: String(200_000_000 + (n % 3000)),
  });
  const p = base(index);
  if (index % 250 === 7) p.email = `person${index}@gmial.com`;
  if (index < 20) return { ...p, phone: "+1 800 555 0100", company: "Switchboard Corp", associatedcompanyid: null };
  if (index % 100 === 50) return { ...base(before), email: p.email };
  if (index % 200 === 119) return { ...p, firstname: "Robert" };
  if (index % 200 === 120) return { ...base(before), firstname: "Bob", email: p.email };
  if (index % 200 === 159) return { ...p, firstname: "Michael" };
  if (index % 200 === 160) return { ...base(before), firstname: "Micheal", email: p.email };
  if (index % 300 === 210) return { ...base(before), firstname: null, lastname: null, email: p.email, associatedcompanyid: null };
  if (index % 500 === 333) return { ...p, firstname: null, lastname: base(before).lastname, phone: phone(before), associatedcompanyid: null };
  if (index % 1000 === 700) return { ...p, lastname: base(before).lastname, phone: phone(before), associatedcompanyid: null };
  if (index % 20_000 === 13_000) return { ...base(index - 12_000), email: p.email };
  return p;
}

// One company's fields. Planted, by index:
//   0-5         six companies sharing a domain (High)
//   %50 = 10    the one before's domain (High)
//   %500 = 400  the one before's domain as an additional domain (High)
//   %100 = 30   a subdomain of the one before's domain (Medium)
//   %100 = 70   no domain, the one before's name and city (Medium)
//   %250 = 90   no domain or city, the one before's name and state (Low)
//   %10000 = 9920, from 10,000 on: company index - 9,800's domain (High),
//               which only a full duplicate scan sees
function companyRecord(index: number): Record<string, string | null> {
  const before = index - 1;
  const own = {
    domain: `company${index}.example`,
    name: `Company ${index}`,
    hs_additional_domains: null as string | null,
    city: `City ${index % 400}`,
    state: `State ${index % 50}`,
    country: "United States",
    // Letters keep simulated postal codes from looking like part of a record ID.
    zip: `SIM ${index % 80_000}`,
  };
  if (index < 6) return { ...own, domain: "acmegrinding.example" };
  if (index % 50 === 10) return { ...own, domain: `company${before}.example` };
  if (index % 500 === 400) return { ...own, domain: `alt${index}.example`, hs_additional_domains: `company${before}.example` };
  if (index % 100 === 30) return { ...own, domain: `eu.company${before}.example` };
  if (index % 100 === 70) return { ...own, domain: null, name: `Company ${before}`, city: `City ${before % 400}`, state: `State ${before % 50}`, zip: null };
  if (index % 250 === 90) return { ...own, domain: null, name: `Company ${before}`, city: null, zip: null, state: `State ${before % 50}` };
  if (index >= 10_000 && index % 10_000 === 9_920) return { ...own, domain: `company${index - 9_800}.example` };
  return own;
}
