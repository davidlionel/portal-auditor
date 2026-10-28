import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { extractText, getDocumentProxy } from "unpdf";
import { CHECK_GUIDES, GUIDANCE } from "@/config/hubspot-guidance";
import { buildPlaybook, type Playbook } from "@/lib/playbook/build";
import { COLUMN_NOTES } from "@/lib/playbook/files";
import { INK, MUTED, PRINTABLE, RULE, TABLE_LAYOUTS, loadPdfmake, playbookDocument, printable, renderPlaybookPdf } from "@/lib/playbook/pdf";
import type { ScanReport } from "@/lib/scan";
import { EMAIL_PATTERN, PHONE_PATTERN, simulatedReport } from "./simulated-report";

console.info = () => {};

// The PDF's text with line wraps flattened, so wrapped sentences still match.
async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const { totalPages, text } = await extractText(await getDocumentProxy(bytes.slice()), { mergePages: true });
  return { pages: totalPages, text: text.replace(/\s+/g, " ") };
}
const flat = (s: string) => s.replace(/\s+/g, " ");

let report: ScanReport;
let recordValues: string[];
let playbook: Playbook;
let bytes: Uint8Array;
let pdf: { pages: number; text: string };
before(async () => {
  ({ report, recordValues } = await simulatedReport());
  playbook = buildPlaybook(report);
  bytes = await renderPlaybookPdf(playbook);
  pdf = await pdfText(bytes);
});

describe("playbook PDF", () => {
  it("is a real PDF with a cover, sections and appendices", () => {
    assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
    assert.ok(pdf.pages >= 4, `${pdf.pages} pages`);
  });

  it("has the cover: portal, scan date, scores, Top 5 and the verified date", () => {
    assert.ok(pdf.text.includes("Cleanup playbook"));
    assert.ok(pdf.text.includes(playbook.portal));
    assert.ok(pdf.text.includes(`Scanned ${playbook.scanDate}`));
    assert.ok(pdf.text.includes(`Health score: ${playbook.overall} / 100`));
    for (const c of playbook.categories) assert.ok(pdf.text.includes(`${c.category} ${c.score} / 100`), c.category);
    for (const f of playbook.topFixes) assert.ok(pdf.text.includes(`+${f.points.toFixed(1)} pts`), f.title);
    assert.ok(pdf.text.includes(`HubSpot steps verified against HubSpot's documentation on ${playbook.verifiedOn}.`));
  });

  it("has every section with its filter, CSV advice and source links", () => {
    for (const s of playbook.sections) {
      assert.ok(pdf.text.includes(flat(`${s.number}. ${s.title}`)), s.title);
      for (const condition of s.filter) assert.ok(pdf.text.includes(flat(condition)), condition);
      for (const url of s.sources) assert.ok(pdf.text.includes(url), url);
    }
    const noCsv = playbook.sections.filter((s) => s.csv.startsWith("No CSV needed")).length;
    assert.equal(pdf.text.match(/No CSV needed/g)?.length, noCsv);
    assert.ok(noCsv > 0 && noCsv < playbook.sections.length);
  });

  it("keeps each section's CSV advice and sources on one page", async () => {
    const pages = (await extractText(await getDocumentProxy(bytes.slice()), { mergePages: false })).text.map(flat);
    // Walk the sections in order through the page texts.
    let page = 0;
    let at = 0;
    const find = (needle: string) => {
      for (; page < pages.length; page++, at = 0) {
        const i = pages[page].indexOf(needle, at);
        if (i >= 0) {
          at = i + needle.length;
          return page;
        }
      }
      assert.fail(`"${needle}" not found in order`);
    };
    for (const s of playbook.sections) {
      find(flat(`${s.number}. ${s.title}`));
      const csvPage = find("CSV");
      let last = csvPage;
      for (const url of s.sources) last = find(url);
      assert.equal(last, csvPage, `${s.title}: sources split from the CSV block`);
    }
  });

  it("labels general guidance", () => {
    assert.ok(pdf.text.includes("General guidance (not from HubSpot's documentation):"));
  });

  it("has both appendices: every CSV column and the import steps", () => {
    assert.ok(pdf.text.includes("Appendix A: The CSV files"));
    assert.ok(pdf.text.includes("Appendix B: Importing a file by Record ID"));
    for (const file of playbook.files) assert.ok(pdf.text.includes(file.path), file.path);
    // pdf.js extracts a numbered item's number at the end of its first line
    // ("...upper1. right..."), so drop numbers glued to words before matching.
    const unnumbered = pdf.text.replace(/(\S)\d{1,2}\.(?= )/g, "$1");
    for (const step of playbook.importSteps) assert.ok(unnumbered.includes(flat(step.text)), step.text);
  });

  it("never contains a record name, email or phone number", () => {
    for (const value of recordValues) assert.ok(!pdf.text.includes(value), `record value "${value}" in the PDF`);
    assert.doesNotMatch(pdf.text, EMAIL_PATTERN);
    assert.doesNotMatch(pdf.text, PHONE_PATTERN);
  });

  it("marks the sample on the cover", async () => {
    const sample = await pdfText(await renderPlaybookPdf(buildPlaybook(report, { sample: true })));
    assert.ok(sample.text.includes("Sample: a scan of a HubSpot developer test portal with synthetic data."));
    assert.ok(!pdf.text.includes("Sample: a scan"));
  });
});

