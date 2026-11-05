import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import { CompanyStore, matchCompanies } from "@/lib/dedupe/companies";
import { ContactStore, matchContacts, matchContactsSteps } from "@/lib/dedupe/contacts";
import { IdColumn, MATCH_TUNING, TextColumn, runAsync, type Match } from "@/lib/dedupe/match";
import { createPortal, SIZE_250K } from "@/lib/simulator/portal";

const DEFAULT_PASS = MATCH_TUNING.passEntries;
afterEach(() => (MATCH_TUNING.passEntries = DEFAULT_PASS));

const portal = createPortal({ ...SIZE_250K, records: { ...SIZE_250K.records, contacts: 6_000, companies: 4_000 } });

function contactStore() {
  const store = new ContactStore(new Set(CHECKS_CONFIG.duplicates.freeEmailDomains));
  for (let i = 0; i < 6_000; i++) store.add(portal.record("contacts", i));
  return store;
}

const described = (matches: Match[], idOf: (row: number) => string) =>
  matches.map((m) => `${idOf(m.a)}-${idOf(m.b)}:${m.tier}:${m.signals.join("+")}`).sort();

describe("matching in passes", () => {
  it("finds exactly the same contact pairs in one pass or in hundreds", () => {
    const store = contactStore();
    // Company domains, so the company-domain signal is exercised too.
    const domainOf = (id: number) => (id % 5 === 0 ? 0 : (id % 211) + 1);
    const once = matchContacts(store, CHECKS_CONFIG, domainOf);
    MATCH_TUNING.passEntries = 300;
    const many = matchContacts(store, CHECKS_CONFIG, domainOf);
    assert.ok(once.matches.length > 100);
    assert.deepEqual(described(many.matches, store.idOf), described(once.matches, store.idOf));
    assert.equal(many.compared, once.compared);
    assert.equal(many.sharedPhones, once.sharedPhones);
  });

  it("does the same for the similar-name path inside large blocks", () => {
    const store = contactStore();
    const tight = { ...CHECKS_CONFIG, duplicates: { ...CHECKS_CONFIG.duplicates, blockMax: 3 } };
    const once = matchContacts(store, tight);
    MATCH_TUNING.passEntries = 200;
    const many = matchContacts(store, tight);
    assert.deepEqual(described(many.matches, store.idOf), described(once.matches, store.idOf));
    assert.equal(many.compared, once.compared);
  });

  it("finds exactly the same company pairs in one pass or many", () => {
    const store = new CompanyStore();
    for (let i = 0; i < 4_000; i++) store.add(portal.record("companies", i));
    const once = matchCompanies(store, CHECKS_CONFIG);
    MATCH_TUNING.passEntries = 100;
    const many = matchCompanies(store, CHECKS_CONFIG);
    assert.ok(once.matches.length > 50);
    assert.deepEqual(described(many.matches, store.idOf), described(once.matches, store.idOf));
  });
});

describe("matching in slices", () => {
  it("gives the same result run in slices, handing control back between them", async () => {
    const store = contactStore();
    let slices = 0;
    const sliced = await runAsync(matchContactsSteps(store, CHECKS_CONFIG), { sliceMs: 1, onSlice: () => slices++ });
    assert.ok(slices > 1);
    assert.deepEqual(described(sliced!.matches, store.idOf), described(matchContacts(store, CHECKS_CONFIG).matches, store.idOf));
  });

  it("stops at the next slice when cancelled", async () => {
    const controller = new AbortController();
    const result = await runAsync(matchContactsSteps(contactStore(), CHECKS_CONFIG), {
      sliceMs: 1,
      signal: controller.signal,
      onSlice: () => controller.abort(),
    });
    // onSlice runs after the abort check, so the slice after it stops.
    assert.equal(result, null);
  });
});

describe("compact columns", () => {
  it("keeps record IDs as numbers, and any other ID as text", () => {
    const ids = new IdColumn(2);
    for (const id of ["579467783923", "a", "007", "12"]) ids.push(id);
    assert.deepEqual([0, 1, 2, 3].map((i) => ids.get(i)), ["579467783923", "a", "007", "12"]);
  });

  it("packs names one byte a character, and keeps other scripts intact", () => {
    const names = new TextColumn(1);
    const values = ["jose", "", "müller", "田中", "o'neil"];
    for (const v of values) names.push(v);
    assert.deepEqual(values.map((_, i) => names.get(i)), values);
  });
});
