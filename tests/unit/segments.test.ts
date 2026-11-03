import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import {
  checkDuplicateSegmentNames,
  checkEmptySegments,
  checkSegmentProperties,
  filterProperties,
} from "@/lib/checks/segments";
import { newTracker, type Transport } from "@/lib/hubspot/client";
import { propertyStatus, readSegments, type FilterBranch, type SegmentDef } from "@/lib/hubspot/segments";
import { runScan } from "@/lib/scan";
import { SIZE_SMALL } from "@/lib/simulator/portal";
import { simulatorTransport } from "@/lib/simulator/transport";
import { NOW, daysAgo } from "./fixtures";

console.info = () => {};

const segment = (overrides: Partial<SegmentDef> & { id: string }): SegmentDef => ({
  name: `Segment ${overrides.id}`,
  objectTypeId: "0-1",
  processingType: "DYNAMIC",
  processingStatus: "COMPLETE",
  createdAt: daysAgo(90),
  size: 25,
  ...overrides,
});

const propertyFilter = (property: string, operation: unknown = { operationType: "ALL_PROPERTY", operator: "IS_KNOWN" }) => ({
  filterType: "PROPERTY",
  property,
  operation,
});

const config = { ...CHECKS_CONFIG, searchMinIntervalMs: 0 };

describe("segment filter properties", () => {
  it("finds properties in nested branches, on associated records and in date comparisons", () => {
    const root: FilterBranch = {
      filterBranchType: "OR",
      filters: [],
      filterBranches: [
        {
          filterBranchType: "AND",
          filters: [
            propertyFilter("lifecyclestage"),
            propertyFilter("notes_last_updated", {
              operationType: "TIME_POINT",
              timePoint: { timeType: "PROPERTY_REFERENCED", property: "hs_latest_open_lead_date" },
            }),
          ],
          filterBranches: [
            { filterBranchType: "ASSOCIATION", objectTypeId: "0-2", filters: [propertyFilter("domain")], filterBranches: [] },
            { filterBranchType: "ASSOCIATION", objectTypeId: "0-3", filters: [propertyFilter("amount")], filterBranches: [] },
          ],
        },
        { filterBranchType: "AND", filters: [propertyFilter("lifecyclestage"), { filterType: "FORM_SUBMISSION" }], filterBranches: [] },
      ],
    };
    const { refs, unchecked } = filterProperties(root, "0-1");
    assert.deepEqual(
      refs.map((r) => `${r.objectType}.${r.property}`).sort(),
      ["companies.domain", "contacts.hs_latest_open_lead_date", "contacts.lifecyclestage", "contacts.notes_last_updated", "deals.amount"],
    );
    assert.equal(unchecked, 0);
  });

  it("counts filters on events and on objects the scan doesn't read as unchecked", () => {
    const root: FilterBranch = {
      filterBranchType: "OR",
      filterBranches: [
        {
          filterBranchType: "AND",
          filters: [],
          filterBranches: [
            { filterBranchType: "UNIFIED_EVENTS", filters: [propertyFilter("hs_url")] },
            { filterBranchType: "ASSOCIATION", objectTypeId: "0-5", filters: [propertyFilter("hs_ticket_priority")] },
          ],
        },
      ],
    };
    assert.deepEqual(filterProperties(root, "0-1"), { refs: [], unchecked: 2 });
    // A ticket segment's own filters aren't checked either.
    assert.deepEqual(filterProperties({ filterBranchType: "OR", filters: [propertyFilter("subject")] }, "0-5"), { refs: [], unchecked: 1 });
  });
});

