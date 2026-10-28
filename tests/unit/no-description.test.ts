import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkNoDescription } from "@/lib/checks/properties/no-description";
import { CHECKS_CONFIG } from "@/config/checks";
import { prop } from "./fixtures";

describe("no-description", () => {
  it("flags custom properties with an empty or blank description", () => {
    const findings = checkNoDescription("contacts", [
      prop({ name: "empty", description: "" }),
      prop({ name: "blank", description: "   " }),
      prop({ name: "described" }),
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].checkId, "properties.no-description");
    assert.equal(findings[0].severity, "low");
    assert.equal(findings[0].count, 2);
    assert.deepEqual(findings[0].samples, ["empty", "blank"]);
  });

  it("ignores HubSpot-defined and archived properties", () => {
    const findings = checkNoDescription("contacts", [
      prop({ name: "firstname", description: "", hubspotDefined: true }),
      prop({ name: "old_field", description: "", archived: true }),
    ]);
    assert.deepEqual(findings, []);
  });

  it("caps samples at the configured limit but counts everything", () => {
    const props = Array.from({ length: 15 }, (_, i) => prop({ name: `p${i}`, description: "" }));
    const [real] = checkNoDescription("contacts", props);
    assert.equal(real.count, 15);
    assert.equal(real.samples.length, CHECKS_CONFIG.sampleCap);

    const [custom] = checkNoDescription("contacts", props, { ...CHECKS_CONFIG, sampleCap: 3 });
    assert.equal(custom.samples.length, 3);
  });

  it("keeps every affected property for the playbook, up to the work-list cap", () => {
    const props = Array.from({ length: 15 }, (_, i) => prop({ name: `p${i}`, description: "" }));
    const [real] = checkNoDescription("contacts", props);
    assert.deepEqual(real.items, props.map((p) => p.name));

    const capped = { ...CHECKS_CONFIG, records: { ...CHECKS_CONFIG.records, workListCap: 4 } };
    const [custom] = checkNoDescription("contacts", props, capped);
    assert.deepEqual(custom.items, ["p0", "p1", "p2", "p3"]);
  });
});
