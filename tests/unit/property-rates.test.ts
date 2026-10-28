import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDropdownVariants, dropdownPopulation } from "@/lib/checks/properties/dropdown-variants";
import { checkDuplicateLabels } from "@/lib/checks/properties/duplicate-labels";
import { checkFillRate, fillRatePopulation } from "@/lib/checks/properties/fill-rate";
import { checkNoDescription } from "@/lib/checks/properties/no-description";
import { dropdown, prop } from "./fixtures";

describe("property check rates", () => {
  it("no description: properties without one, out of all custom properties", () => {
    const props = [
      prop({ name: "a", description: "" }),
      prop({ name: "b" }),
      prop({ name: "c" }),
      prop({ name: "hs_x", description: "", hubspotDefined: true }),
    ];
    const [f] = checkNoDescription("contacts", props);
    assert.equal(f.affected, 1);
    assert.equal(f.population, 3);
  });

  it("dropdown variants: properties with a problem, out of custom dropdowns with 2+ options", () => {
    const props = [
      dropdown("source", ["Webinar", "webinar", "WEBINAR", "Trade Show", "Tradeshow"]),
      dropdown("region", ["North", "South"]),
      dropdown("single", ["Only"]),
      prop({ name: "text" }),
    ];
    assert.equal(dropdownPopulation(props), 2);
    const [f] = checkDropdownVariants("contacts", props);
    assert.equal(f.count, 2, "the report counts variant groups");
    assert.equal(f.affected, 1, "the score counts properties");
    assert.equal(f.population, 2);
  });

  it("duplicate labels: custom properties involved, out of live custom properties", () => {
    const props = [
      prop({ name: "lead_source_1", label: "Lead Source" }),
      prop({ name: "lead_source_2", label: "lead source" }),
      prop({ name: "other" }),
      prop({ name: "old", archived: true }),
    ];
    const [f] = checkDuplicateLabels("contacts", props);
    assert.equal(f.affected, 2);
    assert.equal(f.population, 3);
  });

  it("fill rate: near-empty properties, out of those actually measured", () => {
    const candidates = [prop({ name: "a" }), prop({ name: "b" }), prop({ name: "c" })];
    const filled = new Map([
      ["a", 0],
      ["b", 500],
    ]);
    assert.equal(fillRatePopulation(candidates, filled), 2);
    const [f] = checkFillRate("contacts", candidates, filled, 1000);
    assert.equal(f.affected, 1);
    assert.equal(f.population, 2);
  });
});
