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
// per record. Sized up front when the record count is known.
export class Column {
  private data: Float64Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Float64Array(Math.max(16, capacity));
  }
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

// Record IDs as numbers (HubSpot's are), 8 bytes each. Any ID that isn't a
// plain integer is kept as text on the side.
export class IdColumn {
  private numbers: Column;
  private other = new Map<number, string>();
  constructor(capacity?: number) {
    this.numbers = new Column(capacity);
  }
  get length() {
    return this.numbers.length;
  }
  push(id: string) {
    const n = Number(id);
    if (!(Number.isSafeInteger(n) && String(n) === id)) this.other.set(this.numbers.length, id);
    this.numbers.push(n);
  }
  get(i: number): string {
    return this.other.get(i) ?? String(this.numbers.get(i));
  }
}

// Short strings (normalized names) packed into one buffer, one byte a
// character plus 4 for the offset, instead of a string object each. Text
// with characters past Latin-1 (other scripts) is kept as a string on the
// side.
export class TextColumn {
  private bytes = new Uint8Array(8192);
  private ends: Uint32Array;
  private other = new Map<number, string>();
  private count = 0;
  private used = 0;
  constructor(capacity = 1024) {
    this.ends = new Uint32Array(Math.max(16, capacity));
  }
  push(text: string) {
    if (this.count === this.ends.length) {
      const next = new Uint32Array(Math.ceil(this.ends.length * 1.5));
      next.set(this.ends);
      this.ends = next;
    }
    let latin1 = true;
    for (let i = 0; i < text.length && latin1; i++) latin1 = text.charCodeAt(i) < 256;
    if (!latin1) {
      this.other.set(this.count, text);
      text = "";
    }
    if (this.used + text.length > this.bytes.length) {
      const next = new Uint8Array(Math.max(Math.ceil(this.bytes.length * 1.5), this.used + text.length));
      next.set(this.bytes);
      this.bytes = next;
    }
    for (let i = 0; i < text.length; i++) this.bytes[this.used + i] = text.charCodeAt(i);
    this.used += text.length;
    this.ends[this.count++] = this.used;
  }
  get(i: number): string {
    const start = i === 0 ? 0 : this.ends[i - 1];
    return this.other.get(i) ?? String.fromCharCode.apply(null, this.bytes.subarray(start, this.ends[i]) as unknown as number[]);
  }
}

// Matching runs as a generator that yields every so often, so a long match
// can hand control back between slices: runAsync lets progress updates and
// Cancel through; runSync just runs it.
export type Steps<T> = Generator<void, T, void>;

export function runSync<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

// Runs the steps in slices of about `sliceMs`, waiting a turn of the event
// loop between slices. `onSlice` gets each slice's length. Returns null
// when `signal` is aborted.
export async function runAsync<T>(
  steps: Steps<T>,
  options: { signal?: AbortSignal; sliceMs?: number; onSlice?: (ms: number) => void } = {},
): Promise<T | null> {
  const sliceMs = options.sliceMs ?? 40;
  let sliceStart = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    const ran = performance.now() - sliceStart;
    if (ran < sliceMs) continue;
    await new Promise((resolve) => setImmediate(resolve));
    if (options.signal?.aborted) return null;
    options.onSlice?.(ran);
    sliceStart = performance.now();
  }
}

// Key entries handled in one pass. Records sharing a key always land in the
// same pass, so splitting the work this way never misses a pair; it only
// caps how much is in memory at once. Tests lower it to force many passes.
export const MATCH_TUNING = { passEntries: 200_000 };

// Passes needed for about `entries` key entries: a power of two, so a key's
// pass can be read from the low bits of its hash.
export function passesFor(entries: number): number {
  let passes = 1;
  while (passes * MATCH_TUNING.passEntries < entries) passes *= 2;
  return passes;
}

// Pushes the keys of `row` that belong to pass `pass` of `passes`, each at
// most once. Every row holding a given key must push it in the same pass.
// 0 means no key.
export type KeyEmitter = (row: number, pass: number, passes: number, push: (key: number) => void) => void;

