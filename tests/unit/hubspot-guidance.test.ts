import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import { CHECK_GUIDES, GUIDANCE, IMPORT_STEPS, isGuidanceId, type GuidanceEntry } from "@/config/hubspot-guidance";
import { checkSource } from "@/lib/guidance/check-source";
import { missingPhrases, pageText } from "@/lib/guidance/page-text";
import { staleGuidance } from "@/lib/guidance/stale";
import { runScan } from "@/lib/scan";
import { SIZE_SMALL } from "@/lib/simulator/portal";
import { simulatorTransport } from "@/lib/simulator/transport";

console.info = () => {};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const entries = Object.entries(GUIDANCE) as [string, GuidanceEntry][];

describe("HubSpot guidance file", () => {
  it("gives every sourced entry a HubSpot docs URL and key phrases", () => {
    for (const [id, entry] of entries) {
      if (entry.general) {
        assert.equal(entry.source, undefined, `${id}: general guidance has no source`);
        continue;
      }
      assert.match(entry.source, /^https:\/\/(knowledge|developers)\.hubspot\.com\//, `${id}: source`);
      assert.ok(entry.keyPhrases.length > 0, `${id}: needs at least one key phrase`);
      for (const phrase of entry.keyPhrases) {
        assert.ok(phrase.trim().length >= 3, `${id}: empty key phrase`);
        assert.doesNotMatch(phrase, /[.:;,]$/, `${id}: key phrase "${phrase}" ends in punctuation`);
      }
    }
  });

  it("dates every entry with a real lastVerified date that isn't in the future", () => {
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    for (const [id, entry] of entries) {
      assert.match(entry.lastVerified, DATE, `${id}: lastVerified must be YYYY-MM-DD`);
      const time = Date.parse(entry.lastVerified);
      assert.ok(!Number.isNaN(time) && time < tomorrow, `${id}: lastVerified ${entry.lastVerified}`);
    }
  });

  it("warns, without failing, about entries not verified for over 90 days", (t) => {
    const stale = staleGuidance(new Date());
    for (const e of stale) {
      const message = `HubSpot guidance "${e.id}" was last verified ${e.days} days ago (${e.lastVerified}). Re-read its source and update lastVerified.`;
      t.diagnostic(message);
      console.warn(`WARNING: ${message}`);
    }
  });

  it("finds stale entries by age", () => {
    const guidance = {
      fresh: { text: "a", general: true as const, lastVerified: "2026-10-01" },
      old: { text: "b", general: true as const, lastVerified: "2026-06-01" },
    };
    assert.deepEqual(
      staleGuidance(new Date("2026-10-28T12:00:00Z"), 90, guidance).map((e) => e.id),
      ["old"],
    );
  });

  it("has a guide for every check the scan runs, using only known entries", async () => {
    const result = await runScan(simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport, {
      config: { ...CHECKS_CONFIG, searchMinIntervalMs: 0 },
    });
    assert.ok(result.ok);
    const checkIds = new Set(result.report.checks.map((c) => c.checkId));
    assert.ok(checkIds.size >= 16, "every check is attempted on the simulated portal");
    for (const id of checkIds) assert.ok(CHECK_GUIDES[id], `no playbook guide for ${id}`);

    for (const [id, guide] of Object.entries(CHECK_GUIDES)) {
      assert.ok(checkIds.has(id), `guide for unknown check ${id}`);
      for (const condition of guide.filter ?? []) {
        if (condition.value && /^[a-z]+[A-Z]/.test(condition.value)) {
          assert.ok(isGuidanceId(condition.value), `${id}: unknown value entry ${condition.value}`);
        }
      }
      assert.equal(guide.csv === "none", Boolean(guide.filter), `${id}: "No CSV needed" exactly when a filter finds every record`);
    }
    assert.ok(IMPORT_STEPS.length > 0);
  });

  it("words each fix for its object and puts deleting last", () => {
    const text = (checkId: string) => CHECK_GUIDES[checkId].steps.map((step) => GUIDANCE[step as keyof typeof GUIDANCE].text);
    for (const tier of ["medium", "low"]) {
      const contacts = text(`contacts.duplicates-${tier}`).join(" ");
      const companies = text(`companies.duplicates-${tier}`).join(" ");
      assert.match(contacts, /the same person\./);
      assert.doesNotMatch(contacts, /company\./);
      assert.match(companies, /the same company\./);
      assert.doesNotMatch(companies, /person/);
    }

    const steps = CHECK_GUIDES["contacts.missing-email"].steps;
    assert.ok(steps.indexOf("findMissingEmail") >= 0 && steps.indexOf("findMissingEmail") < steps.indexOf("deleteContactsLastResort"));
    assert.equal(steps.at(-1), "deleteContactsLastResort");
    assert.match(GUIDANCE.deleteContactsLastResort.text, /last resort/);

    assert.deepEqual(CHECK_GUIDES["contacts.customer-without-won-deal"].steps.slice(-2), ["bulkEditLifecycleBackward", "lifecycleBackward"]);
    assert.match(GUIDANCE.bulkEditLifecycleBackward.text, /Bulk edit can move a stage backward \(tested in a HubSpot portal on 29 Oct 2026\)/);
    assert.doesNotMatch(GUIDANCE.bulkEditLifecycleBackward.text, /check/);
    assert.match(GUIDANCE.lifecycleBackward.text, /^Imports, workflows and the API only move Lifecycle stage forward\..*clear the value first/);
  });
});

describe("docs page text", () => {
  it("strips tags and scripts, decodes entities and tidies spacing", () => {
    const html = `<p>Click <b>Create a contact segment</b> :&nbsp;it&#39;s&rsquo;s <script>var x = "hidden";</script>done</p>`;
    assert.equal(pageText(html), "Click Create a contact segment: it's's done");
  });

  it("matches key phrases case-insensitively and lists the missing ones", () => {
    const text = pageText("<p>Merged records <em>cannot</em> be reverted.</p>");
    assert.deepEqual(missingPhrases(text, ["merged records cannot be reverted", "Merge all"]), ["Merge all"]);
  });
});

describe("docs page check", () => {
  const phrases = [{ id: "mergeRecords", phrase: "Merged records cannot be reverted" }];
  const page = (body: string, status = 200, headers: Record<string, string> = {}) =>
    (async () => new Response(body, { status, headers })) as unknown as typeof fetch;

  it("passes a page that loads and has its phrases", async () => {
    assert.equal(await checkSource("https://x", phrases, page("<p>Merged records cannot be reverted.</p>")), null);
  });

  it("fails a page that redirects, without following it", async () => {
    const problem = await checkSource("https://x", phrases, page("", 301, { location: "https://y" }));
    assert.match(problem ?? "", /Redirects \(301\) to https:\/\/y/);
  });

  it("fails a missing page", async () => {
    assert.match((await checkSource("https://x", phrases, page("", 404))) ?? "", /Returned 404/);
  });

  it("names the entry whose phrase disappeared", async () => {
    const problem = await checkSource("https://x", phrases, page("<p>Merges are final.</p>"));
    assert.match(problem ?? "", /`mergeRecords`: "Merged records cannot be reverted"/);
  });

  it("retries a network error once, then reports it as unreachable", async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    assert.match((await checkSource("https://x", phrases, flaky)) ?? "", /Couldn't reach the page \(ECONNRESET\)/);
    assert.equal(calls, 2);
  });
});
