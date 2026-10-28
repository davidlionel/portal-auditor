import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import { COUNT_CHECKS, countCheckTitle, countFinding } from "@/lib/checks/records/count-checks";
import { DAY_MS, NOW } from "./fixtures";

const check = (checkId: string) => {
  const found = COUNT_CHECKS.find((c) => c.checkId === checkId);
  assert.ok(found, `no count check ${checkId}`);
  return found;
};

describe("count check filters", () => {
  it("stay within HubSpot's Search limits (5 groups, 6 filters each, 18 total)", () => {
    for (const c of COUNT_CHECKS) {
      const groups = c.filterGroups(NOW, CHECKS_CONFIG);
      assert.ok(groups.length >= 1 && groups.length <= 5, c.checkId);
      for (const g of groups) assert.ok(g.filters.length <= 6, c.checkId);
      assert.ok(groups.flatMap((g) => g.filters).length <= 18, c.checkId);
    }
  });

  it("list every property they filter on as required", () => {
    for (const c of COUNT_CHECKS) {
      const used = new Set(c.filterGroups(NOW, CHECKS_CONFIG).flatMap((g) => g.filters.map((f) => f.propertyName)));
      assert.deepEqual([...used].sort(), [...c.requiredProps].sort(), c.checkId);
      for (const f of (c.populationFilterGroups?.() ?? []).flatMap((g) => g.filters)) {
        assert.ok(c.requiredProps.includes(f.propertyName), `${c.checkId} population uses ${f.propertyName}`);
      }
    }
  });

  it("measure subset checks against the subset, not every record", () => {
    assert.deepEqual(check("contacts.customer-without-won-deal").populationFilterGroups?.(), [
      { filters: [{ propertyName: "lifecyclestage", operator: "EQ", value: "customer" }] },
    ]);
    const open = [{ filters: [{ propertyName: "hs_is_closed", operator: "EQ", value: "false" }] }];
    assert.deepEqual(check("deals.missing-close-date").populationFilterGroups?.(), open);
    assert.deepEqual(check("deals.stale").populationFilterGroups?.(), open);
    assert.equal(check("deals.missing-amount").populationFilterGroups?.().length, 2);
    assert.equal(check("contacts.missing-email").populationFilterGroups, undefined);
  });

  it("missing lifecycle stage is a single NOT_HAS_PROPERTY filter", () => {
    assert.deepEqual(check("contacts.missing-lifecycle-stage").filterGroups(NOW, CHECKS_CONFIG), [
      { filters: [{ propertyName: "lifecyclestage", operator: "NOT_HAS_PROPERTY" }] },
    ]);
  });

  it("customer conflict needs both the stage and no won-deal date", () => {
    assert.deepEqual(check("contacts.customer-without-won-deal").filterGroups(NOW, CHECKS_CONFIG), [
      {
        filters: [
          { propertyName: "lifecyclestage", operator: "EQ", value: "customer" },
          { propertyName: "recent_deal_close_date", operator: "NOT_HAS_PROPERTY" },
        ],
      },
    ]);
  });

  it("missing amount covers open and won deals but not lost ones", () => {
    const groups = check("deals.missing-amount").filterGroups(NOW, CHECKS_CONFIG);
    assert.deepEqual(groups, [
      {
        filters: [
          { propertyName: "amount", operator: "NOT_HAS_PROPERTY" },
          { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
        ],
      },
      {
        filters: [
          { propertyName: "amount", operator: "NOT_HAS_PROPERTY" },
          { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
        ],
      },
    ]);
  });

  it("missing close date only looks at open deals", () => {
    const [group] = check("deals.missing-close-date").filterGroups(NOW, CHECKS_CONFIG);
    assert.deepEqual(group.filters[1], { propertyName: "hs_is_closed", operator: "EQ", value: "false" });
  });

  it("companies with no contacts match a zero count or an empty count", () => {
    assert.equal(check("companies.no-contacts").filterGroups(NOW, CHECKS_CONFIG).length, 2);
  });

  it("stale deals use the configured number of days before now", () => {
    const stale = check("deals.stale");
    const cutoff = (days: number) =>
      stale.filterGroups(NOW, { ...CHECKS_CONFIG, records: { ...CHECKS_CONFIG.records, staleDealDays: days } })[0]
        .filters[1];

    assert.equal(CHECKS_CONFIG.records.staleDealDays, 30);
    assert.deepEqual(stale.filterGroups(NOW, CHECKS_CONFIG)[0].filters[1], {
      propertyName: "hs_v2_date_entered_current_stage",
      operator: "LT",
      value: String(NOW - 30 * DAY_MS),
    });
    assert.equal(cutoff(90).value, String(NOW - 90 * DAY_MS));
  });

  it("stale deal titles name the configured period", () => {
    const config = { ...CHECKS_CONFIG, records: { ...CHECKS_CONFIG.records, staleDealDays: 45 } };
    assert.equal(countCheckTitle(check("deals.stale"), config), "Open deals with no stage change in 45+ days");
  });
});

describe("countFinding", () => {
  const lifecycle = check("contacts.missing-lifecycle-stage");

  it("returns nothing when no records match", () => {
    assert.deepEqual(countFinding(lifecycle, { total: 0, population: 100, ids: [] }), []);
  });

  it("uses the Search total as the count and the results as samples", () => {
    const [finding] = countFinding(lifecycle, { total: 2500, population: 250_000, ids: ["101", "102"] });
    assert.equal(finding.count, 2500);
    assert.equal(finding.affected, 2500);
    assert.equal(finding.population, 250_000);
    assert.equal(finding.category, "Contacts");
    assert.deepEqual(finding.recordSamples, [["101"], ["102"]]);
  });

  it("caps samples at the sample limit and the work list at the work-list limit", () => {
    const ids = Array.from({ length: 15 }, (_, i) => String(i));
    const config = { ...CHECKS_CONFIG, records: { ...CHECKS_CONFIG.records, workListCap: 12 } };
    const [finding] = countFinding(lifecycle, { total: 4512, population: 9000, ids }, config);
    assert.equal(finding.recordSamples?.length, CHECKS_CONFIG.sampleCap);
    assert.equal(finding.records?.length, 12);
    assert.deepEqual(finding.records?.[0], { id: "0" });
  });

  it("defaults the work list to 1,000 records per check", () => {
    assert.equal(CHECKS_CONFIG.records.workListCap, 1000);
  });
});
