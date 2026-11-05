import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fullScanEnabled } from "@/lib/live-scan";
import { estimateFullScan, handleEstimateRequest } from "@/lib/scan-estimate";
import { handleScanRequest, type ScanStreamDeps } from "@/lib/scan-stream";
import { SIZE_1M, SIZE_SMALL } from "@/lib/simulator/portal";
import { simulatorTransport } from "@/lib/simulator/transport";

const KEY = "dummy-key-ESTIMATEKEYNOLOG";
const logged: string[] = [];
console.info = (...args: unknown[]) => void logged.push(args.join(" "));

const deps = (size = SIZE_1M, overrides: Partial<ScanStreamDeps> = {}): ScanStreamDeps => ({
  liveScanEnabled: () => true,
  makeTransport: () => simulatorTransport({ size, rateLimits: "none" }).transport,
  simulatorEnabled: () => false,
  loadSimulator: async () => simulatorTransport({ size, rateLimits: "none" }).transport,
  fullScanEnabled: () => true,
  ...overrides,
});

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("full scan estimate", () => {
  it("counts about one call per 100 records, plus the rest of the scan", () => {
    const e = estimateFullScan(1_000_000, 120_000, { max: 190, windowMs: 10_000 });
    // 10,000 + 1,200 list pages, 26 planning calls each, 470 others, less
    // the 100 search pages the full read replaces.
    assert.equal(e.calls, 11_622);
    assert.equal(e.minutes, 31);
    assert.equal(e.needed, true);
    assert.equal(estimateFullScan(500_000, 60_000, { max: 190, windowMs: 10_000 }).minutes, 17);
  });

  it("is slower when the burst limit is lower than 3 calls in flight can use", () => {
    const starter = estimateFullScan(1_000_000, 120_000, { max: 40, windowMs: 10_000 });
    assert.ok(starter.minutes > estimateFullScan(1_000_000, 120_000, { max: 190, windowMs: 10_000 }).minutes);
  });

  it("warns when the scan would use most of today's allowance, and blocks when it would run out", () => {
    assert.equal(estimateFullScan(1_000_000, 0, { daily: 250_000, dailyRemaining: 200_000 }).daily, "ok");
    assert.equal(estimateFullScan(1_000_000, 0, { daily: 250_000, dailyRemaining: 15_000 }).daily, "warn");
    assert.equal(estimateFullScan(1_000_000, 0, { daily: 250_000, dailyRemaining: 9_000 }).daily, "block");
  });

  it("says a full scan isn't needed when every record is already checked", () => {
    assert.equal(estimateFullScan(10_000, 2_000, {}).needed, false);
  });

  it("asks HubSpot for the counts and limits, and never logs the key", async () => {
    const response = await handleEstimateRequest(post("http://localhost/api/scan/estimate", { token: KEY }), deps());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.estimate.contacts, 1_000_000);
    assert.equal(body.estimate.companies, 120_000);
    assert.equal(body.estimate.dailyLimit, 1_000_000);
    assert.ok(!logged.join("\n").includes(KEY));
    assert.ok(!JSON.stringify(body).includes(KEY));
  });
});

describe("where a full scan may run", () => {
  it("is everywhere except Vercel", () => {
    assert.equal(fullScanEnabled({}), true);
    assert.equal(fullScanEnabled({ VERCEL: "1" }), false);
    assert.equal(fullScanEnabled({ VERCEL: "1", ENABLE_LIVE_SCAN: "true" }), false);
  });

  it("refuses a full scan or its estimate where it can't run, before using the key", async () => {
    let made = 0;
    const off = deps(SIZE_SMALL, {
      fullScanEnabled: () => false,
      makeTransport: () => {
        made++;
        return simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport;
      },
    });
    const scan = await handleScanRequest(post("http://localhost/api/scan", { token: KEY, fullDuplicates: true }), off);
    assert.equal(scan.status, 403);
    assert.match(await scan.text(), /run the app on your own machine/i);
    const estimate = await handleEstimateRequest(post("http://localhost/api/scan/estimate", { token: KEY, fullDuplicates: true }), off);
    assert.equal(estimate.status, 403);
    assert.equal(made, 0);
  });
});
