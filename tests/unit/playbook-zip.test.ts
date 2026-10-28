import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";
import {
  findingsCsv,
  findingsFileName,
  importCsv,
  importFileName,
  playbookFileName,
  workListCsv,
  workListFileName,
  workListObjects,
  zipFileName,
} from "@/lib/csv";
import { buildPlaybook } from "@/lib/playbook/build";
import { importFindings } from "@/lib/playbook/files";
import { buildZip } from "@/lib/playbook/zip";
import type { ScanReport } from "@/lib/scan";
import { EMAIL_PATTERN, PHONE_PATTERN, simulatedReport } from "./simulated-report";

console.info = () => {};

let report: ScanReport;
let recordValues: string[];
let files: Record<string, Uint8Array>;
let folder: string;
before(async () => {
  ({ report, recordValues } = await simulatedReport());
  files = unzipSync(await buildZip(report));
  folder = zipFileName(report).replace(/\.zip$/, "");
});

const csvIn = (path: string) => strFromU8(files[`${folder}/${path}`]);

describe("Download everything (ZIP)", () => {
  it("holds the playbook and every CSV from the scan, in one folder", () => {
    const expected = [
      playbookFileName(report),
      findingsFileName(report),
      ...workListObjects(report).map((o) => workListFileName(report, o)),
      ...importFindings(report).map(importFileName),
    ].map((path) => `${folder}/${path}`);
    assert.deepEqual(Object.keys(files).sort(), expected.sort());
    assert.ok(importFindings(report).length >= 2, "simulated portal has import files");
  });

  it("has the same CSVs the download buttons give, byte for byte", () => {
    // Compared as bytes: decoding would drop the byte-order mark Excel needs.
    const same = (path: string, csv: string) =>
      assert.ok(Buffer.from(files[`${folder}/${path}`]).equals(Buffer.from(strToU8(csv))), path);
    same(findingsFileName(report), findingsCsv(report));
    for (const o of workListObjects(report)) same(workListFileName(report, o), workListCsv(report, o));
    for (const f of importFindings(report)) same(importFileName(f), importCsv(report, f));
    assert.equal(files[`${folder}/${findingsFileName(report)}`][0], 0xef, "starts with the byte-order mark");
  });

  it("has a readable playbook PDF", async () => {
    const pdf = files[`${folder}/${playbookFileName(report)}`];
    assert.equal(strFromU8(pdf.slice(0, 5)), "%PDF-");
    const { text } = await extractText(await getDocumentProxy(pdf.slice()), { mergePages: true });
    assert.ok(text.includes("Cleanup playbook"));
  });

  it("includes every file the playbook tells you to use", () => {
    for (const section of buildPlaybook(report).sections) {
      const named = section.csv.match(/^Use (\S+)/)?.[1];
      if (named) assert.ok(files[`${folder}/${named}`], `${section.title}: ${named} missing`);
    }
  });

  it("leaves record links out of the sample's work lists", async () => {
    const sample = unzipSync(await buildZip(report, { sample: true }));
    const workList = strFromU8(sample[`${folder}/${workListFileName(report, "contacts")}`]);
    assert.doesNotMatch(workList, /app\.hubspot\.com/);
    assert.match(csvIn(workListFileName(report, "contacts")), /app\.hubspot\.com/);
  });

  it("never contains a record name, email or phone number in any file", async () => {
    for (const [path, data] of Object.entries(files)) {
      const text = path.endsWith(".pdf")
        ? (await extractText(await getDocumentProxy(data.slice()), { mergePages: true })).text
        : strFromU8(data);
      for (const value of recordValues) assert.ok(!text.includes(value), `record value "${value}" in ${path}`);
      assert.doesNotMatch(text, EMAIL_PATTERN, path);
      assert.doesNotMatch(text, PHONE_PATTERN, path);
    }
  });
});
