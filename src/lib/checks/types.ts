import type { ObjectType } from "../hubspot/properties";

export type Severity = "high" | "medium" | "low";

export type Category = "Properties" | "Contacts" | "Companies" | "Deals";

// One record in a finding's work list. Duplicates share a group number and
// say which signals matched them ("same phone + nickname"), never the values.
export type WorkRecord = { id: string; group?: number; signals?: string };

export type Finding = {
  checkId: string;
  title: string;
  category: Category;
  objectType: ObjectType;
  severity: Severity;
  // What the report shows: records, properties, or duplicate groups.
  count: number;
  // What the score uses: affected ÷ population is the check's rate. For
  // duplicates, affected counts records in groups, not groups.
  affected: number;
  population: number;
  // Up to the sample cap. For property checks these are property names.
  samples: string[];
  // Property checks: every affected item in the same form as samples, up to
  // the work-list cap, so the playbook can list them all.
  items?: string[];
  // Record checks: up to the sample cap of record ID groups. A group has one
  // ID for single-record problems and several for duplicates.
  recordSamples?: string[][];
  // Record checks: affected records for the work-list export, up to the
  // work-list cap. Fewer than `affected` means the list was capped.
  records?: WorkRecord[];
  // Duplicate checks: the most common signal combinations and how many
  // groups each matched.
  matchSummary?: { signals: string; groups: number }[];
  // False for checks that are reported but don't count toward the score
  // (duplicates of medium or low confidence).
  scored?: false;
  why: string;
  fix: string;
};

// Name and severity of a check, known before it runs, so checks that find
// nothing or are skipped can still be listed and scored.
export type CheckMeta = { checkId: string; title: string; severity: Severity; scored?: false };

// Every check the scan attempted, whether or not it found anything.
// "scored" checks count toward the health score; "skipped" ones couldn't run
// (missing scope or property, no records) and are left out and listed;
// "empty" ones had nothing to look at (no custom dropdowns, say);
// "unscored" ones ran and are reported but don't count (duplicates that
// need confirming).
export type CheckRun = CheckMeta & {
  category: Category;
  objectType: ObjectType;
  status: "scored" | "skipped" | "empty" | "unscored";
  affected: number;
  population: number;
  reason?: string;
};

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const CATEGORY_FOR_OBJECT: Record<ObjectType, Category> = {
  contacts: "Contacts",
  companies: "Companies",
  deals: "Deals",
};

export const CATEGORY_ORDER: Category[] = ["Properties", "Contacts", "Companies", "Deals"];

// The same check can run on several objects (property checks), so runs and
// findings are matched on check and object together.
export const checkKey = (c: { checkId: string; objectType: ObjectType }) =>
  `${c.checkId}:${c.objectType}`;
