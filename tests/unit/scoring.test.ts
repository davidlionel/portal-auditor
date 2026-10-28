import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SCORING_CONFIG } from "@/config/scoring";
import type { CheckRun, Finding } from "@/lib/checks/types";
import { checkScore, scoreChecks, scoreExplanation, topFixes } from "@/lib/scoring";

// A scored contacts check. Tests override only what they're about.
function run(overrides: Partial<CheckRun> & { checkId: string }): CheckRun {
  return {
    title: overrides.checkId,
    severity: "medium",
    category: "Contacts",
    objectType: "contacts",
    status: "scored",
    affected: 0,
    population: 1000,
    ...overrides,
  };
}

// The finding a scored run would have produced.
function findingFor(r: CheckRun): Finding {
  return {
    checkId: r.checkId,
    title: r.title,
    category: r.category,
    objectType: r.objectType,
    severity: r.severity,
    count: r.affected,
    affected: r.affected,
    population: r.population,
    samples: [],
    why: "",
    fix: "",
  };
}

const category = (runs: CheckRun[], name: string) =>
  scoreChecks(runs).categories.find((c) => c.category === name)!;

describe("checkScore", () => {
  it("is 100 when nothing is affected", () => {
    assert.equal(checkScore({ affected: 0, population: 500, severity: "high" }), 100);
  });

  it("falls in a straight line to 0 at the severity's zero-point", () => {
    // Medium reaches 0 at 25%, so 2% scores 92.
    assert.equal(checkScore({ affected: 20, population: 1000, severity: "medium" }), 92);
    assert.equal(checkScore({ affected: 50, population: 1000, severity: "high" }), 50);
    assert.equal(checkScore({ affected: 250, population: 1000, severity: "low" }), 50);
  });

  it("never goes below 0, even past the zero-point or above 100% affected", () => {
    assert.equal(checkScore({ affected: 400, population: 1000, severity: "high" }), 0);
    assert.equal(checkScore({ affected: 12, population: 10, severity: "low" }), 0);
  });

  it("depends on the rate, not the portal's size", () => {
    const small = checkScore({ affected: 20, population: 1000, severity: "high" });
    const big = checkScore({ affected: 5000, population: 250_000, severity: "high" });
    assert.equal(small, big);
  });

  it("uses the configured zero-points", () => {
    const strict = { ...SCORING_CONFIG, zeroAtRate: { ...SCORING_CONFIG.zeroAtRate, medium: 0.05 } };
    assert.equal(checkScore({ affected: 25, population: 1000, severity: "medium" }, strict), 50);
  });
});

