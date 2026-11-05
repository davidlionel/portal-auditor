import type { ChecksConfig } from "@/config/checks";
import type { SearchRow } from "@/lib/hubspot/search";
import { normalizeDomain, normalizeLabel } from "@/lib/text";
import { additionalDomains, companyNameKey, domainLabel, hashKey, rootDomain } from "./keys";
import {
  Column,
  IdColumn,
  MatchSet,
  allRows,
  byKey,
  compareBlock,
  eachBlock,
  passesFor,
  runSync,
  type Counter,
  type Match,
  type Signal,
  type Steps,
} from "./match";

// Company fields the duplicate check reads. Only domain is required; the
// rest are requested when the portal's property list has them.
export const COMPANY_MATCH_PROPERTIES = ["domain"];
export const COMPANY_OPTIONAL_PROPERTIES = ["name", "hs_additional_domains", "city", "state", "country", "zip"];

// The minimum each company needs for matching, all as hashes. `capacity`
// sizes the columns when the record count is known.
export class CompanyStore {
  readonly ids: IdColumn;
  readonly domain: Column;
  // Additional domains are rare, so they're kept per record only when set.
  readonly extraDomains = new Map<number, number[]>();
  readonly root: Column;
  readonly label: Column;
  readonly name: Column;
  readonly city: Column;
  readonly zip: Column;
  readonly state: Column;
  readonly country: Column;

  constructor(capacity?: number) {
    this.ids = new IdColumn(capacity);
    this.domain = new Column(capacity);
    this.root = new Column(capacity);
    this.label = new Column(capacity);
    this.name = new Column(capacity);
    this.city = new Column(capacity);
    this.zip = new Column(capacity);
    this.state = new Column(capacity);
    this.country = new Column(capacity);
  }

  get size() {
    return this.ids.length;
  }

  idOf = (row: number) => this.ids.get(row);

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
    for (let i = 0; i < this.size; i++) if (this.domain.get(i)) map.set(Number(this.ids.get(i)), this.domain.get(i));
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

// Blocks by domain (and additional domains), root domain, domain name and
// company name, one at a time and in passes of bounded size, yielding
// between slices (see match.ts).
export function* matchCompaniesSteps(store: CompanyStore, config: ChecksConfig): Steps<CompanyMatchResult> {
  const { blockMax } = config.duplicates;
  const n = store.size;
  const rows = allRows(n);
  const column = (col: Column) => byKey((row, push) => push(col.get(row)));
  const domains = byKey((row, push) => {
    const own = store.domain.get(row);
    push(own);
    const extra = store.extraDomains.get(row) ?? [];
    extra.forEach((key, i) => {
      if (key !== own && extra.indexOf(key) === i) push(key);
    });
  });
  const blocks = [domains, column(store.root), column(store.label), column(store.name)];
  // In a large block, only companies in the same city are compared.
  const cityKey = column(store.city);

  const found = new MatchSet(n);
  const counter: Counter = { compared: 0, atYield: 0 };
  for (const keys of blocks) {
    yield* eachBlock(rows, passesFor(n), keys, (members) =>
      compareBlock(members, blockMax, cityKey, 1, (a, b) => found.add(compareCompanies(store, a, b)), counter),
    );
  }
  return { matches: found.all, compared: counter.compared };
}

// All at once, for tests and small inputs.
export const matchCompanies = (store: CompanyStore, config: ChecksConfig): CompanyMatchResult =>
  runSync(matchCompaniesSteps(store, config));