describe("empty segments", () => {
  // The real 30-day rule, using the app's own config.
  it("skips segments 29 days old and reports ones 31 days old", () => {
    assert.equal(CHECKS_CONFIG.segments.emptyMinAgeDays, 30);
    const [finding] = checkEmptySegments(
      [segment({ id: "1", size: 0, createdAt: daysAgo(29) }), segment({ id: "2", size: 0, createdAt: daysAgo(31) })],
      NOW,
    );
    assert.deepEqual(finding.items, ['2 "Segment 2" (active)']);
    assert.equal(finding.population, 1);
  });

  it("skips segments still processing or with no size, and says which are static", () => {
    const [finding] = checkEmptySegments(
      [
        segment({ id: "1", size: 0, processingStatus: "PROCESSING" }),
        segment({ id: "2", size: null }),
        segment({ id: "3", size: 0, processingType: "MANUAL" }),
        segment({ id: "4", size: 0, processingType: "SNAPSHOT" }),
        segment({ id: "5", size: 12 }),
      ],
      NOW,
    );
    assert.deepEqual(finding.items, ['3 "Segment 3" (static)', '4 "Segment 4" (static)']);
    assert.equal(finding.population, 3);
    assert.equal(finding.objectType, "segments");
    assert.equal(finding.category, "Segments");
  });

  it("accepts a test config without changing the real rule", () => {
    const young = [segment({ id: "74", name: "Audit Test Empty Static", size: 0, processingType: "MANUAL", createdAt: daysAgo(0) })];
    const testConfig = { ...CHECKS_CONFIG, segments: { ...CHECKS_CONFIG.segments, emptyMinAgeDays: 0 } };

    assert.deepEqual(checkEmptySegments(young, NOW, testConfig)[0].items, ['74 "Audit Test Empty Static" (static)']);
    assert.deepEqual(checkEmptySegments(young, NOW), []);
    assert.equal(CHECKS_CONFIG.segments.emptyMinAgeDays, 30);
  });
});

describe("duplicate segment names", () => {
  it("matches names that differ only in case, spacing and punctuation", () => {
    const [finding] = checkDuplicateSegmentNames([
      segment({ id: "76", name: "Trade Show Leads" }),
      segment({ id: "77", name: "Trade show leads!" }),
      segment({ id: "55", name: "Audit work list test" }),
    ]);
    assert.deepEqual(finding.items, ['76 "Trade Show Leads" / 77 "Trade show leads!"']);
    assert.deepEqual(finding.segments, [
      { id: "76", name: "Trade Show Leads", group: 1 },
      { id: "77", name: "Trade show leads!", group: 1 },
    ]);
    assert.equal(finding.count, 1);
    assert.equal(finding.affected, 2);
    assert.equal(finding.population, 3);
  });

  it("doesn't match a numbered series, other objects or unnamed segments", () => {
    assert.deepEqual(
      checkDuplicateSegmentNames([
        segment({ id: "1", name: "Webinar 2025" }),
        segment({ id: "2", name: "Webinar 2026" }),
        segment({ id: "3", name: "Customers", objectTypeId: "0-1" }),
        segment({ id: "4", name: "Customers", objectTypeId: "0-2" }),
        segment({ id: "5", name: "" }),
        segment({ id: "6", name: "!!" }),
      ]),
      [],
    );
  });
});

describe("segments filtering on missing properties", () => {
  it("names each segment and says whether the property is archived or gone", () => {
    const [finding] = checkSegmentProperties(
      [
        {
          segment: segment({ id: "9", name: "Old leads" }),
          missing: [
            { objectType: "contacts", property: "old_source", status: "archived" },
            { objectType: "companies", property: "region", status: "not_found" },
          ],
        },
        { segment: segment({ id: "10" }), missing: [] },
      ],
      2,
    );
    assert.deepEqual(finding.items, ['9 "Old leads": contacts.old_source (archived); companies.region (not found)']);
    assert.equal(finding.population, 2);
    assert.equal(finding.severity, "medium");
  });

  it("looks a property up as archived, then sensitive, and calls a refused lookup unverified", async () => {
    const answer = (statusFor: (query: string) => number): Transport => async ({ path }) =>
      new Response("{}", { status: statusFor(path.slice(path.indexOf("?") + 1)) });
    const look = (t: Transport) => propertyStatus(t, newTracker(), "contacts", "x");

    assert.deepEqual(await look(answer((q) => (q === "archived=true" ? 200 : 404))), { ok: true, data: "archived" });
    assert.deepEqual(await look(answer((q) => (q === "dataSensitivity=highly_sensitive" ? 200 : 404))), { ok: true, data: "sensitive" });
    assert.deepEqual(await look(answer((q) => (q === "archived=true" ? 404 : 403))), { ok: true, data: "unverified" });
    assert.deepEqual(await look(answer(() => 404)), { ok: true, data: "not_found" });
  });
});

