import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import type { Finding } from "@/lib/checks/types";
import { checkDuplicateCompanies, checkDuplicateContacts } from "@/lib/checks/records/duplicates";
import { ContactStore, matchContacts, nameAgreement } from "@/lib/dedupe/contacts";
import { SIGNAL_LABELS } from "@/lib/dedupe/match";
import { row } from "./fixtures";

type ContactFields = { first?: string; last?: string; company?: string; email?: string; phone?: string; mobile?: string; companyId?: string };
const contact = (id: string, f: ContactFields) =>
  row(id, {
    firstname: f.first ?? null,
    lastname: f.last ?? null,
    company: f.company ?? null,
    email: f.email ?? null,
    phone: f.phone ?? null,
    mobilephone: f.mobile ?? null,
    associatedcompanyid: f.companyId ?? null,
  });

type CompanyFields = { domain?: string; extra?: string; name?: string; city?: string; state?: string; country?: string; zip?: string };
const company = (id: string, f: CompanyFields) =>
  row(id, {
    domain: f.domain ?? null,
    hs_additional_domains: f.extra ?? null,
    name: f.name ?? null,
    city: f.city ?? null,
    state: f.state ?? null,
    country: f.country ?? null,
    zip: f.zip ?? null,
  });

// The tier and signals of the group holding these two records, or null.
function tierOf(findings: Finding[], a: string, b: string): { tier: string; signals: string } | null {
  for (const f of findings) {
    const group = f.records?.find((r) => r.id === a)?.group;
    if (group !== undefined && f.records?.some((r) => r.id === b && r.group === group)) {
      return { tier: f.checkId.split("-").at(-1)!, signals: f.records!.find((r) => r.id === a)!.signals! };
    }
  }
  return null;
}

const pair = (a: ContactFields, b: ContactFields) => tierOf(checkDuplicateContacts([contact("a", a), contact("b", b)]), "a", "b");

describe("contact duplicates: tiers", () => {
  it("High: exact name and the same company, as before", () => {
    assert.equal(pair({ first: "Maria", last: "Lopez", company: "Northwind Traders" }, { first: "maria", last: "LOPEZ", company: "Northwind Traders" })?.tier, "high");
    // Portal contacts 578829614799 and 578831438551, missed by the first live scan.
    assert.equal(pair({ first: "Sam", last: "O'Neil", company: "Acme, Inc." }, { first: "sam", last: "oneil", company: "ACME Inc" })?.tier, "high");
  });

  it("High: a nickname with two more signals, listing what agreed", () => {
    const match = pair(
      { first: "Bob", last: "Smith", phone: "+1 (415) 555-0142", email: "bob@initech.example" },
      { first: "Robert", last: "Smith", phone: "415.555.0142", email: "rsmith@initech.example" },
    );
    assert.deepEqual(match, { tier: "high", signals: "same phone + same email domain + nickname" });
  });

  it("Medium: a nickname with one signal", () => {
    assert.equal(pair({ first: "Bob", last: "Smith", company: "Initech" }, { first: "Robert", last: "Smith", company: "Initech" })?.tier, "medium");
  });

  it("Medium and Low: a name typo with two signals, or one", () => {
    const a = { first: "Micheal", last: "Jones", company: "Globex", phone: "2125550100" };
    assert.equal(pair(a, { first: "Michael", last: "Jones", company: "Globex", phone: "212-555-0100" })?.tier, "medium");
    assert.equal(pair({ first: "Micheal", last: "Jones", company: "Globex" }, { first: "Michael", last: "Jones", company: "Globex" })?.tier, "low");
  });

  it("sparse records: no name on one side needs three signals for Medium, or two with the phone for Low", () => {
    const full = { first: "Ana", last: "Silva", company: "Initech", email: "ana@initech.example", phone: "6175550199" };
    assert.deepEqual(pair(full, { company: "Initech", email: "info@initech.example", phone: "617 555 0199" }), {
      tier: "medium",
      signals: "same phone + same company name + same email domain + name missing on one",
    });
    assert.equal(pair(full, { last: "Silva", email: "a@initech.example", phone: "6175550199" })?.tier, "low");
    assert.equal(pair(full, { email: "x@initech.example", company: "Initech" }), null, "two signals without the phone");
  });

  it("caps at Medium when the company names differ (someone who changed jobs)", () => {
    assert.equal(
      pair({ first: "Lee", last: "Park", company: "Acme", phone: "3125550123" }, { first: "Lee", last: "Park", company: "Globex", phone: "3125550123" })?.tier,
      "medium",
    );
  });

  it("uses the associated company record and its domain", () => {
    const domains = new Map([[11, 501], [12, 501]]);
    const findings = checkDuplicateContacts(
      [contact("a", { first: "Kim", last: "Lee", companyId: "11" }), contact("b", { first: "Kim", last: "Lee", companyId: "12" })],
      CHECKS_CONFIG,
      (id) => domains.get(id) ?? 0,
    );
    assert.deepEqual(tierOf(findings, "a", "b"), { tier: "high", signals: "same company domain + same name" });
    const same = checkDuplicateContacts([contact("a", { first: "Kim", last: "Lee", companyId: "11" }), contact("b", { first: "Kim", last: "Lee", companyId: "11" })]);
    assert.equal(tierOf(same, "a", "b")?.signals, "same company record + same name");
  });

  it("only High counts toward the score", () => {
    const findings = checkDuplicateContacts([
      contact("1", { first: "Maria", last: "Lopez", company: "Northwind" }),
      contact("2", { first: "Maria", last: "Lopez", company: "Northwind" }),
      contact("3", { first: "Bob", last: "Smith", company: "Initech" }),
      contact("4", { first: "Robert", last: "Smith", company: "Initech" }),
    ]);
    assert.deepEqual(findings.map((f) => [f.checkId, f.scored]), [
      ["contacts.duplicates-high", undefined],
      ["contacts.duplicates-medium", false],
    ]);
  });
});

