import type { ChecksConfig } from "@/config/checks";
import type { SearchRow } from "@/lib/hubspot/search";
import { companyNameKey, deletionVariants, emailDomain, hashKey, isNickname, nicknameGroups, oneTypoApart, personNameKey, phoneKey } from "./keys";
import { Column, KeyList, MatchSet, capTier, compareBlock, type Match, type Signal, type Tier } from "./match";

// Contact fields the duplicate check reads. associatedcompanyid isn't in
// HubSpot's current docs, so it's only requested when the portal's
// property list has it.
export const CONTACT_MATCH_PROPERTIES = ["firstname", "lastname", "company", "email"];
export const CONTACT_OPTIONAL_PROPERTIES = ["phone", "mobilephone", "associatedcompanyid"];

// The minimum each contact needs for matching: normalized first and last
// name, and hashes of the rest. Built page by page as records arrive; the
// raw values are dropped with the page.
export class ContactStore {
  readonly ids: string[] = [];
  readonly first: string[] = [];
  readonly last: string[] = [];
  readonly phone1 = new Column();
  readonly phone2 = new Column();
  readonly emailDomain = new Column();
  readonly company = new Column();
  readonly companyId = new Column();

  constructor(private freeDomains: Set<string>) {}

  get size() {
    return this.ids.length;
  }

  add(row: SearchRow) {
    const p = row.properties;
    const domain = emailDomain(p.email);
    this.ids.push(row.id);
    this.first.push(personNameKey(p.firstname));
    this.last.push(personNameKey(p.lastname));
    this.phone1.push(hashKey(phoneKey(p.phone)));
    this.phone2.push(hashKey(phoneKey(p.mobilephone)));
    this.emailDomain.push(this.freeDomains.has(domain) ? 0 : hashKey(domain));
    this.company.push(hashKey(companyNameKey(p.company)));
    this.companyId.push(Number(p.associatedcompanyid) || 0);
  }
}

export type NameAgreement = "exact" | "nickname" | "typo" | "partial" | "unknown" | "conflict";

type Part = "same" | "nickname" | "typo" | "initial" | "missing" | "differ";

function comparePart(a: string, b: string, typoMinLength: number, first: boolean): Part {
  if (!a || !b) return "missing";
  if (a === b) return "same";
  if (first && (a.length === 1 || b.length === 1) && a[0] === b[0]) return "initial";
  if (first && isNickname(a, b)) return "nickname";
  if (a.length >= typoMinLength && b.length >= typoMinLength && a[0] === b[0] && oneTypoApart(a, b)) return "typo";
  return "differ";
}

// How two contacts' names agree. "unknown" when one has no name at all;
// "conflict" when both have names that can't be the same person's.
export function nameAgreement(
  a: { first: string; last: string },
  b: { first: string; last: string },
  typoMinLength: number,
): NameAgreement {
  if (!(a.first || a.last) || !(b.first || b.last)) return "unknown";
  const first = comparePart(a.first, b.first, typoMinLength, true);
  const last = comparePart(a.last, b.last, typoMinLength, false);
  if (first === "differ" || last === "differ") return "conflict";
  if (last === "same") {
    if (first === "same") return "exact";
    if (first === "nickname") return "nickname";
    if (first === "typo") return "typo";
    return "partial";
  }
  if (last === "typo") return first === "same" || first === "nickname" ? "typo" : "conflict";
  // Last name missing on one side.
  if (first === "same" || first === "nickname") return "partial";
  return first === "missing" ? "unknown" : "conflict";
}

const NAME_SIGNAL: Record<NameAgreement, Signal | null> = {
  exact: "sameName",
  nickname: "nickname",
  typo: "nameTypo",
  partial: "partialName",
  unknown: "nameMissing",
  conflict: null,
};

// The tier rules, from the name agreement and the other signals that
// agreed (phone, company name, email domain, company):
//   exact name:    1+ signals High
//   nickname:      1 Medium, 2+ High
//   name typo:     1 Low, 2+ Medium
//   partial or missing name: 2 including the phone Low, 3+ Medium
// Without a strong signal (a phone, or an organization key held by fewer
// than largeOrgMin contacts) the tier drops one level, so a large company's
// shared email domain can't carry a match on its own. Conflicting company
// names cap it at Medium.
export function contactTier(
  name: NameAgreement,
  signals: number,
  hasPhone: boolean,
  strong: boolean,
  companyConflict: boolean,
): Tier | null {
  let tier: Tier | null = null;
  if (name === "exact") tier = signals >= 1 ? "high" : null;
  else if (name === "nickname") tier = signals >= 2 ? "high" : signals === 1 ? "medium" : null;
  else if (name === "typo") tier = signals >= 2 ? "medium" : signals === 1 ? "low" : null;
  else if (name === "partial" || name === "unknown") tier = signals >= 3 ? "medium" : signals === 2 && hasPhone ? "low" : null;
  if (tier && !strong) tier = tier === "high" ? "medium" : tier === "medium" ? "low" : null;
  if (tier && companyConflict) tier = capTier(tier, "medium");
  return tier;
}

