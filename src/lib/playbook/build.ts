import { CHECKS_CONFIG } from "@/config/checks";
import { SCORING_CONFIG } from "@/config/scoring";
import {
  CHECK_GUIDES,
  GUIDANCE,
  IMPORT_STEPS,
  IMPORT_STEP_IDS,
  isGuidanceId,
  type FilterCondition,
  type GuidanceEntry,
  type GuidanceId,
} from "@/config/hubspot-guidance";
import { rateText } from "../checks/population";
import { CATEGORY_ORDER, checkKey, type Category, type Finding, type Severity } from "../checks/types";
import { FINDINGS_HEADER, IMPORT_HEADER, WORK_LIST_HEADER, cleanupReason, importFileName, scanDay } from "../csv";
import { accountTypeLabel } from "../hubspot/account-types";
import type { ObjectType } from "../hubspot/properties";
import type { ScanReport } from "../scan";
import { topFixes } from "../scoring";
import { COLUMN_NOTES, cleanupReasonNote, exportFiles, type ExportFile } from "./files";

// The playbook as plain text: what the PDF lays out. Built only from check
// text, property names, counts, portal details and the guidance file, so
// no record values (names, emails, phone numbers) can reach it. Record IDs
// stay in the CSVs.

// `conditions` sits under the "add each condition below" step.
export type Step = { text: string; general: boolean; conditions?: string[] };

export type Section = {
  number: number;
  title: string;
  category: Category;
  severity: Severity;
  rate: string;
  points: number;
  why: string;
  summary: string;
  // "Lifecycle stage is unknown", one line per condition.
  filter: string[];
  csv: string;
  // Property checks: the properties to fix.
  items: string[];
  itemsNote?: string;
  steps: Step[];
  prevent: Step[];
  sources: string[];
};

export type Playbook = {
  portal: string;
  scanDate: string;
  verifiedOn: string;
  sample: boolean;
  incomplete?: string;
  overall: number | null;
  categories: { category: Category; score: number | null }[];
  topFixes: { title: string; points: number }[];
  sections: Section[];
  files: { path: string; description: string; columns: { name: string; note: string }[] }[];
  importSteps: Step[];
  importSources: string[];
};

// Scores print as whole numbers, as on the report.
const round = (score: number | null) => (score === null ? null : Math.round(score));

const OBJECT_LABELS: Record<ObjectType, string> = { contacts: "Contacts", companies: "Companies", deals: "Deals" };

// "October 28, 2026", in UTC so it matches the scan day in file names.
export const longDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

function step(id: GuidanceId, objectLabel: string): Step {
  const entry: GuidanceEntry = GUIDANCE[id];
  return { text: entry.text.replaceAll("{object}", objectLabel), general: Boolean(entry.general) };
}

function conditionText(condition: FilterCondition): string {
  const value = condition.value
    ? isGuidanceId(condition.value)
      ? GUIDANCE[condition.value].text
      : condition.value.replace("{staleDealDays}", String(CHECKS_CONFIG.records.staleDealDays))
    : "";
  return [GUIDANCE[condition.property].text, GUIDANCE[condition.operator].text, value].filter(Boolean).join(" ");
}

// Guidance entries a section relies on: its steps and its filter's words.
function entriesFor(checkId: string): GuidanceId[] {
  const guide = CHECK_GUIDES[checkId];
  if (!guide) return [];
  const fromFilter = (guide.filter ?? []).flatMap((c) => [
    c.property,
    c.operator,
    ...(c.value && isGuidanceId(c.value) ? [c.value] : []),
  ]);
  return [...fromFilter, ...guide.steps, ...(guide.prevent ?? []), ...(guide.csv === "import" ? IMPORT_STEP_IDS : [])];
}

const sourcesOf = (ids: GuidanceId[]) => [
  ...new Set(ids.map((id) => (GUIDANCE[id] as GuidanceEntry).source).filter((s): s is string => Boolean(s))),
];

