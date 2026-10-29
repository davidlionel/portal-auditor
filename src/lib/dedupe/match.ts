// Shared machinery for the duplicate checks: compact columns, blocking
// (only records that share a key are compared), and turning matched pairs
// into groups by confidence tier.

export type Tier = "high" | "medium" | "low";
export const TIERS: Tier[] = ["high", "medium", "low"];

// A matched pair of records (indexes into a store), its tier and the
// signals that agreed, as labels from SIGNAL_LABELS.
export type Match = { a: number; b: number; tier: Tier; signals: Signal[] };

// Every label a match can show. Matches name what agreed, never the values.
export const SIGNAL_LABELS = {
  phone: "same phone",
  companyName: "same company name",
  emailDomain: "same email domain",
  companyRecord: "same company record",
  companyDomain: "same company domain",
  sameName: "same name",
  nickname: "nickname",
  nameTypo: "name typo",
  partialName: "partial name",
  nameMissing: "name missing on one",
  domain: "same domain",
  additionalDomain: "additional domain",
  rootDomain: "same root domain",
  domainLabel: "same domain name, different ending",
  city: "same city",
  postalCode: "same postal code",
  region: "same state or country",
} as const;

export type Signal = keyof typeof SIGNAL_LABELS;

export const signalText = (signals: Signal[]) => signals.map((s) => SIGNAL_LABELS[s]).join(" + ");

// A growable column of numbers, 8 bytes each, so a store holds no object
// per record.
export class Column {
  private data = new Float64Array(1024);
  length = 0;
  push(value: number) {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }
  get(i: number): number {
    return this.data[i];
  }
}

// (key, record) pairs in two typed arrays: 12 bytes each, with no object
// or array per key. Keys of 0 mean "no value" and aren't added.
export class KeyList {
  private keys = new Float64Array(1024);
  private rows = new Int32Array(1024);
  length = 0;

  push(key: number, row: number) {
    if (!key) return;
    if (this.length === this.keys.length) {
      const keys = new Float64Array(this.keys.length * 2);
      const rows = new Int32Array(this.rows.length * 2);
      keys.set(this.keys);
      rows.set(this.rows);
      this.keys = keys;
      this.rows = rows;
    }
    this.keys[this.length] = key;
    this.rows[this.length++] = row;
  }

  // Calls `visit` with each set of two or more records sharing a key.
  // Sorting entry indexes by key finds the sets without a map from key to
  // records.
  forEachBlock(visit: (rows: number[], key: number) => void) {
    const { keys, rows } = this;
    const order = Int32Array.from({ length: this.length }, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
    for (let start = 0; start < order.length; ) {
      let end = start + 1;
      while (end < order.length && keys[order[end]] === keys[order[start]]) end++;
      if (end - start > 1) {
        const members = new Set<number>();
        for (let i = start; i < end; i++) members.add(rows[order[i]]);
        if (members.size > 1) visit([...members], keys[order[start]]);
      }
      start = end;
    }
  }

  // Keys held by at least `min` records: shared phone lines and large
  // organizations.
  largeKeys(min: number): Set<number> {
    const large = new Set<number>();
    this.forEachBlock((rows, key) => {
      if (rows.length >= min) large.add(key);
    });
    return large;
  }
}

// Compares every pair in a block, or, in a block larger than `blockMax`,
// only pairs sharing one of `subKeys` (similar names, as numeric keys), so
// cost stays linear. Returns how many pairs were compared.
export function compareBlock(
  rows: number[],
  blockMax: number,
  subKeys: (row: number) => number[],
  compare: (a: number, b: number) => void,
): number {
  if (rows.length <= blockMax) {
    for (let x = 0; x < rows.length; x++) for (let y = x + 1; y < rows.length; y++) compare(rows[x], rows[y]);
    return (rows.length * (rows.length - 1)) / 2;
  }
  const sub = new KeyList();
  for (const row of rows) for (const key of subKeys(row)) sub.push(key, row);
  let compared = 0;
  sub.forEachBlock((members) => {
    // A similar-name group this big is too ambiguous to compare.
    if (members.length <= blockMax) compared += compareBlock(members, blockMax, () => [], compare);
  });
  return compared;
}

// Collects matches, keeping one per pair however many blocks it's in.
export class MatchSet {
  private byPair = new Map<number, Match>();
  constructor(private size: number) {}
  add(match: Match | null) {
    if (!match) return;
    const [a, b] = match.a < match.b ? [match.a, match.b] : [match.b, match.a];
    this.byPair.set(a * this.size + b, { ...match, a, b });
  }
  get all(): Match[] {
    return [...this.byPair.values()];
  }
}

const RANK: Record<Tier, number> = { high: 0, medium: 1, low: 2 };

// Lowers a tier to at most `cap`.
export const capTier = (tier: Tier, cap: Tier): Tier => (RANK[tier] < RANK[cap] ? cap : tier);

export type MatchGroup = { tier: Tier; rows: number[]; signals: Signal[] };

function components(edges: Match[]): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(x, root);
    return root;
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    parent.set(find(e.a), find(e.b));
  }
  const groups = new Map<number, number[]>();
  for (const x of parent.keys()) groups.set(find(x), [...(groups.get(find(x)) ?? []), x]);
  return [...groups.values()];
}

// Groups by tier. High pairs join into groups; Medium pairs join groups
// that aren't already one High group; Low pairs stay pairs. Groups larger
// than `maxGroupSize` are split back into their pairs. A group's signals
// are its weakest link's.
export function groupMatches(matches: Match[], maxGroupSize: number): MatchGroup[] {
  const groups: MatchGroup[] = [];
  const groupOf = new Map<number, number>();
  const sameGroup = (m: Match) => groupOf.has(m.a) && groupOf.get(m.a) === groupOf.get(m.b);
  for (const tier of TIERS) {
    const edges = matches.filter((m) => m.tier === tier && !sameGroup(m));
    const parts = tier === "low" ? edges.map((e) => [e.a, e.b]) : components(edges);
    const added: MatchGroup[] = [];
    for (const rows of parts) {
      const inside = edges.filter((e) => rows.includes(e.a) && rows.includes(e.b));
      if (rows.length > maxGroupSize) {
        added.push(...inside.map((e) => ({ tier, rows: [e.a, e.b], signals: e.signals })));
        continue;
      }
      const weakest = inside.reduce((w, e) => (e.signals.length < w.signals.length ? e : w));
      added.push({ tier, rows: [...rows].sort((x, y) => x - y), signals: weakest.signals });
    }
    for (const g of added) {
      const id = groups.length;
      groups.push(g);
      for (const row of g.rows) if (!groupOf.has(row)) groupOf.set(row, id);
    }
  }
  return groups;
}
