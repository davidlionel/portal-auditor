import type { ChecksConfig } from "@/config/checks";
import type { SearchRow } from "@/lib/hubspot/search";
import { normalizeDomain, normalizeLabel } from "@/lib/text";
import { additionalDomains, companyNameKey, domainLabel, hashKey, rootDomain } from "./keys";
import { Column, KeyList, MatchSet, compareBlock, type Match, type Signal } from "./match";

// Company fields the duplicate check reads. Only domain is required; the
// rest are requested when the portal's property list has them.
export const COMPANY_MATCH_PROPERTIES = ["domain"];
export const COMPANY_OPTIONAL_PROPERTIES = ["name", "hs_additional_domains", "city", "state", "country", "zip"];

// The minimum each company needs for matching, all as hashes.
export class CompanyStore {
  readonly ids: string[] = [];
  readonly domain = new Column();
  // Additional domains are rare, so they're kept per record only when set.
  readonly extraDomains = new Map<number, number[]>();
  readonly root = new Column();
  readonly label = new Column();
  readonly name = new Column();
  readonly city = new Column();
  readonly zip = new Column();
  readonly state = new Column();
  readonly country = new Column();

  get size() {
    return this.ids.length;
  }

  add(row: SearchRow) {
    const p = row.properties;
    const domain = normalizeDomain(p.domain ?? "");
    const extra = additionalDomains(p.hs_additional_domains).filter((d) => d !== domain);
    const place = (value: string | null | undefined) => hashKey(normalizeLabel(value ?? ""));
    if (extra.length) this.extraDomains.set(this.ids.length, extra.map(hashKey));
    this.ids.push(row.id);
    this.domain.push(hashKey(domain));
    this.root.push(hashKey(rootDomain(domain)));
    this.label.push(hashKey(domainLabel(domain)));
    this.name.push(hashKey(companyNameKey(p.name)));
    this.city.push(place(p.city));
    this.zip.push(hashKey((p.zip ?? "").replace(/\s/g, "").toLowerCase()));
    this.state.push(place(p.state));
    this.country.push(place(p.country));
  }

  // Domain hash by company ID, for the contact check's company signal.
  domainById(): Map<number, number> {
    const map = new Map<number, number>();
    for (let i = 0; i < this.size; i++) if (this.domain.get(i)) map.set(Number(this.ids[i]), this.domain.get(i));
    return map;
  }
}

// The tier rules for companies:
//   High:   the same domain, or one's domain among the other's additional domains
//   Medium: the same root domain (eu.acme.com, acme.com); or, without a domain
//           on one side, the same name and the same city or postal code
//   Low:    the same domain name with a different ending (acme.com, acme.co.uk)
//           and no conflicting names; or, without a domain on one side, the
//           same name and the same state or country, with no city to compare
// Two companies with unrelated domains, or the same name in different
// cities, are never matched.
export function compareCompanies(store: CompanyStore, i: number, j: number): Match | null {
  const has = (col: Column, x: number) => col.get(x) !== 0;
  const same = (col: Column) => has(col, i) && col.get(i) === col.get(j);
  const differ = (col: Column) => has(col, i) && has(col, j) && col.get(i) !== col.get(j);
  const domainsOf = (x: number) => [store.domain.get(x), ...(store.extraDomains.get(x) ?? [])].filter(Boolean);

  const match = (tier: Match["tier"], signals: Signal[]): Match => ({ a: i, b: j, tier, signals });
  if (same(store.domain)) return match("high", ["domain"]);
  const dj = domainsOf(j);
  if (domainsOf(i).some((d) => dj.includes(d))) return match("high", ["additionalDomain"]);

  if (has(store.domain, i) && has(store.domain, j)) {
    if (same(store.root)) return match("medium", ["rootDomain"]);
    if (same(store.label) && !differ(store.name)) return match("low", ["domainLabel", ...(same(store.name) ? ["companyName" as const] : [])]);
    return null;
  }

  if (!same(store.name)) return null;
  if (differ(store.state) || differ(store.country)) return null;
  if (same(store.city)) return match("medium", ["companyName", "city"]);
  if (same(store.zip)) return match("medium", ["companyName", "postalCode"]);
  if (differ(store.city) || differ(store.zip)) return null;
  if (same(store.state) || same(store.country)) return match("low", ["companyName", "region"]);
  return null;
}

export type CompanyMatchResult = { matches: Match[]; compared: number };

export function matchCompanies(store: CompanyStore, config: ChecksConfig): CompanyMatchResult {
  const { blockMax } = config.duplicates;
  const n = store.size;
  const keyList = (col: Column) => {
    const list = new KeyList();
    for (let row = 0; row < n; row++) list.push(col.get(row), row);
    return list;
  };
  const domains = keyList(store.domain);
  for (const [row, keys] of store.extraDomains) for (const key of keys) domains.push(key, row);
  const blocks = [domains, keyList(store.root), keyList(store.label), keyList(store.name)];
  // In a large block, only companies in the same city are compared.
  const cityKey = (row: number) => (store.city.get(row) ? [store.city.get(row)] : []);

  const found = new MatchSet(n);
  let compared = 0;
  for (const list of blocks) {
    list.forEachBlock((rows) => {
      compared += compareBlock(rows, blockMax, cityKey, (a, b) => found.add(compareCompanies(store, a, b)));
    });
  }
  return { matches: found.all, compared };
}
