import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { CHECK_GUIDES, GUIDANCE, IMPORT_STEPS, IMPORT_STEP_IDS, type GuidanceEntry, type GuidanceId } from "@/config/hubspot-guidance";
import { SCORING_CONFIG } from "@/config/scoring";
import type { Finding } from "@/lib/checks/types";
import { ALL_CSV_COLUMNS, buildPlaybook, longDate, type Playbook } from "@/lib/playbook/build";
import { COLUMN_NOTES, exportFiles } from "@/lib/playbook/files";
import type { ScanReport } from "@/lib/scan";
import { topFixes } from "@/lib/scoring";
import { EMAIL_PATTERN, PHONE_PATTERN, simulatedReport } from "./simulated-report";

console.info = () => {};

let report: ScanReport;
let recordValues: string[];
let playbook: Playbook;
// The finding behind each section, in section order.
let ordered: Finding[];
before(async () => {
  ({ report, recordValues } = await simulatedReport());
  playbook = buildPlaybook(report);
  ordered = topFixes(report.findings, report.score, { ...SCORING_CONFIG, topFixes: Infinity }).map((t) => t.finding);
});

// Every string anywhere in a value.
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

describe("buildPlaybook: cover", () => {
  it("shows the portal, scan date, scores and the report's Top 5", () => {
    assert.match(playbook.portal, new RegExp(`Hub ID ${report.portal.portalId}`));
    assert.equal(playbook.scanDate, longDate(report.scannedAt));
    assert.equal(playbook.overall, Math.round(report.score.overall!));
    assert.deepEqual(playbook.categories.map((c) => c.category), ["Properties", "Contacts", "Companies", "Deals"]);
    const top = topFixes(report.findings, report.score);
    assert.deepEqual(playbook.topFixes.map((t) => t.points), top.map((t) => t.points));
    assert.equal(playbook.topFixes.length, Math.min(5, report.findings.length));
  });

  it("dates the HubSpot steps with the oldest lastVerified among the entries it uses", () => {
    const used = new Set<GuidanceId>(IMPORT_STEP_IDS);
    for (const f of report.findings) {
      const guide = CHECK_GUIDES[f.checkId];
      for (const id of [...guide.steps, ...(guide.prevent ?? []), ...(guide.csv === "import" ? IMPORT_STEP_IDS : [])]) used.add(id);
      for (const c of guide.filter ?? []) {
        used.add(c.property);
        used.add(c.operator);
        if (c.value && c.value in GUIDANCE) used.add(c.value as GuidanceId);
      }
    }
    const oldest = [...used].map((id) => GUIDANCE[id].lastVerified).sort()[0];
    assert.equal(playbook.verifiedOn, longDate(oldest));
  });
});