describe("contact duplicates: controls that must not reach High", () => {
  it("two John Smiths at different companies", () => {
    assert.equal(pair({ first: "John", last: "Smith", company: "Acme", email: "john@gmail.com" }, { first: "John", last: "Smith", company: "Globex", email: "jsmith@gmail.com" }), null);
  });

  it("siblings sharing a home phone", () => {
    const home = "5035550177";
    assert.equal(pair({ first: "Emma", last: "Clark", phone: home, email: "emma@gmail.com" }, { first: "Oliver", last: "Clark", phone: home, email: "ollie@gmail.com" }), null);
    // Names one letter apart only reach Low.
    assert.equal(pair({ first: "Maria", last: "Clark", phone: home }, { first: "Mario", last: "Clark", phone: home })?.tier, "low");
  });

  it("an office switchboard shared by 20 contacts", () => {
    const board = "+1 800 555 0100";
    const staff = Array.from({ length: 20 }, (_, i) =>
      contact(`s${i}`, { first: `Person${i}`, last: `Staff${i}`, phone: board, company: "Initech", email: `p${i}@initech.example` }),
    );
    // A real duplicate among them is still found, through its name and company.
    const findings = checkDuplicateContacts([
      ...staff,
      contact("d1", { first: "Ana", last: "Silva", phone: board, company: "Initech", email: "ana@initech.example" }),
      contact("d2", { first: "Ana", last: "Silva", phone: board, company: "Initech", email: "asilva@initech.example" }),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].count, 1, "only the real pair");
    assert.equal(tierOf(findings, "d1", "d2")?.signals, "same company name + same email domain + same name");
    assert.ok(findings.every((f) => f.records!.every((r) => !r.signals!.includes("same phone"))), "the switchboard isn't a signal");
  });

  it("free email domains", () => {
    assert.equal(pair({ first: "John", last: "Smith", email: "john.smith@gmail.com" }, { first: "John", last: "Smith", email: "jsmith@gmail.com" }), null);
    assert.equal(pair({ first: "Bob", last: "Lee", email: "a@outlook.com", phone: "2065550111" }, { first: "Robert", last: "Lee", email: "b@outlook.com", phone: "2065550111" })?.tier, "medium");
  });

  it("two different John Smiths on the same large company email domain", () => {
    const size = CHECKS_CONFIG.duplicates.largeOrgMin + 5;
    const staff = Array.from({ length: size }, (_, i) =>
      contact(`s${i}`, { first: `Person${i}`, last: `Staff${i}`, company: "BigCorp", email: `p${i}@bigcorp.example`, companyId: "77" }),
    );
    const findings = checkDuplicateContacts([
      ...staff,
      contact("j1", { first: "John", last: "Smith", company: "BigCorp", email: "john.smith@bigcorp.example", companyId: "77" }),
      contact("j2", { first: "John", last: "Smith", company: "BigCorp", email: "john.smith2@bigcorp.example", companyId: "77" }),
    ]);
    assert.equal(tierOf(findings, "j1", "j2")?.tier, "medium");
    // The same pair at a small company is High.
    assert.equal(pair({ first: "John", last: "Smith", email: "js@small.example" }, { first: "John", last: "Smith", email: "john@small.example" })?.tier, "high");
  });

  it("a large organization's shared details alone drop a match one level", () => {
    const size = CHECKS_CONFIG.duplicates.largeOrgMin + 5;
    const staff = Array.from({ length: size }, (_, i) =>
      contact(`s${i}`, { first: `Person${i}`, last: `Staff${i}`, company: "BigCorp", email: `p${i}@bigcorp.example` }),
    );
    const findings = checkDuplicateContacts([
      ...staff,
      // A name typo sharing only the large domain: not reported (would be Low).
      contact("t1", { first: "Kevin", last: "Smith", email: "k1@bigcorp.example" }),
      contact("t2", { first: "Kevin", last: "Smyth", email: "k2@bigcorp.example" }),
      // A nickname sharing only the large company name and domain: Medium (High with a strong signal).
      contact("n1", { first: "Bob", last: "Jones", company: "BigCorp", email: "b@bigcorp.example" }),
      contact("n2", { first: "Robert", last: "Jones", company: "BigCorp", email: "r@bigcorp.example" }),
    ]);
    assert.equal(tierOf(findings, "t1", "t2"), null);
    assert.equal(tierOf(findings, "n1", "n2")?.tier, "medium");
  });
});

