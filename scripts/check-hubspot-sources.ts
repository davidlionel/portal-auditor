// Checks that every HubSpot page cited in src/config/hubspot-guidance.ts
// still loads without a redirect and still contains its key phrases.
// Run with: npm run check:hubspot-docs [-- --report <file>]
// With --report, writes a Markdown summary of any failures to <file> (and
// writes nothing when everything passes). Always exits 0: a changed docs
// page is a reason to review the guidance, not to fail a build.
import { writeFileSync } from "node:fs";
import { GUIDANCE, type GuidanceEntry } from "../src/config/hubspot-guidance";
import { checkSource, type SourcePhrase } from "../src/lib/guidance/check-source";

// Every source page with the entries and phrases that rely on it.
function sources(): Map<string, { entries: string[]; phrases: SourcePhrase[] }> {
  const pages = new Map<string, { entries: string[]; phrases: SourcePhrase[] }>();
  for (const [id, entry] of Object.entries(GUIDANCE) as [string, GuidanceEntry][]) {
    if (!entry.source) continue;
    const page = pages.get(entry.source) ?? { entries: [], phrases: [] };
    page.entries.push(id);
    page.phrases.push(...entry.keyPhrases.map((phrase) => ({ id, phrase })));
    pages.set(entry.source, page);
  }
  return pages;
}

async function main() {
  const reportPath = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1] : undefined;
  const pages = sources();
  const failures: string[] = [];
  for (const [url, { entries, phrases }] of pages) {
    const problem = await checkSource(url, phrases);
    console.log(`${problem ? "FAIL" : "PASS"}  ${url}`);
    if (!problem) continue;
    console.log(`      ${problem.replace(/\n/g, "\n      ")}`);
    failures.push(`### ${url}\nUsed by: ${entries.map((e) => `\`${e}\``).join(", ")}\n\n${problem}\n`);
  }
  console.log(`\n${pages.size - failures.length} of ${pages.size} pages passed.`);

  if (reportPath && failures.length) {
    writeFileSync(
      reportPath,
      [
        `The weekly check found ${failures.length} HubSpot page${failures.length === 1 ? "" : "s"} that changed since the playbook guidance was last verified.`,
        "Re-read each page, update the entries in `src/config/hubspot-guidance.ts` (text, source, key phrases) and set their `lastVerified` date.",
        "",
        ...failures,
      ].join("\n"),
    );
  }
}

main().catch((error) => {
  // A bug in the checker itself should be visible, but still not fail a build.
  console.error(`The docs check couldn't run: ${error instanceof Error ? error.stack : error}`);
});
