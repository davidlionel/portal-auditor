import { CHECK_GUIDES } from "@/config/hubspot-guidance";
import type { Finding } from "../checks/types";
import {
  cleanupReason,
  findingsCsv,
  findingsFileName,
  importCsv,
  importFileName,
  workListCsv,
  workListFileName,
  workListObjects,
} from "../csv";
import type { ScanReport } from "../scan";

export type ExportFile = {
  path: string;
  kind: "findings" | "work-list" | "import";
  // One line for the playbook's appendix.
  description: string;
  // A real Cleanup reason value from this file, for the appendix.
  exampleReason?: string;
  content: string;
};

// What each CSV column holds, for the appendix. A unit test checks every
// header in csv.ts is described here.
export const COLUMN_NOTES: Record<string, string> = {
  Check: "The problem the auditor found.",
  Object: "Contacts, Companies or Deals.",
  Category: "Which part of the health score the check counts toward.",
  Severity: "high, medium or low.",
  Count: "What the report shows: records, properties or duplicate groups.",
  Affected: "Records or properties affected; the top of the rate.",
  Population: "Records or properties checked; the bottom of the rate.",
  "Rate (%)": "Affected as a share of population.",
  "Points recovered": "How much the overall score rises when this is fixed.",
  "Why it matters": "The effect on reports, automation or outreach.",
  "How to fix": "The fix in one sentence; the playbook has the steps.",
  "Record ID": "HubSpot's ID for the record. Map it to Record ID when importing.",
  "Object type": "Contacts, Companies or Deals.",
  "Duplicate group": "Records with the same number are likely duplicates of each other. For review only; don't import it.",
  "HubSpot record link": "Opens the record in HubSpot (blank in the sample, whose portal you can't log in to).",
  Capped: 'Filled when the check matched more records than the file lists, e.g. "first 1,000 of 4,512". Use the HubSpot filter for the full set.',
  "Cleanup reason": "Why the record is listed. Import it into a Cleanup reason property to filter on later.",
};

// The Cleanup reason note with an example taken from the file itself.
export const cleanupReasonNote = (example: string) =>
  `Why the record is listed, e.g. "${example}". Import it into a Cleanup reason property to filter on later.`;

const SINGULAR = { contacts: "contact", companies: "company", deals: "deal" } as const;

// Findings whose records are cleaned up from an import file, because no
// HubSpot filter can find them.
export const importFindings = (report: ScanReport): Finding[] =>
  report.findings.filter((f) => CHECK_GUIDES[f.checkId]?.csv === "import" && f.records?.length);

// Every CSV from one scan, named as the download buttons name them. The
// ZIP and the playbook's appendix both use this list.
export function exportFiles(report: ScanReport, { sample = false }: { sample?: boolean } = {}): ExportFile[] {
  return [
    {
      path: findingsFileName(report),
      kind: "findings",
      description: "One row per finding, with the numbers behind its score.",
      content: findingsCsv(report),
    },
    ...workListObjects(report).map((objectType) => {
      const first = report.findings.find((f) => f.objectType === objectType && f.records?.length);
      return {
        path: workListFileName(report, objectType),
        kind: "work-list" as const,
        description: `Every flagged ${SINGULAR[objectType]} record, one row per record per check.`,
        exampleReason: first && cleanupReason(report, first),
        content: workListCsv(report, objectType, { recordLinks: !sample }),
      };
    }),
    ...importFindings(report).map((finding) => ({
      path: importFileName(finding),
      kind: "import" as const,
      description: `Import file for "${finding.title}": one row per record.`,
      exampleReason: cleanupReason(report, finding),
      content: importCsv(report, finding),
    })),
  ];
}