// Splits a row's keys across passes by their value.
export const byKey =
  (keysOf: (row: number, push: (key: number) => void) => void): KeyEmitter =>
  (row, pass, passes, push) =>
    keysOf(row, (key) => {
      if (key && key % passes === pass) push(key);
    });

// The rows 0 to n - 1.
export function allRows(n: number): Int32Array {
  const rows = new Int32Array(n);
  for (let i = 0; i < n; i++) rows[i] = i;
  return rows;
}

const CHECK_EVERY = 2048;

// Counts and rows per key for one pass, in typed arrays reused from pass to
// pass, so a pass makes almost no garbage: an open-addressing hash table of
// keys and counts, then the rows of each key held by two or more laid out
// back to back in one buffer.
class KeyTable {
  private keys: Float64Array;
  private counts: Int32Array;
  private starts: Int32Array;
  private filled: Int32Array;
  private members = new Int32Array(1024);
  private used = 0;

  constructor(entries: number) {
    const size = KeyTable.sizeFor(entries);
    this.keys = new Float64Array(size);
    this.counts = new Int32Array(size);
    this.starts = new Int32Array(size);
    this.filled = new Int32Array(size);
  }

  // A power of two at least twice the entries, so probes stay short.
  private static sizeFor(entries: number) {
    let size = 1024;
    while (size < entries * 2) size *= 2;
    return size;
  }

  clear() {
    this.keys.fill(0);
    this.counts.fill(0);
    this.used = 0;
  }

  private slot(key: number): number {
    const mask = this.keys.length - 1;
    // Mixes high and low bits: passes split keys by their low bits.
    let i = ((key / 4294967296) ^ key ^ (key >>> 13)) & mask;
    while (this.keys[i] !== 0 && this.keys[i] !== key) i = (i + 1) & mask;
    return i;
  }

  count(key: number) {
    if (this.used * 2 >= this.keys.length) this.grow();
    const i = this.slot(key);
    if (this.keys[i] === 0) {
      this.keys[i] = key;
      this.used++;
    }
    this.counts[i]++;
  }

  private grow() {
    const { keys, counts } = this;
    const size = keys.length * 2;
    this.keys = new Float64Array(size);
    this.counts = new Int32Array(size);
    this.starts = new Int32Array(size);
    this.filled = new Int32Array(size);
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === 0) continue;
      const j = this.slot(keys[i]);
      this.keys[j] = keys[i];
      this.counts[j] = counts[i];
    }
  }

  *large(min: number): Generator<number> {
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] !== 0 && this.counts[i] >= min) yield this.keys[i];
  }

  // Makes room for the rows of every key held by two or more.
  layOut() {
    let total = 0;
    for (let i = 0; i < this.keys.length; i++) {
      this.filled[i] = 0;
      if (this.counts[i] > 1) {
        this.starts[i] = total;
        total += this.counts[i];
      }
    }
    if (this.members.length < total) this.members = new Int32Array(Math.ceil(total * 1.25));
  }

  place(key: number, row: number) {
    const i = this.slot(key);
    if (this.counts[i] > 1) this.members[this.starts[i] + this.filled[i]++] = row;
  }

  // Each key held by two or more, with its rows. The views share one
  // buffer, which the next pass reuses.
  *blocks(): Generator<[Int32Array, number]> {
    for (let i = 0; i < this.keys.length; i++) {
      if (this.counts[i] > 1) yield [this.members.subarray(this.starts[i], this.starts[i] + this.counts[i]), this.keys[i]];
    }
  }
}

// Fills the table with one pass's keys.
function* countKeys(table: KeyTable, rows: ArrayLike<number>, pass: number, passes: number, emit: KeyEmitter): Steps<void> {
  table.clear();
  const push = (key: number) => {
    if (key) table.count(key);
  };
  for (let i = 0; i < rows.length; i++) {
    emit(rows[i], pass, passes, push);
    if (i % CHECK_EVERY === CHECK_EVERY - 1) yield;
  }
}

