// A full duplicate scan of a simulated 100K, 500K or 1M-contact portal,
// through the real scan endpoint, in real time: HubSpot-like response times
// (list pages 250–650 ms), a rolling 10-second burst limit with HubSpot's
// headers, occasional 502s and 429s on searches. Reports calls, retries,
// time, peak memory, progress and the gaps between updates, against the
// estimate the page would have shown.
//
//   npm run test:full-scan -- 1m             (1m, 500k or 100k; default 100k)
//   npm run test:full-scan -- 500k --concurrency 2
//   npm run test:full-scan -- 100k --burst 100      (a Starter portal's limit)
//   npm run test:full-scan -- 100k --cancel         (cancel halfway)
//   npm run test:full-scan -- 100k --stop           (rate limit runs out partway)
import { CHECKS_CONFIG } from "@/config/checks";
import { FULL_READ_CONFIG } from "@/config/requests";
import type { Transport } from "@/lib/hubspot/client";
import { estimateFullScan } from "@/lib/scan-estimate";
import { HEARTBEAT_MS, handleScanRequest, type ScanStreamEvent } from "@/lib/scan-stream";
import { SIZE_1M, SIZE_250K, SIZE_500K, type PortalSize } from "@/lib/simulator/portal";
import { simulatorTransport, type SimulatorStats } from "@/lib/simulator/transport";

const KEY = "dummy-key-FULLSCANKEY0";
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const SIZES: Record<string, PortalSize> = {
  "100k": { ...SIZE_250K, records: { contacts: 100_000, companies: 12_000, deals: 6_000 } },
  "500k": SIZE_500K,
  "1m": SIZE_1M,
};
const sizeName = args.find((a) => SIZES[a]) ?? "100k";
const size = SIZES[sizeName];
const concurrency = value("concurrency") ?? FULL_READ_CONFIG.concurrency;
const burstMax = value("burst") ?? 190;

const logs: string[] = [];
console.info = (...a: unknown[]) => void logs.push(a.join(" "));

let stats: SimulatorStats | null = null;
let abortAt = Infinity;
const controller = new AbortController();
const deps = {
  liveScanEnabled: () => true,
  // The real-key path, answered by the simulator instead of HubSpot.
  makeTransport: (): Transport => {
    const sim = simulatorTransport({ size, latency: true, rateLimits: "realistic", seed: 11, burstMax, serverErrorRate: 0.0005 });
    stats = sim.stats;
    if (!flag("stop")) return sim.transport;
    // HubSpot's daily allowance runs out once half the contacts are read.
    let listCalls = 0;
    const half = Math.ceil(size.records.contacts / 200);
    return (req) =>
      req.method === "GET" && /\/contacts\?/.test(req.path) && ++listCalls > half
        ? Promise.resolve(new Response(JSON.stringify({ policyName: "DAILY" }), { status: 429 }))
        : sim.transport(req);
  },
  simulatorEnabled: () => false,
  loadSimulator: async (): Promise<Transport> => {
    throw new Error("not used");
  },
  fullScanEnabled: () => true,
  scanOptions: { config: CHECKS_CONFIG, fullRead: { ...FULL_READ_CONFIG, concurrency } },
};

function memorySampler() {
  (globalThis as { gc?: () => void }).gc?.();
  const base = process.memoryUsage();
  let heap = 0;
  let rss = 0;
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    heap = Math.max(heap, m.heapUsed + m.arrayBuffers - base.heapUsed - base.arrayBuffers);
    rss = Math.max(rss, m.rss - base.rss);
  }, 50);
  return () => {
    clearInterval(timer);
    return { heapMb: heap / 2 ** 20, rssMb: rss / 2 ** 20, maxRssMb: (process.resourceUsage().maxRSS * 1024 - base.rss) / 2 ** 20 };
  };
}

const mins = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

