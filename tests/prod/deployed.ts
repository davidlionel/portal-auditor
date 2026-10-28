// Checks a running deployment is demo-only and safe: the sample report
// renders with no record links, the scan endpoint refuses service keys and
// the simulator, and no simulator code is served. Plain Node, so it works in
// PowerShell and bash.
// Run with: npm run check:deploy -- https://your-site.vercel.app
// (defaults to http://localhost:3000 for a local `npm start`).

const BASE = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
// Strings that exist only in the simulator's code.
const SIMULATOR_ONLY = ["acmegrinding.example", "Simulated property.", "ten_secondly_rolling limit"];

async function scan(body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(`${BASE}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function main() {
  console.log(`Checking ${BASE}\n`);
  const results: [string, boolean][] = [];

  const home = await fetch(BASE);
  const homeHtml = await home.text();
  results.push(["home page loads", home.ok]);
  results.push(["home page links to the sample report", homeHtml.includes('href="/demo"')]);
  results.push(["home page has no service-key field", !homeHtml.includes('name="token"')]);
  results.push(["home page has no simulated-scan button", !homeHtml.includes("Run simulated 250K scan")]);

  const demo = await fetch(`${BASE}/demo`);
  const demoHtml = await demo.text();
  results.push(["sample report loads", demo.ok]);
  results.push(["sample report shows a score", /out of 100/.test(demoHtml)]);
  results.push(["sample report shows the scan date banner", /Sample report[\s\S]*scanned on/.test(demoHtml)]);
  results.push(["sample report has no HubSpot record links", !/href="https:\/\/app[^"]*\/record\//.test(demoHtml)]);
  results.push(["sample report has CSV exports", demoHtml.includes("Findings summary (CSV)")]);

  const live = await scan({ token: "pat-na1-00000000-0000-0000-0000-000000000000" });
  results.push(["scan endpoint refuses a service key (403)", live.status === 403 && /sample report only/.test(live.text)]);
  const simulated = await scan({ mode: "simulated" });
  results.push(["scan endpoint refuses the simulator (403)", simulated.status === 403]);

  // Every script the two pages load.
  const scripts = [...new Set([...`${homeHtml}${demoHtml}`.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
  const code = (await Promise.all(scripts.map(async (src) => (await fetch(`${BASE}${src}`)).text()))).join("\n");
  results.push([`browser scripts found (${scripts.length})`, scripts.length > 0]);
  for (const marker of SIMULATOR_ONLY) {
    results.push([`browser scripts don't contain "${marker}"`, !code.includes(marker)]);
  }

  for (const [name, passed] of results) console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
  if (results.some(([, passed]) => !passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Couldn't reach ${BASE}: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