// Keys held by at least `min` rows: shared phone lines and large
// organizations.
export function* keysHeldBy(rows: ArrayLike<number>, passes: number, emit: KeyEmitter, min: number): Steps<Set<number>> {
  const large = new Set<number>();
  const table = new KeyTable(Math.min(MATCH_TUNING.passEntries, rows.length));
  for (let pass = 0; pass < passes; pass++) {
    yield* countKeys(table, rows, pass, passes, emit);
    for (const key of table.large(min)) large.add(key);
  }
  return large;
}

// Visits each set of two or more rows sharing a key, one pass at a time:
// count the keys, then collect the rows of the keys held by two or more.
// `entriesPerRow` sizes the table. The rows passed to `visit` are only
// valid until it returns.
export function* eachBlock(
  rows: ArrayLike<number>,
  passes: number,
  emit: KeyEmitter,
  visit: (members: Int32Array, key: number) => Steps<void>,
  entriesPerRow = 1,
): Steps<void> {
  const table = new KeyTable(Math.min(MATCH_TUNING.passEntries, Math.ceil((rows.length * entriesPerRow) / passes)));
  for (let pass = 0; pass < passes; pass++) {
    yield* countKeys(table, rows, pass, passes, emit);
    table.layOut();
    let row = 0;
    const place = (key: number) => {
      if (key) table.place(key, row);
    };
    for (let i = 0; i < rows.length; i++) {
      row = rows[i];
      emit(row, pass, passes, place);
      if (i % CHECK_EVERY === CHECK_EVERY - 1) yield;
    }
    let visited = 0;
    for (const [members, key] of table.blocks()) {
      yield* visit(members, key);
      if (++visited % 256 === 0) yield;
    }
  }
}

// Pairs compared so far, and the count at the last yield.
export type Counter = { compared: number; atYield: number };

// Compares every pair in a block, or, in a block larger than `blockMax`,
// only pairs sharing a sub-key (a similar name, say) in sub-blocks no
// larger than blockMax, so cost stays linear. `subKeys` emits a row's
// sub-keys for one pass; `subKeysPerRow` sizes the passes.
export function* compareBlock(
  rows: ArrayLike<number>,
  blockMax: number,
  subKeys: KeyEmitter,
  subKeysPerRow: number,
  compare: (a: number, b: number) => void,
  counter: Counter,
): Steps<void> {
  if (rows.length <= blockMax) {
    for (let x = 0; x < rows.length; x++) {
      for (let y = x + 1; y < rows.length; y++) compare(rows[x], rows[y]);
      counter.compared += rows.length - x - 1;
      // Yields by work done, since most blocks are small.
      if (counter.compared - counter.atYield >= 2_000) {
        counter.atYield = counter.compared;
        yield;
      }
    }
    return;
  }
  // Each large block is a slice's worth of work on its own.
  yield;
  yield* eachBlock(
    rows,
    passesFor(rows.length * subKeysPerRow),
    subKeys,
    function* (members) {
      // A similar-name group this big is too ambiguous to compare.
      if (members.length <= blockMax) yield* compareBlock(members, blockMax, () => {}, 0, compare, counter);
    },
    subKeysPerRow,
  );
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

// Connected rows, each part with the edges inside it. Linear in the edges.
function components(edges: Match[]): { rows: number[]; edges: Match[] }[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (x !== root) {
      const next = parent.get(x)!;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    parent.set(find(e.a), find(e.b));
  }
  const parts = new Map<number, { rows: number[]; edges: Match[] }>();
  for (const x of parent.keys()) {
    const root = find(x);
    if (!parts.has(root)) parts.set(root, { rows: [], edges: [] });
    parts.get(root)!.rows.push(x);
  }
  for (const e of edges) parts.get(find(e.a))!.edges.push(e);
  return [...parts.values()];
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
    const parts = tier === "low" ? edges.map((e) => ({ rows: [e.a, e.b], edges: [e] })) : components(edges);
    const added: MatchGroup[] = [];
    for (const { rows, edges: inside } of parts) {
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
