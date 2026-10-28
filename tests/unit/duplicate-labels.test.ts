import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDuplicateLabels } from "@/lib/checks/properties/duplicate-labels";
import { prop } from "./fixtures";

const byId = (findings: ReturnType<typeof checkDuplicateLabels>, checkId: string) =>
  findings.find((f) => f.checkId === checkId);

describe("duplicate-labels", () => {
  it("flags labels that match once case, spacing and punctuation are ignored", () => {
    const findings = checkDuplicateLabels("contacts", [
      prop({ name: "lead_source_test", label: "Lead Source Test" }),
      prop({ name: "lead_source_test_2", label: "lead source-test" }),
    ]);
    const exact = byId(findings, "properties.duplicate-labels");
    assert.ok(exact, "expected an exact-duplicate finding");
    assert.equal(exact.count, 1);
    assert.match(exact.samples[0], /lead_source_test .*lead_source_test_2/);
  });

  it("flags a custom property that copies a HubSpot-defined label", () => {
    const findings = checkDuplicateLabels("contacts", [
      prop({ name: "hs_language", label: "Preferred language", hubspotDefined: true }),
      prop({ name: "preferred_language", label: "Preferred Language" }),
    ]);
    assert.ok(byId(findings, "properties.duplicate-labels"));
  });

  it("does not flag two HubSpot-defined properties sharing a label", () => {
    const findings = checkDuplicateLabels("contacts", [
      prop({ name: "a", label: "Owner", hubspotDefined: true }),
      prop({ name: "b", label: "Owner", hubspotDefined: true }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("flags near-identical labels a typo apart", () => {
    const findings = checkDuplicateLabels("contacts", [
      prop({ name: "contact_method", label: "Preferred Contact Method" }),
      prop({ name: "contact_method_2", label: "Prefered Contact Method" }),
    ]);
    const near = byId(findings, "properties.near-duplicate-labels");
    assert.ok(near, "expected a near-duplicate finding");
    assert.equal(near.count, 1);
  });

  // Regression: numbered series are intentional, not typos.
  it("does not flag Region 1 / Region 2", () => {
    const findings = checkDuplicateLabels("companies", [
      prop({ name: "region_1", label: "Sales Region 1" }),
      prop({ name: "region_2", label: "Sales Region 2" }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("does not run edit distance on short labels", () => {
    const findings = checkDuplicateLabels("deals", [
      prop({ name: "tier", label: "Tier A" }),
      prop({ name: "tear", label: "Tear A" }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("ignores archived properties", () => {
    const findings = checkDuplicateLabels("contacts", [
      prop({ name: "a", label: "Lead Source" }),
      prop({ name: "b", label: "Lead Source", archived: true }),
    ]);
    assert.deepEqual(findings, []);
  });
});