describe("contact duplicates: names", () => {
  const n = (first: string, last: string) => ({ first, last });
  it("reads name agreement", () => {
    assert.equal(nameAgreement(n("john", "smith"), n("john", "smith"), 5), "exact");
    assert.equal(nameAgreement(n("jon", "smith"), n("john", "smith"), 5), "nickname");
    assert.equal(nameAgreement(n("michael", "jones"), n("micheal", "jones"), 5), "typo");
    assert.equal(nameAgreement(n("", "smith"), n("john", "smith"), 5), "partial");
    assert.equal(nameAgreement(n("j", "smith"), n("john", "smith"), 5), "partial");
    assert.equal(nameAgreement(n("", ""), n("john", "smith"), 5), "unknown");
    assert.equal(pair({ first: "José", last: "Núñez", company: "Acme" }, { first: "Jose", last: "Nunez", company: "Acme" })?.tier, "high", "accents ignored");
    assert.equal(nameAgreement(n("emma", "clark"), n("oliver", "clark"), 5), "conflict");
    assert.equal(nameAgreement(n("mark", "lee"), n("mary", "lee"), 5), "conflict", "short names don't count as typos");
  });
});

describe("contact duplicates: groups and work list", () => {
  it("counts groups for the report and records for the score, against the window", () => {
    const [finding] = checkDuplicateContacts([
      ...Array.from({ length: 6 }, (_, i) => contact(`g${i}`, { first: "A", last: "Grind", company: "Acme Grinding" })),
      contact("p1", { first: "B", last: "Pair", company: "X" }),
      contact("p2", { first: "B", last: "Pair", company: "X" }),
      contact("solo", { first: "C", last: "Solo", company: "Y" }),
    ]);
    assert.equal(finding.count, 2, "the report counts groups");
    assert.equal(finding.affected, 8, "the score counts records");
    assert.equal(finding.population, 9);
    assert.deepEqual(finding.matchSummary, [{ signals: "same company name + same name", groups: 2 }]);
  });

  it("numbers groups in the work list, with their signals, and keeps whole groups under the cap", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => contact(`t${i}`, { first: "T", last: "Three", company: "X" })),
      contact("p1", { first: "P", last: "Pair", company: "X" }),
      contact("p2", { first: "P", last: "Pair", company: "X" }),
    ];
    const config = { ...CHECKS_CONFIG, records: { ...CHECKS_CONFIG.records, workListCap: 4 } };
    const [finding] = checkDuplicateContacts(rows, config);
    const signals = "same company name + same name";
    assert.deepEqual(finding.records, [
      { id: "t0", group: 1, signals },
      { id: "t1", group: 1, signals },
      { id: "t2", group: 1, signals },
    ]);
  });

  it("splits groups larger than the maximum into pairs", () => {
    const rows = Array.from({ length: 12 }, (_, i) => contact(`x${i}`, { first: "Same", last: "Person", company: "X" }));
    const [finding] = checkDuplicateContacts(rows);
    assert.equal(finding.count, 66, "12 records as pairs");
  });

  it("points High to HubSpot's duplicate tool and Medium to the owners", () => {
    const findings = checkDuplicateContacts([
      contact("1", { first: "A", last: "B", company: "C" }),
      contact("2", { first: "A", last: "B", company: "C" }),
      contact("3", { first: "Bob", last: "Smith", company: "D" }),
      contact("4", { first: "Robert", last: "Smith", company: "D" }),
    ]);
    assert.match(findings[0].fix, /Manage duplicates/);
    assert.match(findings[1].fix, /owner to confirm/);
  });

  it("labels every match from the fixed list, never with values", () => {
    const labels = new Set(Object.values(SIGNAL_LABELS));
    const findings = checkDuplicateContacts([
      contact("a", { first: "Bob", last: "Smith", phone: "4155550142", email: "bob@initech.example", company: "Initech" }),
      contact("b", { first: "Robert", last: "Smith", phone: "4155550142", email: "r@initech.example", company: "Initech" }),
    ]);
    for (const f of findings) for (const r of f.records!) for (const s of r.signals!.split(" + ")) assert.ok(labels.has(s as never), s);
  });
});