describe("black and white", () => {
  it("uses only black and greys", () => {
    const greys = new Set([INK, MUTED, RULE]);
    for (const colour of greys) {
      const [r, g, b] = [1, 3, 5].map((i) => colour.slice(i, i + 2));
      assert.ok(r === g && g === b, `${colour} is not a grey`);
    }
    const seen: string[] = [];
    (function walk(value: unknown, key = "") {
      if (typeof value === "string" && /colou?r$/i.test(key)) seen.push(value);
      else if (Array.isArray(value)) value.forEach((v) => walk(v));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
    })(playbookDocument(playbook));
    assert.ok(seen.length > 0);
    for (const colour of seen) assert.ok(greys.has(colour), `colour ${colour}`);
    assert.equal(TABLE_LAYOUTS.blackLines.hLineColor(), INK);
    assert.equal(TABLE_LAYOUTS.blackLines.vLineColor(), INK);
  });
});

describe("printable text", () => {
  it("draws every character it allows", async () => {
    const allowed: string[] = [];
    for (let c = 0x20; c < 0x2300; c++) {
      const ch = String.fromCodePoint(c);
      if (PRINTABLE.test(ch) && ch !== " " && ch !== " ") allowed.push(ch);
    }
    const doc = { ...playbookDocument(playbook), content: [allowed.join(" ")] };
    const pdfMake = await loadPdfmake();
    const out = await pdfMake.createPdf(doc).getBlob();
    const { text } = await pdfText(new Uint8Array(await out.arrayBuffer()));
    const missing = allowed.filter((ch) => !text.includes(ch));
    assert.deepEqual(missing, []);
  });

  it("replaces characters the font can't draw", () => {
    assert.deepEqual(printable("Lead → MQL"), { text: "Lead ? MQL", changed: true });
    assert.deepEqual(printable("日本語 (Japanese)"), { text: "? (Japanese)", changed: true });
    assert.deepEqual(printable("Café · Größe – “ok” ≥ 5"), { text: "Café · Größe – “ok” ≥ 5", changed: false });
  });

  it("prints all of the playbook's own text unchanged", () => {
    for (const [id, entry] of Object.entries(GUIDANCE)) assert.equal(printable(entry.text).changed, false, id);
    for (const [column, note] of Object.entries(COLUMN_NOTES)) assert.equal(printable(note).changed, false, column);
    for (const s of playbook.sections) {
      for (const text of [s.title, s.why, s.summary, s.csv, s.rate]) assert.equal(printable(text).changed, false, text);
    }
    assert.ok(Object.keys(CHECK_GUIDES).length > 0);
  });
});