describe("segment checks in a scan", () => {
  it("flags the planted segments, notes the sensitive one and doesn't flag it", async () => {
    const result = await runScan(simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport, { config });
    assert.ok(result.ok);
    const { report } = result;
    const items = (id: string) => report.findings.find((f) => f.checkId === id)?.items ?? [];
    assert.deepEqual(items("segments.filters-missing-property"), [
      '1004 "Sim segment 4": contacts.sim_archived_source (archived)',
      '1006 "Sim segment 6": contacts.sim_deleted_region (not found)',
    ]);
    assert.ok(!items("segments.filters-missing-property").some((i) => i.includes("sim_sensitive_notes")));
    assert.ok(items("segments.empty").includes('1018 "Sim segment 18" (active)'));
    assert.ok(!items("segments.empty").some((i) => i.startsWith("1000 ") || i.startsWith("1025 ")), "too young to report");
    assert.deepEqual(items("segments.duplicate-names"), ['1010 "Sim segment 10" / 1011 "SIM SEGMENT 10!"']);
    assert.match(report.notes.join("\n"), /couldn't verify 1 property \(contacts\.sim_sensitive_notes\)/);
    assert.match(report.notes.join("\n"), /Segment checks covered all 60 segments \(30 active\)/);
    assert.ok(report.score.categories.find((c) => c.category === "Segments")?.score !== null);
  });

  it("skips the segment checks with a note when the key has no lists scope", async () => {
    const sim = simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport;
    const noLists: Transport = (req) =>
      req.path.startsWith("/crm/lists/") ? Promise.resolve(new Response("{}", { status: 403 })) : sim(req);
    const result = await runScan(noLists, { config });
    assert.ok(result.ok);
    const segmentRuns = result.report.checks.filter((c) => c.category === "Segments");
    assert.equal(segmentRuns.length, 3);
    assert.ok(segmentRuns.every((c) => c.status === "skipped" && c.reason === "key lacks crm.lists.read"));
    assert.ok(result.report.notes.includes("Segment checks skipped: key lacks crm.lists.read."));
    assert.equal(result.report.score.categories.find((c) => c.category === "Segments")?.score, null);
    assert.ok(result.report.score.overall !== null, "the other categories still score");
  });

  it("reads segments 500 at a time and filters 100 at a time", async () => {
    const size = { ...SIZE_SMALL, segments: 1_201 };
    const paths: string[] = [];
    const sim = simulatorTransport({ size, rateLimits: "none" }).transport;
    const spy: Transport = (req) => {
      if (req.path.startsWith("/crm/lists/")) paths.push(req.path);
      return sim(req);
    };
    const read = await readSegments(spy, newTracker());
    assert.ok(read.ok);
    assert.equal(read.data.length, 1_201);
    assert.equal(paths.length, 3);

    paths.length = 0;
    const result = await runScan(spy, { config });
    assert.ok(result.ok);
    const filterCalls = paths.filter((p) => p.includes("includeFilters=true"));
    assert.equal(filterCalls.length, 7, "601 active segments in batches of 100");
    assert.ok(filterCalls.every((p) => (p.match(/listIds=/g)?.length ?? 0) <= 100));
  });
});