export type ContactMatchResult = { matches: Match[]; compared: number; sharedPhones: number };

// Finds likely duplicate contacts. `companyDomainOf` gives the domain hash
// of an associated company, when the company window has it.
export function matchContacts(
  store: ContactStore,
  config: ChecksConfig,
  companyDomainOf: (companyId: number) => number = () => 0,
): ContactMatchResult {
  const { sharedPhoneMin, largeOrgMin, blockMax, typoMinLength } = config.duplicates;
  const n = store.size;
  const companyDomain = new Column();
  for (let i = 0; i < n; i++) companyDomain.push(store.companyId.get(i) ? companyDomainOf(store.companyId.get(i)) : 0);

  const keyList = (...cols: Column[]) => {
    const list = new KeyList();
    for (const col of cols) for (let row = 0; row < n; row++) list.push(col.get(row), row);
    return list;
  };
  const blocks = {
    phone: keyList(store.phone1, store.phone2),
    emailDomain: keyList(store.emailDomain),
    company: keyList(store.company),
    companyId: keyList(store.companyId),
    companyDomain: keyList(companyDomain),
  };
  const shared = blocks.phone.largeKeys(sharedPhoneMin);
  const large = {
    emailDomain: blocks.emailDomain.largeKeys(largeOrgMin),
    company: blocks.company.largeKeys(largeOrgMin),
    companyId: blocks.companyId.largeKeys(largeOrgMin),
    companyDomain: blocks.companyDomain.largeKeys(largeOrgMin),
  };

  const phones = (i: number) => [store.phone1.get(i), store.phone2.get(i)].filter((p) => p && !shared.has(p));
  const same = (col: Column, i: number, j: number) => col.get(i) !== 0 && col.get(i) === col.get(j);

  function compare(i: number, j: number): Match | null {
    const name = nameAgreement(
      { first: store.first[i], last: store.last[i] },
      { first: store.first[j], last: store.last[j] },
      typoMinLength,
    );
    const nameSignal = NAME_SIGNAL[name];
    if (!nameSignal) return null;
    const pj = phones(j);
    const phone = phones(i).some((p) => pj.includes(p));
    const companyName = same(store.company, i, j);
    const email = same(store.emailDomain, i, j);
    const record = same(store.companyId, i, j);
    const domain = !record && same(companyDomain, i, j);
    const signals: Signal[] = [
      ...(phone ? ["phone" as const] : []),
      ...(companyName ? ["companyName" as const] : []),
      ...(email ? ["emailDomain" as const] : []),
      ...(record ? ["companyRecord" as const] : domain ? ["companyDomain" as const] : []),
    ];
    const strong =
      phone ||
      (companyName && !large.company.has(store.company.get(i))) ||
      (email && !large.emailDomain.has(store.emailDomain.get(i))) ||
      (record && !large.companyId.has(store.companyId.get(i))) ||
      (domain && !large.companyDomain.has(companyDomain.get(i)));
    const companyConflict = store.company.get(i) !== 0 && store.company.get(j) !== 0 && !companyName;
    const tier = contactTier(name, signals.length, phone, strong, companyConflict);
    return tier ? { a: i, b: j, tier, signals: [...signals, nameSignal] } : null;
  }

  // In large blocks, only contacts with similar names are compared: the
  // same last name, nickname group + last name, or one typo apart.
  // Hashed, so a large block's sub-groups cost 12 bytes per key.
  const nameKeys = (i: number): number[] => {
    const first = store.first[i];
    const last = store.last[i];
    if (!last) return [];
    return [
      `l:${last}`,
      ...nicknameGroups(first).map((g) => `n:${g}:${last}`),
      ...(first.length >= typoMinLength ? deletionVariants(first).map((v) => `f:${v}:${last}`) : []),
      ...(last.length >= typoMinLength ? deletionVariants(last).map((v) => `t:${first}:${v}`) : []),
    ].map(hashKey);
  };

  const found = new MatchSet(n);
  let compared = 0;
  for (const [kind, list] of Object.entries(blocks)) {
    list.forEachBlock((rows, key) => {
      // A shared line pairs unrelated people.
      if (kind === "phone" && shared.has(key)) return;
      compared += compareBlock(rows, blockMax, nameKeys, (a, b) => found.add(compare(a, b)));
    });
  }
  return { matches: found.all, compared, sharedPhones: shared.size };
}
