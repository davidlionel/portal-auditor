import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import { FULL_READ_CONFIG, RETRY_CONFIG } from "@/config/requests";
import type { Transport } from "@/lib/hubspot/client";
import type { ProgressEvent } from "@/lib/progress";
import { runScan, type ScanOptions, type ScanReport } from "@/lib/scan";
import { SIZE_SMALL, type PortalSize } from "@/lib/simulator/portal";
import { simulatorTransport } from "@/lib/simulator/transport";

console.info = () => {};

// Big enough that the newest 10,000 leaves records out: contact 100013000
// (index 13,000) is planted as a copy of contact 100001000, and company
// 200019920 shares company 200010120's domain. Only a full scan sees them.
const SIZE: PortalSize = { ...SIZE_SMALL, records: { contacts: 25_000, companies: 20_000, deals: 60 } };
const options: ScanOptions = {
  config: { ...CHECKS_CONFIG, searchMinIntervalMs: 0 },
  retry: { ...RETRY_CONFIG, jitter: 0 },
  sleep: async () => {},
  // HubSpot's burst limit, made high enough for a unit test.
  fullRead: { ...FULL_READ_CONFIG, fallbackMax: 1_000_000 },
};
const sim = (extra = {}) => simulatorTransport({ size: SIZE, rateLimits: "none", burstMax: 1_000_000, ...extra });

async function scan(full: boolean, transport: Transport = sim().transport, extra: ScanOptions = {}) {
  const result = await runScan(transport, { ...options, fullDuplicates: full, ...extra });
  assert.ok(result.ok, "scan finished");
  return result.report;
}

const finding = (report: ScanReport, checkId: string) => report.findings.find((f) => f.checkId === checkId);
const sameGroup = (report: ScanReport, checkId: string, a: string, b: string) =>
  (finding(report, checkId)?.records ?? []).some((r) => r.id === a) &&
  finding(report, checkId)!.records!.find((r) => r.id === a)!.group === finding(report, checkId)!.records!.find((r) => r.id === b)?.group;

describe("full duplicate scan", () => {
  it("finds duplicates outside the newest 10,000 that the normal scan can't see", async () => {
    const window = await scan(false);
    const full = await scan(true);
    assert.ok(!sameGroup(window, "contacts.duplicates-high", "100013000", "100001000"));
    assert.ok(sameGroup(full, "contacts.duplicates-high", "100013000", "100001000"));
    assert.ok(sameGroup(full, "companies.duplicates-high", "200019920", "200010120"));
    assert.equal(full.fullDuplicates, true);
    assert.equal(window.fullDuplicates, undefined);
  });

  it("says what it covered, either way, on every duplicate and email finding", async () => {
    const window = await scan(false);
    const full = await scan(true);
    assert.equal(finding(window, "contacts.duplicates-high")?.coverage, "Checked the newest 10,000 of 25,000 contacts.");
    assert.equal(finding(full, "contacts.duplicates-high")?.coverage, "Checked all 25,000 contacts.");
    assert.equal(finding(full, "companies.duplicates-high")?.coverage, "Checked all 20,000 companies.");
    assert.equal(finding(full, "contacts.malformed-email")?.coverage, "Checked all 25,000 contacts.");
    assert.ok(full.notes.includes("Contacts duplicate and email checks covered all 25,000 contacts."));
    assert.match(window.notes.join("\n"), /Contacts duplicate and email checks covered the newest 10,000 of 25,000 contacts\. On Professional/);
  });

  it("checks every contact's email too", async () => {
    const email = finding(await scan(true), "contacts.malformed-email")!;
    // Every 250th contact has a typo domain.
    assert.equal(email.population, 25_000);
    assert.equal(email.count, 100);
  });

  it("uses the list endpoint, 100 a page, and makes about one call per 100 records", async () => {
    const s = sim();
    const report = await scan(true, s.transport);
    const pages = Math.ceil(25_000 / 100) + Math.ceil(20_000 / 100);
    assert.ok(s.stats.listCalls >= pages && s.stats.listCalls <= pages + 60, `list calls ${s.stats.listCalls}`);
    assert.ok(report.apiCalls < (await scan(false)).apiCalls + pages + 150);
  });

  it("matches what it read when the rate limit stops it, and doesn't score that", async () => {
    const s = sim();
    let listCalls = 0;
    const limited: Transport = async (req) => {
      if (req.method === "GET" && /\/crm\/objects\/[\w-]+\/contacts\?/.test(req.path) && ++listCalls > 120) {
        return new Response(JSON.stringify({ policyName: "DAILY" }), { status: 429 });
      }
      return s.transport(req);
    };
    const report = await scan(true, limited);
    assert.equal(report.incomplete?.kind, "daily_limit");
    const coverage = finding(report, "contacts.malformed-email")?.coverage ?? "";
    assert.match(coverage, /^Checked [\d,]+ of 25,000 contacts, before HubSpot's rate limit stopped the read\. Not scored: the read didn't finish\.$/);
    const run = report.checks.find((c) => c.checkId === "contacts.duplicates-high")!;
    assert.equal(run.status, "unscored");
    assert.match(run.reason ?? "", /^partial: /);
  });

  it("stops promptly when cancelled mid-read", async () => {
    const controller = new AbortController();
    const s = sim({ latency: true });
    let listCalls = 0;
    const watched: Transport = (req) => {
      if (req.method === "GET" && req.path.includes("?limit=") && ++listCalls === 20) setTimeout(() => controller.abort(), 0);
      return s.transport(req);
    };
    const started = Date.now();
    const result = await runScan(watched, { ...options, fullDuplicates: true, signal: controller.signal });
    assert.deepEqual(result, { ok: false, kind: "cancelled" });
    assert.ok(listCalls < 40, `kept calling: ${listCalls}`);
    void started;
  });

  // Smoothness over time is checked by the real-time scale runs; here the
  // plan has to be close to the calls actually made.
  it("plans the full read closely enough that the bar ends near 100, never going backwards", async () => {
    const percents: number[] = [];
    await scan(true, sim().transport, { onProgress: (e: ProgressEvent) => percents.push(e.percent) });
    for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1]);
    assert.equal(percents.at(-1), 100);
    assert.ok(percents.at(-2)! >= 85, `bar at ${percents.at(-2)}% just before the end`);
  });

  it("reads the newest 10,000 as before when the option is off, or when there are no more", async () => {
    const small = await runScan(simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport, { ...options, fullDuplicates: true });
    assert.ok(small.ok);
    assert.equal(finding(small.report, "contacts.duplicates-high")?.coverage, "Checked all 900 contacts.");
  });
});