describe("scoreChecks", () => {
  it("scores 100 when every check ran and found nothing", () => {
    const score = scoreChecks([run({ checkId: "a" }), run({ checkId: "b", category: "Deals" })]);
    assert.equal(score.overall, 100);
    assert.deepEqual(score.pointsRecovered, {});
  });

  it("gives a 1K and a 250K portal with the same rates the same score", () => {
    const small = scoreChecks([
      run({ checkId: "a", affected: 30, population: 1000, severity: "high" }),
      run({ checkId: "b", affected: 100, population: 1000, category: "Deals" }),
    ]);
    const big = scoreChecks([
      run({ checkId: "a", affected: 7500, population: 250_000, severity: "high" }),
      run({ checkId: "b", affected: 25_000, population: 250_000, category: "Deals" }),
    ]);
    assert.equal(small.overall, big.overall);
  });

  it("averages a category's checks weighted by severity", () => {
    // High scores 0 (weight 3), low scores 100 (weight 1): (0×3 + 100×1) ÷ 4 = 25.
    const runs = [
      run({ checkId: "high", severity: "high", affected: 100, population: 1000 }),
      run({ checkId: "low", severity: "low" }),
    ];
    assert.equal(category(runs, "Contacts").score, 25);
  });

  it("weights categories by the config", () => {
    // Contacts 0 (weight 35), Deals 100 (weight 25): 100 × 25 ÷ 60.
    const score = scoreChecks([
      run({ checkId: "a", severity: "high", affected: 100, population: 1000 }),
      run({ checkId: "b", category: "Deals" }),
    ]);
    assert.ok(Math.abs(score.overall! - (100 * 25) / 60) < 1e-9);
  });

  it("doesn't count skipped checks against their category", () => {
    const ran = [run({ checkId: "a", affected: 20 })];
    const withSkip = [
      ...ran,
      run({ checkId: "stale", status: "skipped", reason: "this portal has no x property", population: 0 }),
    ];
    assert.equal(category(withSkip, "Contacts").score, category(ran, "Contacts").score);
    assert.equal(category(withSkip, "Contacts").skipped, 1);
    assert.equal(category(withSkip, "Contacts").scored, 1);
  });

  it("leaves out checks with nothing to look at", () => {
    const runs = [run({ checkId: "a", affected: 20 }), run({ checkId: "b", status: "empty", population: 0 })];
    assert.equal(category(runs, "Contacts").scored, 1);
    assert.equal(category(runs, "Contacts").skipped, 0);
  });

  it("drops a category with nothing scored and shares its weight among the rest", () => {
    const runs = [
      run({ checkId: "a", affected: 20 }),
      run({ checkId: "d", category: "Deals", status: "skipped", population: 0 }),
    ];
    const score = scoreChecks(runs);
    assert.equal(category(runs, "Deals").score, null);
    assert.equal(score.overall, category(runs, "Contacts").score);
  });

  it("has no overall score when nothing could be scored", () => {
    assert.equal(scoreChecks([run({ checkId: "a", status: "skipped", population: 0 })]).overall, null);
  });

  it("changes when the weights change", () => {
    const runs = [
      run({ checkId: "a", affected: 100, population: 1000, severity: "high" }),
      run({ checkId: "b", category: "Deals" }),
    ];
    const contactsHeavy = {
      ...SCORING_CONFIG,
      categoryWeights: { ...SCORING_CONFIG.categoryWeights, Contacts: 90, Deals: 10 },
    };
    assert.ok(scoreChecks(runs, contactsHeavy).overall! < scoreChecks(runs).overall!);
  });

  it("weighs a group of six duplicates more than a pair", () => {
    const six = scoreChecks([run({ checkId: "dup", severity: "high", affected: 6, population: 100 })]);
    const pair = scoreChecks([run({ checkId: "dup", severity: "high", affected: 2, population: 100 })]);
    assert.ok(six.overall! < pair.overall!);
  });

  it("reports the points each fix recovers", () => {
    // One Contacts check at 50 and nothing else: fixing it recovers 50.
    const score = scoreChecks([run({ checkId: "a", severity: "high", affected: 50, population: 1000 })]);
    assert.equal(score.overall, 50);
    assert.equal(score.pointsRecovered["a:contacts"], 50);
  });
});

describe("topFixes", () => {
  it("ranks by points recovered, not by count", () => {
    const runs = [
      // Many records but a small rate in a light category.
      run({ checkId: "big", category: "Companies", objectType: "companies", severity: "low", affected: 900, population: 30_000 }),
      // Few records but a high rate in the heaviest category.
      run({ checkId: "small", severity: "high", affected: 12, population: 200 }),
      run({ checkId: "deals", category: "Deals", objectType: "deals", affected: 40, population: 400 }),
    ];
    const score = scoreChecks(runs);
    const order = topFixes(runs.map(findingFor), score).map((f) => f.finding.checkId);
    assert.deepEqual(order, ["small", "deals", "big"]);
  });

  it("breaks ties by severity, then by records affected", () => {
    const score = { ...scoreChecks([]), pointsRecovered: { "a:contacts": 5, "b:contacts": 5, "c:contacts": 5 } };
    const findings = [
      findingFor(run({ checkId: "a", severity: "low", affected: 50 })),
      findingFor(run({ checkId: "b", severity: "high", affected: 1 })),
      findingFor(run({ checkId: "c", severity: "high", affected: 9 })),
    ];
    assert.deepEqual(
      topFixes(findings, score).map((f) => f.finding.checkId),
      ["c", "b", "a"],
    );
  });

  it("returns at most the configured number, fewer when there are fewer findings, and none for none", () => {
    const runs = Array.from({ length: 8 }, (_, i) => run({ checkId: `c${i}`, affected: i + 1 }));
    const score = scoreChecks(runs);
    assert.equal(topFixes(runs.map(findingFor), score).length, 5);
    assert.equal(topFixes(runs.slice(0, 2).map(findingFor), score).length, 2);
    assert.deepEqual(topFixes([], score), []);
    assert.equal(topFixes(runs.map(findingFor), score, { ...SCORING_CONFIG, topFixes: 3 }).length, 3);
  });
});

describe("scoreExplanation", () => {
  it("states the zero-points and weights from the config", () => {
    const text = scoreExplanation();
    assert.match(text, /10% \(high\), 25% \(medium\) or 50% \(low\)/);
    assert.match(text, /Contacts 35, Deals 25, Companies 20, Properties 20/);
    assert.match(text, /3:2:1/);
  });

  it("follows a changed config", () => {
    const text = scoreExplanation({ ...SCORING_CONFIG, zeroAtRate: { high: 0.05, medium: 0.2, low: 0.4 } });
    assert.match(text, /5% \(high\), 20% \(medium\) or 40% \(low\)/);
  });
});
