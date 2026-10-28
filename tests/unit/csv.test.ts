import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Finding } from "@/lib/checks/types";
import { csvCell, findingsCsv, toCsv, workListCsv, workListObjects } from "@/lib/csv";
import type { ScanReport } from "@/lib/scan";
import { scoreChecks } from "@/lib/scoring";

function finding(overrides: Partial<Finding> & { checkId: string }): Finding {
  return {
    title: overrides.checkId,
    category: "Contacts",
    objectType: "contacts",
    severity: "medium",
    count: 0,
    affected: 0,
    population: 100,
    samples: [],
    why: "Why.",
    fix: "Fix.",
    ...overrides,
  };
}

function report(findings: Finding[]): ScanReport {
  const checks = findings.map((f) => ({ ...f, status: "scored" as const }));
  return {
    portal: {
      portalId: 123,
      accountType: "DEVELOPER_TEST",
      timeZone: "UTC",
      companyCurrency: "USD",
      uiDomain: "app.hubspot.com",
      dataHostingLocation: "na1",
    },
    scannedObjects: ["contacts", "companies", "deals"],
    notes: [],
    findings,
    checks,
    score: scoreChecks(checks),
    apiCalls: 0,
    retries: 0,
    durationMs: 0,
    simulated: false,
  };
}

// Rows of a CSV without the byte-order mark, split naively (test data has
// no quoted commas unless the test is about them).
const lines = (csv: string) => csv.replace(/^﻿/, "").trimEnd().split("\r\n");

describe("csvCell and toCsv", () => {
  it("quotes commas, quotes and line breaks", () => {
    assert.equal(csvCell("plain"), "plain");
    assert.equal(csvCell("a, b"), '"a, b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell("two\nlines"), '"two\nlines"');
    assert.equal(csvCell(42), "42");
  });

  it("stops spreadsheets running cells as formulas", () => {
    assert.equal(csvCell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert.equal(csvCell("+1 555"), "'+1 555");
    assert.equal(csvCell("-5"), "'-5");
    assert.equal(csvCell("@sum"), "'@sum");
  });

  it("starts with a byte-order mark and uses CRLF line endings", () => {
    const csv = toCsv([["a", "b"], ["c", "d"]]);
    assert.ok(csv.startsWith("﻿"));
    assert.equal(csv, "﻿a,b\r\nc,d\r\n");
  });
});

describe("findings CSV", () => {
  it("has one row per finding with rate and points recovered", () => {
    const csv = findingsCsv(
      report([
        finding({ checkId: "contacts.missing-email", title: "Missing email", count: 20, affected: 20, population: 1000 }),
      ]),
    );
    const [header, row] = lines(csv);
    assert.equal(
      header,
      "Check,Object,Category,Severity,Count,Affected,Population,Rate (%),Points recovered,Why it matters,How to fix",
    );
    // 2% medium scores 92 in the only category, so fixing it recovers 8.
    assert.equal(row, "Missing email,Contacts,Contacts,medium,20,20,1000,2,8,Why.,Fix.");
  });
});

describe("work list CSV", () => {
  const dupes = finding({
    checkId: "contacts.duplicate-name-company",
    title: "Duplicates",
    severity: "high",
    count: 1,
    affected: 2,
    records: [
      { id: "11", group: 1 },
      { id: "12", group: 1 },
    ],
  });
  const missing = finding({
    checkId: "contacts.missing-email",
    title: "Missing email",
    count: 4512,
    affected: 4512,
    population: 250_000,
    records: [{ id: "21" }, { id: "22" }],
  });
  const deals = finding({
    checkId: "deals.stale",
    category: "Deals",
    objectType: "deals",
    count: 1,
    affected: 1,
    records: [{ id: "31" }],
  });
  const property = finding({ checkId: "properties.no-description", category: "Properties", count: 3, affected: 3 });
  const r = report([dupes, missing, deals, property]);

  it("lists IDs, check, group, link and capped marker for one object only", () => {
    assert.deepEqual(lines(workListCsv(r, "contacts")), [
      "Record ID,Object type,Check,Severity,Duplicate group,HubSpot record link,Capped",
      "11,Contacts,Duplicates,high,1,https://app.hubspot.com/contacts/123/record/0-1/11,",
      "12,Contacts,Duplicates,high,1,https://app.hubspot.com/contacts/123/record/0-1/12,",
      "21,Contacts,Missing email,medium,,https://app.hubspot.com/contacts/123/record/0-1/21,\"first 2 of 4,512\"",
      "22,Contacts,Missing email,medium,,https://app.hubspot.com/contacts/123/record/0-1/22,\"first 2 of 4,512\"",
    ]);
  });

  it("uses each object's type ID in links", () => {
    assert.match(workListCsv(r, "deals"), /record\/0-3\/31/);
  });

  it("offers a file only for objects with records", () => {
    assert.deepEqual(workListObjects(r), ["contacts", "deals"]);
  });

  it("never includes field values, only what the finding carries", () => {
    const csv = workListCsv(r, "contacts");
    assert.doesNotMatch(csv, /@|Why\.|Fix\./);
  });
});
