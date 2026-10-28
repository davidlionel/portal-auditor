// Scans the developer test portal and saves the report as the public demo
// snapshot (src/demo/snapshot.json). Run locally with: npm run demo:snapshot
// Reads HUBSPOT_TOKEN from .env.local; the key is used for this scan only and
// never written anywhere.
import { readFileSync, writeFileSync } from "node:fs";
import { validateSnapshot, type DemoSnapshot } from "@/lib/demo/snapshot";
import { hubspotTransport } from "@/lib/hubspot/client";
import { ERROR_MESSAGES } from "@/lib/messages";
import { runScan } from "@/lib/scan";

const OUTPUT = "src/demo/snapshot.json";

function fail(message: string): never {
  console.error(`\nNo snapshot written: ${message}`);
  process.exit(1);
}

async function main() {
  const token = process.env.HUBSPOT_TOKEN?.trim();
  if (!token) fail("add HUBSPOT_TOKEN=<your test portal's service key> to .env.local.");

  // Per-call [hubspot] lines are noise here; progress is printed instead.
  console.info = () => {};
  let lastPhase = "";
  const result = await runScan(hubspotTransport(token), {
    onProgress: (e) => {
      if (e.phase === lastPhase) return;
      lastPhase = e.phase;
      console.log(`  ${String(e.percent).padStart(3)}%  ${e.phase}`);
    },
  });
  if (!result.ok) fail(ERROR_MESSAGES[result.kind]);
  const { report } = result;
  if (report.incomplete) fail(`the scan was cut short. ${report.incomplete.message}`);
  // The brief: never real client data. Only a developer test portal may be published.
  if (report.portal.accountType !== "DEVELOPER_TEST") {
    fail(`portal ${report.portal.portalId} is a ${report.portal.accountType} account. Only a developer test portal can be the public sample.`);
  }

  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const snapshot: DemoSnapshot = { scannedAt: new Date().toISOString(), appVersion: version, report };
  const errors = validateSnapshot(snapshot);
  if (errors.length) fail(`it contains something other than IDs, property names, counts and portal details:\n  ${errors.join("\n  ")}`);

  const json = JSON.stringify(snapshot, null, 2) + "\n";
  writeFileSync(OUTPUT, json);
  const ids = report.findings.reduce((n, f) => n + (f.records?.length ?? 0), 0);
  console.log(`\nSaved ${OUTPUT} (${(json.length / 1024).toFixed(0)} KB), scanned ${snapshot.scannedAt}.`);
  console.log(`Portal ${report.portal.portalId}: ${report.findings.length} findings, ${ids} record IDs, score ${Math.round(report.score.overall ?? 0)}, ${report.apiCalls} API calls.`);
  console.log("Checked: only record IDs, property names and labels, counts, check text and portal details.");
}

main().catch(() => fail(ERROR_MESSAGES.unexpected));
