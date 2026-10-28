import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import { RETRY_CONFIG } from "@/config/requests";
import type { Transport } from "@/lib/hubspot/client";
import { runScan } from "@/lib/scan";
import { SIZE_SMALL } from "@/lib/simulator/portal";
import { simulatorTransport, type RateLimitMode } from "@/lib/simulator/transport";

console.info = () => {};

// A scan of the small simulated portal with no pacing and instant retries.
async function scan(rateLimits: RateLimitMode, dailyAfter?: number) {
  const sim = simulatorTransport({ size: SIZE_SMALL, rateLimits, dailyAfter });
  // Counts calls made after the limit was hit.
  let afterLimit = 0;
  let limited = false;
  const transport: Transport = async (req) => {
    if (limited) afterLimit++;
    const response = await sim.transport(req);
    if (response.status === 429 && rateLimits === "daily") limited = true;
    return response;
  };
  const result = await runScan(transport, {
    config: { ...CHECKS_CONFIG, searchMinIntervalMs: 0 },
    retry: { ...RETRY_CONFIG, maxRetries: 2 },
    sleep: async () => {},
  });
  assert.ok(result.ok, "a rate limit returns a report, not an error");
  return { report: result.report, afterLimit };
}

describe("scan when HubSpot's rate limit runs out", () => {
  it("returns a complete report when nothing is rate-limited", async () => {
    const { report } = await scan("none");
    assert.equal(report.incomplete, undefined);
    assert.ok(report.checks.every((c) => c.status !== "skipped"));
  });

  it("stops calling HubSpot and returns a partial report marked incomplete", async () => {
    const { report, afterLimit } = await scan("daily", 20);
    assert.equal(afterLimit, 0, "no calls after the daily limit");
    assert.equal(report.incomplete?.kind, "daily_limit");
    assert.match(report.incomplete!.message, /daily HubSpot API allowance/);
    assert.match(report.incomplete!.message, /US\/Eastern/, "names the portal's time zone for the reset");

    // Checks that finished keep their findings and scores.
    assert.ok(report.findings.length > 0);
    const scored = report.checks.filter((c) => c.status === "scored");
    const notRun = report.checks.filter((c) => c.status === "skipped");
    assert.ok(scored.length > 0 && notRun.length > 0);
    assert.ok(notRun.every((c) => c.reason === "not run: HubSpot's rate limit ran out first"));
  });

  it("scores only the checks that finished, renormalizing the weights", async () => {
    const { report } = await scan("daily", 20);
    const unscored = report.score.categories.filter((c) => c.score === null).map((c) => c.category);
    assert.ok(report.score.overall !== null);
    // Whatever categories got no scored checks are left out, not counted as 0.
    for (const c of report.score.categories) {
      if (c.scored === 0) assert.ok(unscored.includes(c.category));
    }
  });

  it("does the same when 10-second retries run out", async () => {
    const { report } = await scan("always");
    assert.equal(report.incomplete?.kind, "rate_limited");
    assert.match(report.incomplete!.message, /stopped making calls/);
    assert.ok(report.retries > 0);
  });
});
