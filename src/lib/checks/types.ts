import type { ObjectType } from "../hubspot/properties";

export type Severity = "high" | "medium" | "low";

export type Finding = {
  checkId: string;
  title: string;
  category: "Properties";
  objectType: ObjectType;
  severity: Severity;
  count: number;
  // Up to the sample cap. For property checks these are property names.
  samples: string[];
  why: string;
  fix: string;
};

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
