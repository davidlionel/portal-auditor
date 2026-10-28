import { checkKey, type Finding } from "./checks/types";
import type { ObjectType } from "./hubspot/properties";
import { recordUrl } from "./hubspot/links";
import type { ScanReport } from "./scan";
import { checkRate } from "./scoring";

type Cell = string | number;

// Spreadsheets run cells starting with these as formulas.
const FORMULA_START = /^[=+\-@\t\r]/;

// One CSV cell (RFC 4180): quoted when it holds a comma, quote or line
// break, and prefixed with ' when a spreadsheet would treat it as a formula.
export function csvCell(value: Cell): string {
  if (typeof value === "number") return String(value);
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// UTF-8 with a byte-order mark so Excel reads accents correctly.
export function toCsv(rows: Cell[][]): string {
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

const OBJECT_LABELS: Record<ObjectType, string> = {
  contacts: "Contacts",
  companies: "Companies",
  deals: "Deals",
};

export const FINDINGS_HEADER = [
  "Check", "Object", "Category", "Severity", "Count", "Affected", "Population", "Rate (%)", "Points recovered",
  "Why it matters", "How to fix",
];
export const WORK_LIST_HEADER = [
  "Record ID", "Object type", "Check", "Severity", "Duplicate group", "HubSpot record link", "Capped", "Cleanup reason",
];
export const IMPORT_HEADER = ["Record ID", "Cleanup reason", "Duplicate group"];

// File names, shared by the download buttons and the ZIP.
const filePrefix = (report: ScanReport) => `portal-${report.portal.portalId}`;
export const findingsFileName = (report: ScanReport) => `${filePrefix(report)}-findings.csv`;
export const workListFileName = (report: ScanReport, objectType: ObjectType) =>
  `${filePrefix(report)}-work-list-${objectType}.csv`;
export const playbookFileName = (report: ScanReport) => `${filePrefix(report)}-playbook.pdf`;
export const zipFileName = (report: ScanReport) => `${filePrefix(report)}-cleanup.zip`;

// One row per finding, with the numbers behind its score.
export function findingsCsv(report: ScanReport): string {
  return toCsv([
    FINDINGS_HEADER,
    ...report.findings.map((f) => [
      f.title,
      OBJECT_LABELS[f.objectType],
      f.category,
      f.severity,
      f.count,
      f.affected,
      f.population,
      +(checkRate(f) * 100).toFixed(2),
      +(report.score.pointsRecovered[checkKey(f)] ?? 0).toFixed(1),
      f.why,
      f.fix,
    ]),
  ]);
}

// The scan's date in UTC, e.g. "2026-10-28".
export const scanDay = (report: ScanReport) => report.scannedAt.slice(0, 10);

// Prefilled text for a "Cleanup reason" property, so imported records can be
// filtered by why they were flagged.
export const cleanupReason = (report: ScanReport, finding: Finding) =>
  `Portal audit ${scanDay(report)}: ${finding.title}`;

// Objects that have any records in the work list, in scan order.
export function workListObjects(report: ScanReport): ObjectType[] {
  return report.scannedObjects.filter((o) =>
    report.findings.some((f) => f.objectType === o && f.records?.length),
  );
}

// Record IDs to clean up for one object: no names, emails or other values.
// One object per file because HubSpot imports one object per file.
export function workListCsv(
  report: ScanReport,
  objectType: ObjectType,
  { recordLinks = true }: { recordLinks?: boolean } = {},
): string {
  const rows = report.findings
    .filter((f) => f.objectType === objectType && f.records?.length)
    .flatMap((f) => {
      const capped =
        f.records!.length < f.affected
          ? `first ${f.records!.length.toLocaleString("en-US")} of ${f.affected.toLocaleString("en-US")}`
          : "";
      return f.records!.map((r) => [
        r.id,
        OBJECT_LABELS[objectType],
        f.title,
        f.severity,
        r.group ?? "",
        (recordLinks && recordUrl(report.portal, objectType, r.id)) || "",
        capped,
        cleanupReason(report, f),
      ]);
    });
  return toCsv([WORK_LIST_HEADER, ...rows]);
}

// Where a finding's import file sits in the ZIP, e.g.
// "imports/contacts-malformed-email.csv".
export const importFileName = (finding: Finding) =>
  `imports/${finding.checkId.replace(/[^a-z0-9]+/gi, "-")}.csv`;

// One finding's records, one row per record, ready to import by Record ID
// into a contact segment or a "Cleanup reason" property. Duplicate findings
// keep the group number for review; it isn't meant to be imported.
export function importCsv(report: ScanReport, finding: Finding): string {
  const grouped = finding.records?.some((r) => r.group !== undefined) ?? false;
  const seen = new Set<string>();
  const rows = (finding.records ?? [])
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .map((r) => [r.id, cleanupReason(report, finding), ...(grouped ? [r.group ?? ""] : [])]);
  return toCsv([grouped ? IMPORT_HEADER : IMPORT_HEADER.slice(0, 2), ...rows]);
}
