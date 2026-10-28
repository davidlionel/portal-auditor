import type { Category, Severity } from "@/lib/checks/types";

export type ScoringConfig = {
  // Share of the overall score each category carries. Normalized over the
  // categories that have scored checks, so they needn't sum to 100.
  categoryWeights: Record<Category, number>;
  // How much a check counts inside its category.
  severityWeights: Record<Severity, number>;
  // The rate (affected ÷ population) at which a check scores 0. A check
  // loses points in a straight line from 0% affected (100) to this rate.
  zeroAtRate: Record<Severity, number>;
  // How many fixes the report lists first.
  topFixes: number;
};

// The scoring rules. The reasoning for each value lives in the project's
// decision log, not here. Scoring takes this as a default, so tests can pass
// their own weights.
export const SCORING_CONFIG: ScoringConfig = {
  categoryWeights: { Contacts: 35, Deals: 25, Companies: 20, Properties: 20 },
  severityWeights: { high: 3, medium: 2, low: 1 },
  zeroAtRate: { high: 0.1, medium: 0.25, low: 0.5 },
  topFixes: 5,
};