describe("contact duplicates: cost", () => {
  it("compares a bounded number of pairs, even with a 2,000-contact domain", () => {
    const store = new ContactStore(new Set());
    const n = 10_000;
    for (let i = 0; i < n; i++) {
      store.add(
        contact(String(i), {
          first: `First${i % 900}`,
          last: `Last${i % 1300}`,
          company: i < 2000 ? "Huge Co" : `Company ${i % 3000}`,
          email: i < 2000 ? `p${i}@huge.example` : `p${i}@c${i % 3000}.example`,
          phone: String(2000000000 + (i % 7000)),
        }),
      );
    }
    const { compared } = matchContacts(store, CHECKS_CONFIG);
    assert.ok(compared < 25 * n, `${compared} comparisons for ${n} contacts`);
  });
});

describe("company duplicates", () => {
  const pairOf = (a: CompanyFields, b: CompanyFields) => tierOf(checkDuplicateCompanies([company("a", a), company("b", b)]), "a", "b");

  it("High: the same domain written differently, or an additional domain", () => {
    assert.deepEqual(pairOf({ domain: "northwind.example" }, { domain: "https://www.Northwind.example/about" }), { tier: "high", signals: "same domain" });
    assert.deepEqual(pairOf({ domain: "acme.com", extra: "acme.io; acme.net" }, { domain: "acme.io" }), { tier: "high", signals: "additional domain" });
  });

  it("Medium: the same root domain", () => {
    assert.deepEqual(pairOf({ domain: "eu.acme.com" }, { domain: "acme.com" }), { tier: "medium", signals: "same root domain" });
  });

  it("Low: the same domain name with a different ending", () => {
    assert.equal(pairOf({ domain: "acme.com", name: "Acme" }, { domain: "acme.co.uk", name: "Acme Ltd" })?.tier, "low");
    assert.equal(pairOf({ domain: "acme.com", name: "Acme" }, { domain: "acme.co.uk", name: "Acme Rockets" }), null, "different names");
  });

  it("never matches separate shops on a hosting platform", () => {
    assert.equal(pairOf({ domain: "one.myshopify.com" }, { domain: "two.myshopify.com" }), null);
  });

  it("without a domain: name plus city is Medium, name plus state or country is Low", () => {
    assert.deepEqual(pairOf({ name: "Blue Fern Cafe" }, { name: "The Blue Fern Cafe", city: "Portland", domain: "bluefern.example" }), null, "no city on one side, no region");
    assert.equal(pairOf({ name: "Blue Fern Cafe", city: "Portland" }, { name: "Blue Fern Café, LLC", city: "portland" })?.tier, "medium", "accents ignored");
    assert.deepEqual(pairOf({ name: "Blue Fern Cafe", city: "Portland" }, { name: "Blue Fern Cafe LLC", city: "portland" }), { tier: "medium", signals: "same company name + same city" });
    assert.equal(pairOf({ name: "Blue Fern Cafe", zip: "97201" }, { name: "Blue Fern Cafe", zip: "97201" })?.tier, "medium");
    assert.deepEqual(pairOf({ name: "Blue Fern Cafe", state: "Oregon" }, { name: "Blue Fern Cafe", state: "oregon", city: "Bend" }), { tier: "low", signals: "same company name + same state or country" });
  });

  it("doesn't match the same name in different cities, or a name alone", () => {
    assert.equal(pairOf({ name: "Blue Fern Cafe", city: "Portland" }, { name: "Blue Fern Cafe", city: "Seattle" }), null);
    assert.equal(pairOf({ name: "Blue Fern Cafe" }, { name: "Blue Fern Cafe" }), null);
  });

  it("only High counts toward the score", () => {
    const findings = checkDuplicateCompanies([
      company("1", { domain: "a.example" }),
      company("2", { domain: "a.example" }),
      company("3", { domain: "eu.b.example" }),
      company("4", { domain: "b.example" }),
    ]);
    assert.deepEqual(findings.map((f) => [f.checkId, f.scored]), [
      ["companies.duplicates-high", undefined],
      ["companies.duplicates-medium", false],
    ]);
  });
});
