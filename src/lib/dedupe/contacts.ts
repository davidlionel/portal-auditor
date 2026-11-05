import type { ChecksConfig } from "@/config/checks";
import type { SearchRow } from "@/lib/hubspot/search";
import { companyNameKey, emailDomain, hashJoined, hashKey, isNickname, nicknameGroups, oneTypoApart, personNameKey, phoneKey } from "./keys";
import {
  Column,
  IdColumn,
  MatchSet,
  TextColumn,
  allRows,
  byKey,
  capTier,
  compareBlock,
  eachBlock,
  keysHeldBy,
  passesFor,
  runSync,
  type Counter,
  type KeyEmitter,
  type Match,
  type Signal,
  type Steps,
  type Tier,
} from "./match";

// Contact fields the duplicate check reads. associatedcompanyid isn't in
// HubSpot's current docs, so it's only requested when the portal's
// property list has it.
export const CONTACT_MATCH_PROPERTIES = ["firstname", "lastname", "company", "email"];
export const CONTACT_OPTIONAL_PROPERTIES = ["phone", "mobilephone", "associatedcompanyid"];

// The minimum each contact needs for matching: normalized first and last
// name, and hashes of the rest, in compact columns (about 85 bytes a
// contact). Built page by page as records arrive; the raw values are
// dropped with the page. `capacity` sizes the columns when the record count
// is known.
export class ContactStore {
  readonly ids: IdColumn;
  readonly first: TextColumn;
  readonly last: TextColumn;
  readonly phone1: Column;
  readonly phone2: Column;
  readonly emailDomain: Column;
  readonly company: Column;
  readonly companyId: Column;

  constructor(
    private freeDomains: Set<string>,
    capacity?: number,
  ) {
    this.ids = new IdColumn(capacity);
    this.first = new TextColumn(capacity);
    this.last = new TextColumn(capacity);
    this.phone1 = new Column(capacity);
    this.phone2 = new Column(capacity);
    this.emailDomain = new Column(capacity);
    this.company = new Column(capacity);
    this.companyId = new Column(capacity);
  }

  get size() {
    return this.ids.length;
  }

  idOf = (row: number) => this.ids.get(row);

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

// Similar-name keys per contact in a large block, at most: last name,
// nickname groups, and one-letter deletions of first and last name.
const NAME_KEYS_PER_ROW = 24;

// Finds likely duplicate contacts, one blocking key at a time and in passes
// of bounded size, yielding between slices (see match.ts). `companyDomainOf`
// gives the domain hash of an associated company, when the company check
// read it.
export function* matchContactsSteps(
  store: ContactStore,
  config: ChecksConfig,
  companyDomainOf: (companyId: number) => number = () => 0,
): Steps<ContactMatchResult> {
  const { sharedPhoneMin, largeOrgMin, blockMax, typoMinLength } = config.duplicates;
  const n = store.size;
  const rows = allRows(n);
  const companyDomain = new Column(n);
  for (let i = 0; i < n; i++) {
    companyDomain.push(store.companyId.get(i) ? companyDomainOf(store.companyId.get(i)) : 0);
    if (i % 8192 === 8191) yield;
  }

  const column = (col: Column) => byKey((row, push) => push(col.get(row)));
  const keys = {
    phone: byKey((row, push) => {
      push(store.phone1.get(row));
      if (store.phone2.get(row) !== store.phone1.get(row)) push(store.phone2.get(row));
    }),
    emailDomain: column(store.emailDomain),
    company: column(store.company),
    companyId: column(store.companyId),
    companyDomain: column(companyDomain),
  };
  const passes = { phone: passesFor(2 * n), other: passesFor(n) };
  const passesOf = (kind: keyof typeof keys) => (kind === "phone" ? passes.phone : passes.other);

  const shared = yield* keysHeldBy(rows, passes.phone, keys.phone, sharedPhoneMin);
  const large = {
    emailDomain: yield* keysHeldBy(rows, passes.other, keys.emailDomain, largeOrgMin),
    company: yield* keysHeldBy(rows, passes.other, keys.company, largeOrgMin),
    companyId: yield* keysHeldBy(rows, passes.other, keys.companyId, largeOrgMin),
    companyDomain: yield* keysHeldBy(rows, passes.other, keys.companyDomain, largeOrgMin),
  };

  const phones = (i: number) => [store.phone1.get(i), store.phone2.get(i)].filter((p) => p && !shared.has(p));
  const same = (col: Column, i: number, j: number) => col.get(i) !== 0 && col.get(i) === col.get(j);

  function compare(i: number, j: number): Match | null {
    const name = nameAgreement(
      { first: store.first.get(i), last: store.last.get(i) },
      { first: store.first.get(j), last: store.last.get(j) },
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
  // same last name, nickname group + last name, or one typo apart. Keys
  // containing the exact last name go in the pass its hash picks, and keys
  // containing the exact first name in the pass the first name's hash
  // picks, so contacts sharing a key always meet in the same pass.
  // The low 16 bits of each name's hash, worked out once per contact (-1
  // until then; -2 for no last name), so a pass can skip the contacts that
  // aren't in it without decoding their names. Pass counts are powers of
  // two, so the low bits are enough.
  const lastLow = new Int32Array(n).fill(-1);
  const firstLow = new Int32Array(n);
  // The keys are hashKey(`l:${last}`), hashKey(`f:${variant}:${last}`) and
  // so on, where a variant is the name with one letter left out (or none),
  // hashed without building the strings. A key two variants share is
  // pushed once.
  const pushed: number[] = [];
  const nameKeys: KeyEmitter = (row, pass, passCount, push) => {
    if (lastLow[row] === -1) {
      const last = hashKey(store.last.get(row));
      lastLow[row] = last ? last % 65536 : -2;
      firstLow[row] = hashKey(store.first.get(row)) % 65536;
    }
    if (lastLow[row] === -2) return;
    const inLastPass = lastLow[row] % passCount === pass;
    const inFirstPass = firstLow[row] % passCount === pass;
    if (!inLastPass && !inFirstPass) return;
    const last = store.last.get(row);
    const first = store.first.get(row);
    pushed.length = 0;
    const once = (key: number) => {
      if (pushed.includes(key)) return;
      pushed.push(key);
      push(key);
    };
    if (inLastPass) {
      once(hashJoined("l", last, null));
      for (const g of nicknameGroups(first)) once(hashJoined("n", String(g), last));
      if (first.length >= typoMinLength) for (let i = -1; i < first.length; i++) once(hashJoined("f", first, last, 1, i));
    }
    if (inFirstPass && last.length >= typoMinLength) {
      for (let i = -1; i < last.length; i++) once(hashJoined("t", first, last, 2, i));
    }
  };

  const found = new MatchSet(n);
  const counter: Counter = { compared: 0, atYield: 0 };
  for (const kind of Object.keys(keys) as (keyof typeof keys)[]) {
    yield* eachBlock(rows, passesOf(kind), keys[kind], function* (members, key) {
      // A shared line pairs unrelated people.
      if (kind === "phone" && shared.has(key)) return;
      yield* compareBlock(members, blockMax, nameKeys, NAME_KEYS_PER_ROW, (a, b) => found.add(compare(a, b)), counter);
    });
  }
  return { matches: found.all, compared: counter.compared, sharedPhones: shared.size };
}

// All at once, for tests and small inputs.
export const matchContacts = (
  store: ContactStore,
  config: ChecksConfig,
  companyDomainOf?: (companyId: number) => number,
): ContactMatchResult => runSync(matchContactsSteps(store, config, companyDomainOf));
