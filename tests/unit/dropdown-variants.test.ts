import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkDropdownVariants } from "@/lib/checks/properties/dropdown-variants";
import { dropdown } from "./fixtures";

const DEFINITE = "properties.dropdown-variants";
const PLURAL = "properties.dropdown-plural-variants";

const byId = (findings: ReturnType<typeof checkDropdownVariants>, checkId: string) =>
  findings.find((f) => f.checkId === checkId);

describe("dropdown-variants", () => {
  // Regression: the brief's own example must always be caught.
  it("flags Webinar / webinar / WEBINAR as a definite, high-severity variant", () => {
    const findings = checkDropdownVariants("contacts", [
      dropdown("event_type", ["Webinar", "webinar", "WEBINAR", "Conference"]),
    ]);
    const definite = byId(findings, DEFINITE);
    assert.ok(definite, "expected a definite finding");
    assert.equal(definite.severity, "high");
    assert.equal(definite.count, 1);
    assert.equal(definite.samples[0], "event_type: Webinar / webinar / WEBINAR");
  });

  it("treats spacing and punctuation as the same option", () => {
    const findings = checkDropdownVariants("companies", [
      dropdown("source", ["Trade Show", "Tradeshow", "Re-seller", "Reseller"]),
    ]);
    assert.equal(byId(findings, DEFINITE)?.count, 2);
  });

  it("flags singular/plural pairs as possible, medium severity", () => {
    const findings = checkDropdownVariants("deals", [
      dropdown("product_line", ["Adhesive", "Adhesives", "Box", "Boxes", "Category", "Categories"]),
    ]);
    const plural = byId(findings, PLURAL);
    assert.ok(plural, "expected a plural finding");
    assert.equal(plural.severity, "medium");
    assert.equal(plural.count, 3);
    assert.equal(byId(findings, DEFINITE), undefined);
  });

  // Regression: edit distance 1 flagged real different words on the first scan.
  it("does not flag different words a letter apart (Japanese / Javanese)", () => {
    const findings = checkDropdownVariants("contacts", [
      dropdown("language", ["Japanese", "Javanese", "Dining", "Mining", "Horses", "Hoses"]),
    ]);
    assert.deepEqual(findings, []);
  });

  it("skips HubSpot-defined, archived and externally sourced dropdowns", () => {
    const findings = checkDropdownVariants("contacts", [
      dropdown("hs_lead_status", ["New", "new"], { hubspotDefined: true }),
      dropdown("old_list", ["New", "new"], { archived: true }),
      dropdown("owner_like", ["New", "new"], { externalOptions: true }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("does not flag a clean dropdown", () => {
    const findings = checkDropdownVariants("deals", [
      dropdown("status", ["Open", "Closed", "Pending"]),
    ]);
    assert.deepEqual(findings, []);
  });
});
