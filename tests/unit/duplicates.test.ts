import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import {
  checkDuplicateContacts,
  checkDuplicateDomains,
  groupByKey,
} from "@/lib/checks/records/duplicates";
import { row } from "./fixtures";

const contact = (id: string, firstname: string | null, lastname: string | null, company: string | null) =>
  row(id, { firstname, lastname, company });

const company = (id: string, domain: string | null) => row(id, { domain });

describe("groupByKey", () => {
  it("returns only buckets with two or more rows, skipping empty keys", () => {
    const rows = [row("1", { k: "a" }), row("2", { k: "a" }), row("3", { k: "b" }), row("4", { k: "" }), row("5", { k: "" })];
    assert.deepEqual(groupByKey(rows, (r) => r.properties.k ?? ""), [["1", "2"]]);
  });
});

describe("duplicate contacts", () => {
  it("flags the same name and company, ignoring case, punctuation and suffixes", () => {
    const [finding] = checkDuplicateContacts([
      contact("1", "Maria", "Lopez", "Northwind Traders"),
      contact("2", "maria", "LOPEZ", "Northwind Traders"),
      contact("3", "Sam", "O'Neil", "Acme, Inc."),
      contact("4", "sam", "o neil", "ACME Inc"),
    ]);
    assert.equal(finding.checkId, "contacts.duplicate-name-company");
    assert.equal(finding.severity, "high");
    assert.equal(finding.count, 2);
    assert.deepEqual(finding.recordSamples, [["1", "2"], ["3", "4"]]);
  });

  it("matches an apostrophe in a name against the same name typed without it", () => {
    // Portal contacts 578829614799 and 578831438551, missed by the first live scan.
    const [finding] = checkDuplicateContacts([
      contact("1", "Sam", "O'Neil", "Acme, Inc."),
      contact("2", "sam", "oneil", "ACME Inc"),
    ]);
    assert.ok(finding, "O'Neil and oneil at the same company should be flagged");
    assert.deepEqual(finding.recordSamples, [["1", "2"]]);
  });

  it("does not flag the same name at different companies", () => {
    assert.deepEqual(
      checkDuplicateContacts([contact("1", "John", "Smith", "Acme"), contact("2", "John", "Smith", "Globex")]),
      [],
    );
  });

  it("does not flag different people at the same company", () => {
    assert.deepEqual(
      checkDuplicateContacts([contact("1", "Ana", "Silva", "Initech"), contact("2", "Lee", "Park", "Initech")]),
      [],
    );
  });

  it("skips contacts missing a first name, last name or company", () => {
    assert.deepEqual(
      checkDuplicateContacts([
        contact("1", null, "Smith", "Acme"),
        contact("2", null, "Smith", "Acme"),
        contact("3", "Jo", "", "Acme"),
        contact("4", "Jo", "", "Acme"),
        contact("5", "Kim", "Lee", null),
        contact("6", "Kim", "Lee", null),
      ]),
      [],
    );
  });

  it("lists the largest groups first and caps the sample", () => {
    const rows = [
      contact("a1", "A", "One", "X"),
      contact("a2", "A", "One", "X"),
      ...Array.from({ length: 7 }, (_, i) => contact(`b${i}`, "B", "Two", "X")),
    ];
    const [finding] = checkDuplicateContacts(rows, { ...CHECKS_CONFIG, sampleCap: 1 });
    assert.equal(finding.count, 2);
    assert.equal(finding.recordSamples?.length, 1);
    assert.equal(finding.recordSamples?.[0].length, 5, "IDs per group are capped at 5");
  });

  it("counts records in groups for the rate, measured against the window", () => {
    const [finding] = checkDuplicateContacts([
      ...Array.from({ length: 6 }, (_, i) => contact(`g${i}`, "A", "Grind", "Acme Grinding")),
      contact("p1", "B", "Pair", "X"),
      contact("p2", "B", "Pair", "X"),
      contact("solo", "C", "Solo", "Y"),
    ]);
    assert.equal(finding.count, 2, "the report counts groups");
    assert.equal(finding.affected, 8, "the score counts records");
    assert.equal(finding.population, 9);
  });

  it("numbers groups in the work list and keeps whole groups under the cap", () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => contact(`t${i}`, "T", "Three", "X")),
      contact("p1", "P", "Pair", "X"),
      contact("p2", "P", "Pair", "X"),
    ];
    const config = { ...CHECKS_CONFIG, records: { ...CHECKS_CONFIG.records, workListCap: 4 } };
    const [finding] = checkDuplicateContacts(rows, config);
    assert.deepEqual(finding.records, [
      { id: "t0", group: 1 },
      { id: "t1", group: 1 },
      { id: "t2", group: 1 },
    ]);
  });

  it("points the fix to HubSpot's duplicate tool", () => {
    const [finding] = checkDuplicateContacts([contact("1", "A", "B", "C"), contact("2", "A", "B", "C")]);
    assert.match(finding.fix, /Manage duplicates/);
  });
});

describe("duplicate company domains", () => {
  it("flags the same domain written differently", () => {
    const [finding] = checkDuplicateDomains([
      company("1", "northwind.example"),
      company("2", "northwind.example"),
      company("3", "https://www.Globex.example/about"),
      company("4", "globex.example"),
    ]);
    assert.equal(finding.checkId, "companies.duplicate-domain");
    assert.equal(finding.count, 2);
    assert.match(finding.fix, /Manage duplicates/);
  });

  it("does not flag a subdomain against its parent domain", () => {
    assert.deepEqual(
      checkDuplicateDomains([company("1", "eu.initech.example"), company("2", "initech.example")]),
      [],
    );
  });

  it("does not flag companies with no domain", () => {
    assert.deepEqual(checkDuplicateDomains([company("1", null), company("2", ""), company("3", "localhost")]), []);
  });
});