function csvText(report: ScanReport, finding: Finding, files: ExportFile[]): string {
  const guide = CHECK_GUIDES[finding.checkId];
  if (guide?.csv === "none") {
    return "No CSV needed. The HubSpot filter in the steps finds every affected record, including any beyond the ones listed in the work list.";
  }
  if (guide?.csv === "property") return "No CSV needed. The properties to fix are listed above.";

  const path = importFileName(finding);
  if (!files.some((f) => f.path === path)) return "No records to import.";
  const listed = new Set(finding.records?.map((r) => r.id)).size;
  const capped = (finding.records?.length ?? 0) < finding.affected ? ` It lists the first ${listed.toLocaleString("en-US")} of ${finding.affected.toLocaleString("en-US")} affected records.` : "";
  const target =
    finding.objectType === "contacts"
      ? "select Create a contact segment, so the segment holds exactly these contacts"
      : 'map the Cleanup reason column to a new Cleanup reason property, then filter a view on it';
  return `Use ${path} (${listed.toLocaleString("en-US")} records).${capped} Import it by Record ID as in Appendix B and ${target}. Every row's Cleanup reason reads "${cleanupReason(report, finding)}".`;
}

function itemsFor(finding: Finding): { items: string[]; itemsNote?: string } {
  if (finding.category !== "Properties") return { items: [] };
  const items = finding.items ?? finding.samples;
  return items.length < finding.count
    ? { items, itemsNote: `Showing ${items.length} of ${finding.count.toLocaleString("en-US")}. Run a new scan for the full list.` }
    : { items };
}

function section(report: ScanReport, finding: Finding, number: number, files: ExportFile[]): Section {
  const guide = CHECK_GUIDES[finding.checkId];
  const objectLabel = OBJECT_LABELS[finding.objectType];
  return {
    number,
    title: finding.category === "Properties" ? `${finding.title} (${objectLabel})` : finding.title,
    category: finding.category,
    severity: finding.severity,
    rate: rateText(finding),
    points: report.score.pointsRecovered[checkKey(finding)] ?? 0,
    why: finding.why,
    summary: finding.fix,
    filter: (guide?.filter ?? []).map(conditionText),
    csv: csvText(report, finding, files),
    ...itemsFor(finding),
    steps: (guide?.steps ?? []).map((id) =>
      id === "advancedFilters" ? { ...step(id, objectLabel), conditions: (guide?.filter ?? []).map(conditionText) } : step(id, objectLabel),
    ),
    prevent: (guide?.prevent ?? []).map((id) => step(id, objectLabel)),
    sources: sourcesOf(entriesFor(finding.checkId)),
  };
}

const columnsOf = (file: ExportFile) => {
  const header = file.content.replace(/^﻿/, "").split("\r\n", 1)[0].split(",");
  return header.map((name) => ({
    name,
    note: name === "Cleanup reason" && file.exampleReason ? cleanupReasonNote(file.exampleReason) : (COLUMN_NOTES[name] ?? ""),
  }));
};

export function buildPlaybook(report: ScanReport, { sample = false }: { sample?: boolean } = {}): Playbook {
  // Biggest score gains first, so the playbook reads as a to-do list.
  const ordered = topFixes(report.findings, report.score, { ...SCORING_CONFIG, topFixes: Infinity });
  const files = exportFiles(report, { sample });
  const sections = ordered.map(({ finding }, i) => section(report, finding, i + 1, files));

  const used = [...ordered.flatMap(({ finding }) => entriesFor(finding.checkId)), ...IMPORT_STEP_IDS];
  const verifiedOn = used.map((id) => GUIDANCE[id].lastVerified).sort()[0] ?? scanDay(report);

  return {
    portal: `Hub ID ${report.portal.portalId} · ${accountTypeLabel(report.portal.accountType)}`,
    scanDate: longDate(report.scannedAt),
    verifiedOn: longDate(verifiedOn),
    sample,
    incomplete: report.incomplete?.message,
    overall: round(report.score.overall),
    categories: CATEGORY_ORDER.map((category) => ({
      category,
      score: round(report.score.categories.find((c) => c.category === category)?.score ?? null),
    })),
    topFixes: sections.slice(0, 5).map((s) => ({ title: s.title, points: s.points })),
    sections,
    files: files.map((file) => ({ path: file.path, description: file.description, columns: columnsOf(file) })),
    importSteps: IMPORT_STEPS.map((ids) => {
      const parts = [ids].flat().map((id) => step(id, "Contacts, Companies or Deals"));
      return { text: parts.map((s) => s.text).join(" "), general: parts.some((s) => s.general) };
    }),
    importSources: sourcesOf(IMPORT_STEP_IDS),
  };
}

// Every header the CSVs can have, so a test can check the appendix
// describes them all.
export const ALL_CSV_COLUMNS = [...new Set([...FINDINGS_HEADER, ...WORK_LIST_HEADER, ...IMPORT_HEADER])];
