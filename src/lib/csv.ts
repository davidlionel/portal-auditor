import { checkKey } from "./checks/types";
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

// One row per finding, with the numbers behind its score.
export function findingsCsv(report: ScanReport): string {
  return toCsv([
    ["Check", "Object", "Category", "Severity", "Count", "Affected", "Population", "Rate (%)", "Points recovered", "Why it matters", "How to fix"],
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
      ]);
    });
  return toCsv([
    ["Record ID", "Object type", "Check", "Severity", "Duplicate group", "HubSpot record link", "Capped"],
    ...rows,
  ]);
}
