import { SCORING_CONFIG, type ScoringConfig } from "@/config/scoring";
import {
  CATEGORY_ORDER,
  SEVERITY_RANK,
  checkKey,
  type Category,
  type CheckRun,
  type Finding,
} from "./checks/types";

export type CategoryScore = {
  category: Category;
  // null when no check in the category could be scored.
  score: number | null;
  scored: number;
  skipped: number;
};

export type HealthScore = {
  overall: number | null;
  categories: CategoryScore[];
  // Keyed by checkKey: how much the overall score rises if that check's
  // problems are fixed.
  pointsRecovered: Record<string, number>;
  explanation: string;
};

export type TopFix = { finding: Finding; points: number };

// The share of the check's population it flagged, from 0 to 1.
export function checkRate(run: Pick<CheckRun, "affected" | "population">): number {
  return run.population > 0 ? Math.min(1, run.affected / run.population) : 0;
}

// 100 at 0% affected, falling in a straight line to 0 at the severity's
// zero-point, and never below 0.
export function checkScore(
  run: Pick<CheckRun, "affected" | "population" | "severity">,
  config: ScoringConfig = SCORING_CONFIG,
): number {
  return 100 * Math.max(0, 1 - checkRate(run) / config.zeroAtRate[run.severity]);
}

function weightedAverage(items: { weight: number; value: number }[]): number | null {
  const total = items.reduce((n, i) => n + i.weight, 0);
  return total > 0 ? items.reduce((n, i) => n + i.weight * i.value, 0) / total : null;
}

function categoryScores(runs: CheckRun[], config: ScoringConfig): CategoryScore[] {
  return CATEGORY_ORDER.map((category) => {
    const inCategory = runs.filter((r) => r.category === category);
    const scored = inCategory.filter((r) => r.status === "scored");
    return {
      category,
      score: weightedAverage(
        scored.map((r) => ({ weight: config.severityWeights[r.severity], value: checkScore(r, config) })),
      ),
      scored: scored.length,
      skipped: inCategory.filter((r) => r.status === "skipped").length,
    };
  });
}

function overallScore(categories: CategoryScore[], config: ScoringConfig): number | null {
  return weightedAverage(
    categories.flatMap((c) =>
      c.score === null ? [] : [{ weight: config.categoryWeights[c.category], value: c.score }],
    ),
  );
}

// One sentence on how the score is calculated, built from the config so it
// can't drift from the numbers.
export function scoreExplanation(config: ScoringConfig = SCORING_CONFIG): string {
  const pct = (rate: number) => `${+(rate * 100).toFixed(1)}%`;
  const { zeroAtRate: z, severityWeights: w } = config;
  // Heaviest first; equal weights keep the config's order.
  const categories = Object.entries(config.categoryWeights)
    .sort((a, b) => b[1] - a[1])
    .map(([c, weight]) => `${c} ${weight}`)
    .join(", ");
  return (
    `Each check loses points in proportion to the share of records or properties it flags, ` +
    `reaching zero at ${pct(z.high)} (high), ${pct(z.medium)} (medium) or ${pct(z.low)} (low); ` +
    `categories average their checks weighted ${w.high}:${w.medium}:${w.low} by severity, ` +
    `and the total weights ${categories}. Skipped checks don't count.`
  );
}

export function scoreChecks(runs: CheckRun[], config: ScoringConfig = SCORING_CONFIG): HealthScore {
  const categories = categoryScores(runs, config);
  const overall = overallScore(categories, config);

  const pointsRecovered: Record<string, number> = {};
  if (overall !== null) {
    for (const run of runs) {
      if (run.status !== "scored" || run.affected === 0) continue;
      const fixed = runs.map((r) => (r === run ? { ...r, affected: 0 } : r));
      const gain = (overallScore(categoryScores(fixed, config), config) ?? overall) - overall;
      // Rounded so equal gains compare equal despite floating-point noise.
      pointsRecovered[checkKey(run)] = Math.round(gain * 1000) / 1000;
    }
  }

  return { overall, categories, pointsRecovered, explanation: scoreExplanation(config) };
}

// Findings ranked by points recovered; ties go to the more severe, then the
// more common problem. Unscored findings (duplicates still to confirm) are
// left out unless asked for, and then come last.
export function topFixes(
  findings: Finding[],
  score: HealthScore,
  config: ScoringConfig = SCORING_CONFIG,
  { includeUnscored = false }: { includeUnscored?: boolean } = {},
): TopFix[] {
  const scoredFirst = [
    ...findings.filter((f) => f.scored !== false),
    ...(includeUnscored ? findings.filter((f) => f.scored === false) : []),
  ];
  return scoredFirst
    .map((finding) => ({ finding, points: score.pointsRecovered[checkKey(finding)] ?? 0 }))
    .sort(
      (a, b) =>
        Number(a.finding.scored === false) - Number(b.finding.scored === false) ||
        b.points - a.points ||
        SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
        b.finding.affected - a.finding.affected,
    )
    .slice(0, config.topFixes);
}
