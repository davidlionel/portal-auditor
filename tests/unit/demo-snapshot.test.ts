import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import { prepareDemo } from "@/lib/demo/load";
import { validateSnapshot, type DemoSnapshot } from "@/lib/demo/snapshot";
import { scoreChecks } from "@/lib/scoring";
import { runScan } from "@/lib/scan";
import { SIZE_SMALL } from "@/lib/simulator/portal";
import { simulatorTransport } from "@/lib/simulator/transport";

console.info = () => {};

// A full report from the small simulated portal: the same shape a real scan
// produces, with findings, samples and work lists.
let clean: DemoSnapshot;
before(async () => {
  const result = await runScan(simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport, {
    config: { ...CHECKS_CONFIG, searchMinIntervalMs: 0 },
  });
  assert.ok(result.ok);
  clean = { scannedAt: "2026-10-28T14:00:00.000Z", appVersion: "0.1.0", report: result.report };
});

// A deep copy to plant a problem in.
const copy = (): DemoSnapshot => structuredClone(clean);

describe("validateSnapshot", () => {
  it("accepts a real report: IDs, property names, counts and portal details", () => {
    assert.deepEqual(validateSnapshot(clean), []);
    assert.ok(clean.report.findings.some((f) => f.records?.length), "fixture has work lists");
    assert.ok(clean.report.findings.some((f) => f.samples.length), "fixture has property samples");
  });

  it("rejects an email address anywhere", () => {
    const s = copy();
    s.report.findings[0].samples.push("ana@gmial.com");
    assert.match(validateSnapshot(s).join("\n"), /email address/);
  });

  it("rejects a phone number", () => {
    const s = copy();
    s.report.notes.push("Call (415) 555-0142");
    assert.match(validateSnapshot(s).join("\n"), /phone number/);
  });

  it("rejects record values in a work list", () => {
    const s = copy();
    const finding = s.report.findings.find((f) => f.records?.length)!;
    (finding.records![0] as Record<string, unknown>).firstname = "Maria";
    assert.match(validateSnapshot(s).join("\n"), /unexpected field "firstname"/);
  });

  it("rejects a record ID that isn't an ID", () => {
    const s = copy();
    const finding = s.report.findings.find((f) => f.recordSamples?.length)!;
    finding.recordSamples![0][0] = "Maria Lopez";
    assert.match(validateSnapshot(s).join("\n"), /non-ID value/);
  });

  it("rejects unexpected fields on the report or portal", () => {
    const s = copy();
    (s.report as Record<string, unknown>).rows = [];
    (s.report.portal as Record<string, unknown>).ownerEmail = "x";
    const errors = validateSnapshot(s).join("\n");
    assert.match(errors, /report has an unexpected field "rows"/);
    assert.match(errors, /report.portal has an unexpected field "ownerEmail"/);
  });

  it("rejects a simulated report and a portal that isn't a developer test portal", () => {
    const s = copy();
    s.report.simulated = true;
    s.report.portal.accountType = "STANDARD";
    const errors = validateSnapshot(s).join("\n");
    assert.match(errors, /simulator/);
    assert.match(errors, /STANDARD account/);
  });

  it("rejects a missing or invalid scan date", () => {
    const s = copy();
    s.scannedAt = "yesterday";
    assert.match(validateSnapshot(s).join("\n"), /scannedAt is not a date/);
  });
});

describe("prepareDemo", () => {
  it("re-scores the snapshot with the current scoring config", () => {
    const s = copy();
    s.report.score = { ...s.report.score, overall: 3, explanation: "old weights" };
    const demo = prepareDemo(s);
    assert.ok(demo.ok);
    assert.deepEqual(demo.report.score, scoreChecks(clean.report.checks));
    assert.equal(demo.scannedAt, clean.scannedAt);
  });

  it("refuses to show a snapshot that fails the safety check", () => {
    const s = copy();
    s.report.notes.push("owner: ana@example.com");
    const demo = prepareDemo(s);
    assert.equal(demo.ok, false);
    assert.match(!demo.ok ? demo.reason : "", /safety check/);
  });
});
