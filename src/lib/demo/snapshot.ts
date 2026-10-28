import type { ScanReport } from "../scan";

// A saved scan of the developer test portal, shown as the public sample
// report. Written by `npm run demo:snapshot`.
export type DemoSnapshot = {
  // ISO timestamp of the scan.
  scannedAt: string;
  appVersion: string;
  report: ScanReport;
};

// Fields a report may contain, by where they appear. Anything else fails
// validation, so a new field can't slip into the public file unnoticed.
const ALLOWED_KEYS = {
  snapshot: ["scannedAt", "appVersion", "report"],
  report: [
    "portal", "scannedObjects", "notes", "findings", "checks", "score",
    "apiCalls", "retries", "durationMs", "simulated", "incomplete",
  ],
  portal: ["portalId", "accountType", "timeZone", "companyCurrency", "uiDomain", "dataHostingLocation"],
  finding: [
    "checkId", "title", "category", "objectType", "severity", "count", "affected", "population",
    "samples", "recordSamples", "records", "why", "fix",
  ],
  record: ["id", "group"],
  check: ["checkId", "title", "severity", "category", "objectType", "status", "affected", "population", "reason"],
  score: ["overall", "categories", "pointsRecovered", "explanation"],
  category: ["category", "score", "scored", "skipped"],
  incomplete: ["kind", "message"],
};

const RECORD_ID = /^\d+$/;
const EMAIL = /[^\s@]+@[^\s@]+/;
// Phone-shaped text such as "(415) 555-0142" or "+44 20 7946 0958". Record
// IDs are plain digit strings and are checked separately.
const PHONE = /(\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Problems that would make the snapshot unsafe to publish; empty when it's
// fine. Allowed: record IDs, property names and labels (including dropdown
// option labels), counts, check text, scan notes and portal details. Never
// record values such as names, emails or phone numbers.
export function validateSnapshot(snapshot: unknown): string[] {
  const errors: string[] = [];

  function keys(value: unknown, allowed: string[], where: string): value is Record<string, unknown> {
    if (!isObject(value)) {
      errors.push(`${where} is not an object`);
      return false;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) errors.push(`${where} has an unexpected field "${key}"`);
    }
    return true;
  }

  // Every string anywhere in the file, with its path.
  function strings(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
    if (typeof value === "string") out.push([path, value]);
    else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
    else if (isObject(value)) for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
    return out;
  }

  if (!keys(snapshot, ALLOWED_KEYS.snapshot, "snapshot")) return errors;
  if (typeof snapshot.scannedAt !== "string" || Number.isNaN(Date.parse(snapshot.scannedAt))) {
    errors.push("snapshot.scannedAt is not a date");
  }
  const report = snapshot.report;
  if (!keys(report, ALLOWED_KEYS.report, "report")) return errors;

  if (report.simulated !== false) errors.push("report comes from the simulator, not a real portal");
  if (keys(report.portal, ALLOWED_KEYS.portal, "report.portal") && report.portal.accountType !== "DEVELOPER_TEST") {
    errors.push(`report.portal is a ${String(report.portal.accountType)} account, not a developer test portal`);
  }
  if (report.incomplete !== undefined) keys(report.incomplete, ALLOWED_KEYS.incomplete, "report.incomplete");

  const findings = Array.isArray(report.findings) ? report.findings : [];
  findings.forEach((f, i) => {
    const where = `report.findings[${i}]`;
    if (!keys(f, ALLOWED_KEYS.finding, where)) return;
    if (f.recordSamples !== undefined) {
      const groups = Array.isArray(f.recordSamples) ? f.recordSamples : [];
      for (const id of groups.flat()) {
        if (typeof id !== "string" || !RECORD_ID.test(id)) errors.push(`${where}.recordSamples has a non-ID value`);
      }
    }
    if (f.records !== undefined) {
      const records = Array.isArray(f.records) ? f.records : [];
      records.forEach((r, j) => {
        if (!keys(r, ALLOWED_KEYS.record, `${where}.records[${j}]`)) return;
        if (typeof r.id !== "string" || !RECORD_ID.test(r.id)) errors.push(`${where}.records[${j}].id is not a record ID`);
      });
    }
  });

  const checks = Array.isArray(report.checks) ? report.checks : [];
  checks.forEach((c, i) => keys(c, ALLOWED_KEYS.check, `report.checks[${i}]`));

  if (keys(report.score, ALLOWED_KEYS.score, "report.score")) {
    const categories = Array.isArray(report.score.categories) ? report.score.categories : [];
    categories.forEach((c, i) => keys(c, ALLOWED_KEYS.category, `report.score.categories[${i}]`));
  }

  // Belt and braces: no email- or phone-shaped text anywhere except record IDs.
  for (const [path, value] of strings(snapshot, "snapshot")) {
    if (EMAIL.test(value)) errors.push(`${path} looks like it contains an email address`);
    if (!RECORD_ID.test(value) && PHONE.test(value)) errors.push(`${path} looks like it contains a phone number`);
  }

  return errors;
}