describe("buildPlaybook: sections", () => {
  it("has one numbered section per finding, biggest score gain first", () => {
    assert.equal(playbook.sections.length, report.findings.length);
    playbook.sections.forEach((s, i) => assert.equal(s.number, i + 1));
    const points = playbook.sections.map((s) => s.points);
    assert.deepEqual(points, [...points].sort((a, b) => b - a));
  });

  it("gives every section why it matters, steps and at least one source link", () => {
    const sources = new Set(Object.values(GUIDANCE as Record<string, GuidanceEntry>).map((e) => e.source));
    for (const s of playbook.sections) {
      assert.ok(s.why && s.rate && s.steps.length, s.title);
      assert.ok(s.sources.length > 0, `${s.title}: no source`);
      for (const url of s.sources) assert.ok(sources.has(url), `${s.title}: ${url}`);
    }
  });

  it('says "No CSV needed" and gives the filter when a HubSpot filter finds every record', () => {
    playbook.sections.forEach((s, i) => {
      const guide = CHECK_GUIDES[ordered[i].checkId];
      if (guide.csv === "import") {
        assert.doesNotMatch(s.csv, /No CSV needed/, s.title);
        assert.equal(s.filter.length, 0, s.title);
      } else {
        assert.match(s.csv, /^No CSV needed/, s.title);
      }
      if (guide.csv === "none") assert.ok(s.filter.length > 0, `${s.title}: needs a filter`);
    });
  });

  it("writes filters with HubSpot's property and operator names", () => {
    const stale = playbook.sections.find((s) => s.title.startsWith("Open deals with no stage change"));
    assert.ok(stale, "simulated portal has stale deals");
    assert.deepEqual(stale.filter, [
      "Date entered current stage is more than 30 days ago",
      "Deal stage is none of Closed won, Closed lost (and any other closed stages in your pipelines)",
    ]);
    assert.ok(stale.steps.some((step) => /Deal owner/.test(step.text)), "stale deals say how to split work by owner");
    const lifecycle = playbook.sections.find((s) => s.title === "Contacts with no lifecycle stage");
    assert.deepEqual(lifecycle?.filter, ["Lifecycle stage is unknown"]);
  });

  it("points import sections at a file that is in the export and fills in the object", () => {
    const paths = new Set(exportFiles(report).map((f) => f.path));
    const imports = playbook.sections.filter((s) => /^Use imports\//.test(s.csv));
    assert.ok(imports.length >= 2, "simulated portal has duplicates and typo emails");
    for (const s of imports) assert.ok(paths.has(s.csv.match(/^Use (\S+)/)![1]), s.csv);
    for (const s of playbook.sections) for (const step of s.steps) assert.doesNotMatch(step.text, /\{object\}/);
  });

  it("lists every affected property in property sections", () => {
    const props = playbook.sections.filter((s) => s.category === "Properties");
    assert.ok(props.length > 0);
    for (const s of props) assert.ok(s.items.length > 0, s.title);
  });

  it("has stale deals reviewed one by one with their owner, never bulk-edited", () => {
    assert.ok(!CHECK_GUIDES["deals.stale"].steps.includes("bulkEdit"));
    const stale = playbook.sections.find((s) => s.title.startsWith("Open deals with no stage change"))!;
    const texts = stale.steps.map((s) => s.text);
    assert.ok(!texts.some((t) => /Select the records, then click Edit/.test(t)), "no bulk-edit step");
    const review = stale.steps.find((s) => /Review each deal with its owner/.test(s.text));
    assert.ok(review, "has the review step");
    assert.match(review.text, /move it forward/);
    assert.match(review.text, /close it as lost/);
    assert.match(review.text, /update its close date/);
    assert.ok(review.general, "labelled as general guidance");
  });

  it("never suggests changing deal stages in bulk", () => {
    for (const s of playbook.sections) {
      for (const step of [...s.steps, ...s.prevent]) {
        const bulk = /Select the records|in bulk|all of them/i.test(step.text);
        assert.ok(!(bulk && /stage/i.test(step.text) && !/Don't change deal stages in bulk/.test(step.text)), `${s.title}: ${step.text}`);
      }
    }
  });

  it("names the right association card for each check", () => {
    const companies = playbook.sections.find((s) => s.title === "Companies with no associated contacts")!;
    const customers = playbook.sections.find((s) => s.title === "Customers with no closed-won deal")!;
    const card = (s: typeof companies) => s.steps.map((x) => x.text).join(" ").match(/\+ Add in the (\w+) association card/)?.[1];
    assert.equal(card(companies), "Contacts");
    assert.equal(card(customers), "Deals");
    for (const s of playbook.sections) for (const step of s.steps) assert.doesNotMatch(step.text, /matching association card|for example Deals/);
  });

  it("marks general guidance", () => {
    const typos = playbook.sections.find((s) => s.title === "Contacts with a malformed or mistyped email");
    assert.ok(typos?.steps.some((step) => step.general));
    assert.ok(playbook.sections.flatMap((s) => s.steps).some((step) => !step.general));
  });
});

describe("buildPlaybook: appendix", () => {
  it("describes every CSV in the export, column by column", () => {
    assert.deepEqual(playbook.files.map((f) => f.path), exportFiles(report).map((f) => f.path));
    for (const file of playbook.files) {
      assert.ok(file.columns.length > 0);
      for (const column of file.columns) assert.ok(column.note, `${file.path}: ${column.name} has no description`);
    }
    for (const column of ALL_CSV_COLUMNS) assert.ok(COLUMN_NOTES[column], `${column} has no description`);
  });

  it("gives each file's Cleanup reason example from that file's own checks", () => {
    for (const file of playbook.files) {
      const note = file.columns.find((c) => c.name === "Cleanup reason")?.note;
      if (!note) continue;
      const example = note.match(/e\.g\. "Portal audit \d{4}-\d{2}-\d{2}: ([^"]+)"/)?.[1];
      assert.ok(example, `${file.path}: no example`);
      const finding = report.findings.find((f) => f.title === example);
      assert.ok(finding, `${file.path}: "${example}" isn't a finding`);
      if (file.path.startsWith("imports/")) {
        assert.equal(file.path, `imports/${finding.checkId.replace(/[^a-z0-9]+/gi, "-")}.csv`, `${file.path} uses another check's name`);
      } else {
        assert.ok(file.path.endsWith(`-work-list-${finding.objectType}.csv`), `${file.path} uses another object's check`);
      }
    }
    assert.ok(!playbook.files.some((f) => f.path.startsWith("imports/contacts-duplicate") && f.columns.some((c) => /Contacts with no email address/.test(c.note))));
  });

  it("gives the import steps and their sources", () => {
    assert.equal(playbook.importSteps.length, IMPORT_STEPS.length);
    assert.equal(playbook.importSteps.length, 6);
    const last = playbook.importSteps.at(-1)!.text;
    assert.match(last, /Create new property/);
    assert.match(last, /Single-line text/);
    assert.ok(playbook.importSteps.some((s) => /Update existing records only/.test(s.text)));
    assert.ok(playbook.importSteps.some((s) => /Create a contact segment/.test(s.text)));
    assert.ok(playbook.importSteps.some((s) => /Cleanup reason/.test(s.text)));
    assert.ok(playbook.importSources.length > 0);
  });
});

describe("buildPlaybook: privacy", () => {
  it("never contains a record name, email or phone number", () => {
    assert.ok(recordValues.length > 1000, "the scan read record values");
    const text = strings(playbook).join("\n");
    for (const value of recordValues) assert.ok(!text.includes(value), `record value "${value}" in the playbook`);
    assert.doesNotMatch(text, EMAIL_PATTERN);
    assert.doesNotMatch(text, PHONE_PATTERN);
  });
});
