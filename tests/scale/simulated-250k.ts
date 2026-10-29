// Scale test: a full scan of the simulated 250K-contact portal through the
// real /api/scan handler, with real pacing, HubSpot-like latency and
// injected 429s. Takes about two minutes. Run with: npm run test:scale
import { handleScanRequest, type ScanStreamEvent } from "@/lib/scan-stream";
import { SIZE_250K } from "@/lib/simulator/portal";
import { simulatorTransport, type SimulatorStats } from "@/lib/simulator/transport";

// The README's estimate before this test existed.
const ESTIMATE = { calls: 445, seconds: 110 };
// A fake key, sent the way a real one is, to prove it never leaks.
const KEY = "pat-na1-00000000-0000-0000-0000-SCALETESTKEY";

const logs: string[] = [];
console.info = (...args: unknown[]) => void logs.push(args.join(" "));

let stats: SimulatorStats = { requests: 0, rateLimited: 0 };
const deps = {
  liveScanEnabled: () => true,
  // The real-key path, answered by the simulator instead of HubSpot.
  makeTransport: () => {
    const sim = simulatorTransport({ size: SIZE_250K, latency: true, rateLimits: "realistic", seed: 7 });
    stats = sim.stats;
    return sim.transport;
  },
  simulatorEnabled: () => false,
  loadSimulator: async () => {
    throw new Error("not used");
  },
};

type Timed = { at: number; event: ScanStreamEvent };

// Peak memory during the scan, sampled every 20 ms. The baseline is taken
// after a garbage collection (run with --expose-gc), so the peak above it is
// what the scan itself held. Matching runs without yielding, so the sampler
// can miss its peak; the process's own peak resident memory (maxRSS) can't.
function memorySampler() {
  (globalThis as { gc?: () => void }).gc?.();
  const base = process.memoryUsage();
  let heap = base.heapUsed;
  let rss = base.rss;
  const timer = setInterval(() => {
    const now = process.memoryUsage();
    heap = Math.max(heap, now.heapUsed);
    rss = Math.max(rss, now.rss);
  }, 20);
  return () => {
    clearInterval(timer);
    const maxRss = process.resourceUsage().maxRSS * 1024;
    return {
      heapMb: (heap - base.heapUsed) / 2 ** 20,
      rssMb: (rss - base.rss) / 2 ** 20,
      maxRssMb: (maxRss - base.rss) / 2 ** 20,
      gc: Boolean((globalThis as { gc?: unknown }).gc),
    };
  };
}