async function main() {
  const estimate = estimateFullScan(size.records.contacts, size.records.companies, { max: burstMax, windowMs: 10_000 }, {
    ...FULL_READ_CONFIG,
    concurrency,
  });
  console.log(
    `Full duplicate scan, simulated ${sizeName} portal (${size.records.contacts.toLocaleString("en-US")} contacts, ${size.records.companies.toLocaleString("en-US")} companies), ${concurrency} in flight, burst limit ${burstMax}/10 s${flag("cancel") ? ", cancelled halfway" : ""}${flag("stop") ? ", rate limit runs out halfway" : ""}`,
  );
  console.log(`Estimate shown before starting: about ${estimate.calls.toLocaleString("en-US")} calls, about ${estimate.minutes} minutes`);

  const stopSampling = memorySampler();
  const started = Date.now();
  const response = await handleScanRequest(
    new Request("http://localhost/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: KEY, fullDuplicates: true }),
      signal: controller.signal,
    }),
    deps,
  );

  const timed: { at: number; event: ScanStreamEvent }[] = [];
  let raw = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastPrint = 0;
  let cancelledAt: number | null = null;
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(chunk, { stream: true });
      raw += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line) as ScanStreamEvent;
        const at = Date.now() - started;
        timed.push({ at, event });
        if (event.type === "progress") {
          if (at - lastPrint > 60_000) {
            lastPrint = at;
            console.log(`  ${mins(at)}: ${event.percent}% ${event.phase}${event.detail ? ` · ${event.detail}` : ""} (${event.apiCalls} calls)`);
          }
          if (flag("cancel") && event.percent >= 50 && abortAt === Infinity) {
            abortAt = at;
            cancelledAt = Date.now();
            controller.abort();
          }
        }
      }
    }
  } catch {
    // The stream ends with an error once cancelled.
  }
  const elapsed = Date.now() - started;
  const memory = stopSampling();

  const progress = timed.flatMap(({ at, event }) => (event.type === "progress" ? [{ at, ...event }] : []));
  const gaps = timed.slice(1).map((t, i) => t.at - timed[i].at);
  const jumps = progress.slice(1).map((p, i) => p.percent - progress[i].percent);
  const halfway = progress.find((p) => p.at >= elapsed / 2)?.percent ?? 0;
  const done = timed.find((t) => t.event.type === "done")?.event;
  const report = done && done.type === "done" ? done.report : null;
  const s = stats as SimulatorStats | null;

  const rows: [string, string][] = [
    ["Time", `${mins(elapsed)} (estimate about ${estimate.minutes} min)`],
    ["API calls", `${report?.apiCalls.toLocaleString("en-US") ?? progress.at(-1)?.apiCalls} (estimate about ${estimate.calls.toLocaleString("en-US")})`],
    ["List calls", `${s?.listCalls.toLocaleString("en-US")}`],
    ["Retries", `${report?.retries ?? progress.at(-1)?.retries} (429s from the simulator: ${s?.rateLimited}; 502s: ${s?.serverErrors})`],
    ["Peak memory above baseline", `${memory.maxRssMb.toFixed(0)} MB process peak (sampled RSS ${memory.rssMb.toFixed(0)} MB, live heap and buffers ${memory.heapMb.toFixed(0)} MB)`],
    ["Longest gap between updates", `${(Math.max(...gaps) / 1000).toFixed(1)} s`],
    ["Largest progress jump", `${Math.max(0, ...jumps.slice(0, -1))} points; ${halfway}% at half time`],
  ];
  if (report) {
    const f = (id: string) => report.findings.find((x) => x.checkId === id);
    rows.push(
      ["Contacts, High duplicate groups", `${f("contacts.duplicates-high")?.count.toLocaleString("en-US")} (${f("contacts.duplicates-high")?.coverage})`],
      ["Companies, High duplicate groups", `${f("companies.duplicates-high")?.count.toLocaleString("en-US")} (${f("companies.duplicates-high")?.coverage})`],
      ["Malformed emails", `${f("contacts.malformed-email")?.count.toLocaleString("en-US")} of ${f("contacts.malformed-email")?.population.toLocaleString("en-US")}`],
      ["Incomplete", report.incomplete ? report.incomplete.kind : "no"],
    );
  }
  if (cancelledAt) {
    const endedAfter = timed.at(-1)!.at - abortAt;
    rows.push(["Cancelled at", `${mins(abortAt)}; stream ended ${(Math.max(0, endedAfter) / 1000).toFixed(1)} s later`]);
  }
  console.log("\n| Measure | Result |\n|---|---|");
  for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);

  // Checks.
  const checks: [string, boolean][] = [
    ["no key in the stream or logs", !raw.includes(KEY) && !logs.join("\n").includes(KEY)],
    ["progress never goes backwards", jumps.every((j) => j >= 0)],
    [`an update at least every ${HEARTBEAT_MS / 1000} s (plus one second)`, Math.max(...gaps) <= HEARTBEAT_MS + 1_000],
  ];
  if (flag("cancel")) {
    checks.push(["cancel ends the scan within 2 s", timed.at(-1)!.at - abortAt <= 2_000 || !report], ["no report after cancel", !report]);
  } else if (flag("stop")) {
    checks.push(
      ["report marked incomplete", report?.incomplete?.kind === "daily_limit"],
      ["contact duplicates matched on what was read, not scored", /^Checked [\d,]+ of [\d,]+ contacts, before HubSpot's rate limit/.test(report?.findings.find((x) => x.checkId === "contacts.malformed-email")?.coverage ?? "")],
    );
  } else {
    checks.push(
      ["report finished", Boolean(report) && !report!.incomplete],
      ["checked every contact", report?.findings.find((x) => x.checkId === "contacts.malformed-email")?.population === size.records.contacts],
      ["no progress jump over 10 points", Math.max(0, ...jumps.slice(0, -1)) <= 10],
      ["30–70% at half time", halfway >= 30 && halfway <= 70],
      ["list calls never hit the burst limit", (s?.rateLimited ?? 0) === 0 || logs.every((l) => !/GET \/crm\/objects\/[^ ]+\?limit[^ ]* -> 429/.test(l))],
    );
  }
  console.log("");
  for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  process.exitCode = checks.every(([, ok]) => ok) ? 0 : 1;
}

void main();
