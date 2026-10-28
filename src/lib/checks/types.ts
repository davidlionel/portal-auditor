import type { ObjectType } from "../hubspot/properties";

export type Severity = "high" | "medium" | "low";

export type Category = "Properties" | "Contacts" | "Companies" | "Deals";

export type Finding = {
  checkId: string;
  title: string;
  category: Category;
  objectType: ObjectType;
  severity: Severity;
  count: number;
  // Up to the sample cap. For property checks these are property names.
  samples: string[];
  // Record checks: up to the sample cap of record ID groups. A group has one
  // ID for single-record problems and several for duplicates.
  recordSamples?: string[][];
  why: string;
  fix: string;
};

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const CATEGORY_FOR_OBJECT: Record<ObjectType, Category> = {
  contacts: "Contacts",
  companies: "Companies",
  deals: "Deals",
};