async function main() {
  const stopSampling = memorySampler();
  const started = Date.now();
  const response = await handleScanRequest(
    new Request("http://localhost/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: KEY }),
    }),
    deps,
  );

  const timed: Timed[] = [];
  let raw = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastPrint = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    raw += text;
    buffer += text;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line) as ScanStreamEvent;
      timed.push({ at: Date.now() - started, event });
      if (event.type === "progress" && (Date.now() - lastPrint > 5000 || event.waitingMs)) {
        lastPrint = Date.now();
        process.stdout.write(
          `  ${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s ${String(event.percent).padStart(3)}%  ${event.phase}${event.detail ? ` · ${event.detail}` : ""}\n`,
        );
      }
    }
  }

  const progress = timed.flatMap((t) => (t.event.type === "progress" ? [{ at: t.at, ...t.event }] : []));
  const last = timed.at(-1)?.event;
  if (last?.type !== "done") throw new Error(`scan did not finish: ${JSON.stringify(last)}`);
  const report = last.report;
  const groups = (checkId: string) => report.findings.find((f) => f.checkId === checkId)?.count ?? 0;
  const seconds = (Date.now() - started) / 1000;
  const memory = stopSampling();

  // Gaps between updates, except ones the scan announced as a rate-limit wait.
  let maxGap = 0;
  let maxGapAt = "";
  for (let i = 1; i < progress.length; i++) {
    const gap = progress[i].at - progress[i - 1].at;
    const announced = (progress[i - 1].waitingMs ?? 0) + 1000;
    if (gap > maxGap && gap > announced - 1000 && !(progress[i - 1].waitingMs && gap <= announced)) {
      maxGap = gap;
      maxGapAt = progress[i - 1].phase;
    }
  }
  const phases: { phase: string; start: number; percent: number }[] = [];
  for (const p of progress) {
    if (phases.at(-1)?.phase !== p.phase) phases.push({ phase: p.phase, start: p.at, percent: p.percent });
  }

  // The bar should move steadily, not jump: the first scale run sat at 99%
  // from 1.4 s because setup filled the whole plan.
  const biggestJump = Math.max(0, ...progress.slice(1).map((p, i) => p.percent - progress[i].percent).slice(0, -1));
  const halfway = progress.find((p) => p.at >= (seconds * 1000) / 2)?.percent ?? 0;
  const afterSetup = progress.find((p) => p.phase !== "Reading portal setup")?.percent ?? 100;

  const checks = [
    ["progress never jumps more than 10 points", biggestJump <= 10],
    ["progress is 30–70% halfway through the scan", halfway >= 30 && halfway <= 70],
    ["progress is under 10% when setup ends", afterSetup < 10],
    ["progress never goes backwards", progress.every((p, i) => i === 0 || p.percent >= progress[i - 1].percent)],
    ["progress ends at 100", progress.at(-1)?.percent === 100],
    ["progress stays under 100 until done", progress.slice(0, -1).every((p) => p.percent < 100)],
    ["no silent gap over 3s", maxGap <= 3000],
    ["report counts every call the portal received", report.apiCalls === stats.requests],
    ["retries match the 429s served", report.retries === stats.rateLimited],
    ["scan completed (not stopped by the rate limit)", report.incomplete === undefined],
    ["work lists capped at 1,000 on the big checks", report.notes.some((n) => /first 1,000 of 10,000/.test(n))],
    // Planted in the newest 10,000 of each (see src/lib/simulator/portal.ts).
    ["contact duplicates: 150 High, 83 Medium, 20 Low", groups("contacts.duplicates-high") === 150 && groups("contacts.duplicates-medium") === 83 && groups("contacts.duplicates-low") === 20],
    ["company duplicates: 221 High, 200 Medium, 40 Low", groups("companies.duplicates-high") === 221 && groups("companies.duplicates-medium") === 200 && groups("companies.duplicates-low") === 40],
    ["only High duplicates are scored", report.checks.filter((c) => /duplicates-(medium|low)/.test(c.checkId)).every((c) => c.status === "unscored")],
    ["the switchboard number is set aside", report.notes.some((n) => /1 phone number is shared/.test(n))],
    ["key never in the stream", !raw.includes("SCALETESTKEY")],
    ["key never in the logs", logs.every((l) => !l.includes("SCALETESTKEY"))],
  ] as const;

  console.log("\n## Simulated 250K scan\n");
  console.log("| Measure | Result | README estimate |");
  console.log("|---|---|---|");
  console.log(`| API calls | ${report.apiCalls} (${report.apiCalls - report.retries} + ${report.retries} retries) | about ${ESTIMATE.calls} |`);
  console.log(`| 429s injected | ${stats.rateLimited} | |`);
  console.log(`| Scan time | ${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s | about ${Math.floor(ESTIMATE.seconds / 60)} min ${ESTIMATE.seconds % 60} s |`);
  console.log(`| Progress updates | ${progress.length} | |`);
  console.log(`| Longest gap between updates (not counting announced waits) | ${(maxGap / 1000).toFixed(1)} s (${maxGapAt}) | |`);
  console.log(`| Biggest jump between updates | ${biggestJump} points | |`);
  console.log(`| Percent halfway through (by time) | ${halfway}% | |`);
  console.log(`| Peak memory above baseline | heap ${memory.heapMb.toFixed(1)} MB, RSS ${memory.rssMb.toFixed(1)} MB (sampled), peak RSS ${memory.maxRssMb.toFixed(1)} MB${memory.gc ? "" : " (no --expose-gc)"} | |`);
  console.log(`| Score | ${report.score.overall?.toFixed(1)} | |`);
  console.log("\n| Phase | Starts at | Percent at start |");
  console.log("|---|---|---|");
  for (const p of phases) console.log(`| ${p.phase} | ${(p.start / 1000).toFixed(1)} s | ${p.percent}% |`);
  console.log("\nChecks:");
  for (const [name, passed] of checks) console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}`);
  if (checks.some(([, passed]) => !passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
