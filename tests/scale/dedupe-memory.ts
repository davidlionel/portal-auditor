// Memory and time for duplicate matching at 10,000, 250,000 and 1,000,000
// contacts, without the network: rows are generated 200 at a time (one
// Search page), reduced to matching keys and dropped, as in a scan. Each
// size runs in its own process so they don't share a heap.
// Run with: npm run bench:dedupe
import { execFileSync } from "node:child_process";
import { CHECKS_CONFIG } from "@/config/checks";
import { ContactStore, matchContacts } from "@/lib/dedupe/contacts";
import { createPortal, SIZE_250K } from "@/lib/simulator/portal";

const SIZES = [10_000, 250_000, 1_000_000];
const PAGE = 200;
const mb = (bytes: number) => (bytes / 2 ** 20).toFixed(1);

function measure(size: number) {
  const gc = (globalThis as { gc?: () => void }).gc!;
  // The simulated portal's contacts, with its planted duplicates.
  const portal = createPortal({ ...SIZE_250K, records: { ...SIZE_250K.records, contacts: size } });
  gc();
  const base = process.memoryUsage();
  const baseRss = process.resourceUsage().maxRSS * 1024;

  const started = performance.now();
  const store = new ContactStore(new Set(CHECKS_CONFIG.duplicates.freeEmailDomains));
  for (let start = 0; start < size; start += PAGE) {
    const page = Array.from({ length: Math.min(PAGE, size - start) }, (_, i) => portal.record("contacts", start + i));
    for (const row of page) store.add(row);
  }
  const read = performance.now() - started;
  gc();
  const held = process.memoryUsage().heapUsed - base.heapUsed;

  const matchStarted = performance.now();
  const result = matchContacts(store, CHECKS_CONFIG);
  const matched = performance.now() - matchStarted;
  const afterMatch = process.memoryUsage().heapUsed - base.heapUsed;
  // Peak resident memory of the whole process, above where it started.
  const peakRss = process.resourceUsage().maxRSS * 1024 - Math.max(baseRss, base.rss);

  console.log(
    JSON.stringify({
      contacts: size,
      keysHeldMb: mb(held),
      bytesPerContact: Math.round(held / size),
      heapAfterMatchMb: mb(afterMatch),
      peakRssMb: mb(Math.max(0, peakRss)),
      compared: result.compared,
      matches: result.matches.length,
      readSeconds: (read / 1000).toFixed(2),
      matchSeconds: (matched / 1000).toFixed(2),
    }),
  );
}

const size = Number(process.argv[2]);
if (size) {
  measure(size);
} else {
  console.log("| Contacts | Keys held | Per contact | Heap after matching | Peak process memory | Pairs compared | Matching time |");
  console.log("|---|---|---|---|---|---|---|");
  for (const n of SIZES) {
    const out = execFileSync(process.execPath, [...process.execArgv, process.argv[1], String(n)], { encoding: "utf8" });
    const r = JSON.parse(out.trim().split("\n").at(-1)!);
    console.log(
      `| ${n.toLocaleString("en-US")} | ${r.keysHeldMb} MB | ${r.bytesPerContact} bytes | ${r.heapAfterMatchMb} MB | ${r.peakRssMb} MB | ${r.compared.toLocaleString("en-US")} | ${r.matchSeconds} s |`,
    );
  }
}
