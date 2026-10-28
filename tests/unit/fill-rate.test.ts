import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import { checkFillRate, fillRateCandidates } from "@/lib/checks/properties/fill-rate";
import { NOW, daysAgo, prop } from "./fixtures";

const names = (props: { name: string }[]) => props.map((p) => p.name);

describe("fill-rate candidates", () => {
  // The real 30-day rule, using the app's own config.
  it("skips properties 29 days old and measures ones 31 days old", () => {
    assert.equal(CHECKS_CONFIG.fillRate.minAgeDays, 30);
    const candidates = fillRateCandidates(
      [
        prop({ name: "young", createdAt: daysAgo(29) }),
        prop({ name: "old", createdAt: daysAgo(31) }),
      ],
      NOW,
    );
    assert.deepEqual(names(candidates), ["old"]);
  });

  it("measures properties with no creation date rather than skipping them", () => {
    const candidates = fillRateCandidates([prop({ name: "undated", createdAt: null })], NOW);
    assert.deepEqual(names(candidates), ["undated"]);
  });

  it("skips HubSpot-defined, calculated and formula properties", () => {
    const candidates = fillRateCandidates(
      [
        prop({ name: "firstname", hubspotDefined: true }),
        prop({ name: "calc", calculated: true }),
        prop({ name: "formula", hasFormula: true }),
        prop({ name: "plain" }),
      ],
      NOW,
    );
    assert.deepEqual(names(candidates), ["plain"]);
  });

  it("accepts a test config without changing the real rule", () => {
    const props = [prop({ name: "brand_new", createdAt: daysAgo(0) })];
    const testConfig = { ...CHECKS_CONFIG, fillRate: { ...CHECKS_CONFIG.fillRate, minAgeDays: 0 } };

    assert.deepEqual(names(fillRateCandidates(props, NOW, testConfig)), ["brand_new"]);
    assert.deepEqual(names(fillRateCandidates(props, NOW)), []);
    assert.equal(CHECKS_CONFIG.fillRate.minAgeDays, 30);
  });
});

describe("fill-rate check", () => {
  const candidates = [prop({ name: "empty" }), prop({ name: "rare" }), prop({ name: "used" })];

  it("flags properties filled on under 1% of records, lowest first", () => {
    const filled = new Map([
      ["empty", 0],
      ["rare", 9],
      ["used", 500],
    ]);
    const [finding] = checkFillRate("contacts", candidates, filled, 1000);
    assert.equal(finding.checkId, "properties.near-zero-fill");
    assert.equal(finding.severity, "medium");
    assert.equal(finding.count, 2);
    assert.deepEqual(finding.samples, ["empty (0.00%)", "rare (0.90%)"]);
  });

  it("does not flag a property at exactly 1%", () => {
    const filled = new Map([["rare", 10]]);
    assert.deepEqual(checkFillRate("contacts", candidates, filled, 1000), []);
  });

  it("returns nothing when the object has no records", () => {
    const filled = new Map([["empty", 0]]);
    assert.deepEqual(checkFillRate("contacts", candidates, filled, 0), []);
  });

  it("skips properties whose count couldn't be measured", () => {
    const [finding] = checkFillRate("contacts", candidates, new Map([["empty", 0]]), 1000);
    assert.deepEqual(finding.samples, ["empty (0.00%)"]);
  });
});
