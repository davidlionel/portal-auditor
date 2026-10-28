import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKS_CONFIG } from "@/config/checks";
import { handleScanRequest, type ScanStreamDeps, type ScanStreamEvent } from "@/lib/scan-stream";
import { SIZE_SMALL } from "@/lib/simulator/portal";
import { simulatorTransport } from "@/lib/simulator/transport";

const KEY = "pat-na1-11111111-2222-3333-4444-TESTKEYDONOTLOG";

// Captures console output so tests can check the key never reaches logs.
const logged: string[] = [];
console.info = (...args: unknown[]) => void logged.push(args.join(" "));

function deps(overrides: Partial<ScanStreamDeps> = {}) {
  const made: string[] = [];
  const d: ScanStreamDeps = {
    // Stands in for HubSpot with the small simulated portal.
    makeTransport: (token) => {
      made.push(token);
      return simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport;
    },
    simulatorEnabled: () => false,
    loadSimulator: async () => simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport,
    scanOptions: { config: { ...CHECKS_CONFIG, searchMinIntervalMs: 0 } },
    ...overrides,
  };
  return { d, made };
}

const post = (body: unknown) =>
  new Request("http://localhost/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function read(response: Response): Promise<{ raw: string; events: ScanStreamEvent[] }> {
  const raw = await response.text();
  return { raw, events: raw.trim().split("\n").map((l) => JSON.parse(l) as ScanStreamEvent) };
}

describe("POST /api/scan", () => {
  it("streams progress lines, then the report", async () => {
    const { d } = deps();
    const response = await handleScanRequest(post({ token: KEY }), d);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const { events } = await read(response);
    const progress = events.filter((e) => e.type === "progress");
    assert.ok(progress.length > 5);
    assert.equal(progress[0].type === "progress" && progress[0].phase, "Reading portal setup");
    const last = events.at(-1)!;
    assert.equal(last.type, "done");
    assert.equal(last.type === "done" && last.report.simulated, false);
  });

  it("never puts the key in the stream or the logs", async () => {
    logged.length = 0;
    const { d, made } = deps();
    const { raw } = await read(await handleScanRequest(post({ token: KEY }), d));
    assert.deepEqual(made, [KEY], "the key reaches only the transport");
    assert.ok(!raw.includes(KEY));
    assert.ok(!raw.includes("TESTKEYDONOTLOG"));
    assert.ok(logged.length > 0);
    assert.ok(logged.every((l) => !l.includes("TESTKEYDONOTLOG")));
  });

  it("rejects an empty or malformed key without calling HubSpot", async () => {
    for (const token of ["", "   ", "two words"]) {
      const { d, made } = deps();
      const response = await handleScanRequest(post({ token }), d);
      assert.equal(response.status, 400);
      const { events } = await read(response);
      assert.equal(events[0].type, "error");
      assert.deepEqual(made, []);
    }
  });

  it("rejects a body that isn't JSON", async () => {
    const { d } = deps();
    const response = await handleScanRequest(post("token=abc"), d);
    assert.equal(response.status, 400);
  });

  it("refuses a simulated scan when the simulator is disabled, without loading it", async () => {
    let loaded = false;
    const { d } = deps({
      loadSimulator: async () => {
        loaded = true;
        throw new Error("should not load");
      },
    });
    const response = await handleScanRequest(post({ mode: "simulated" }), d);
    assert.equal(response.status, 403);
    assert.equal(loaded, false);
  });

  it("runs and labels a simulated scan when enabled", async () => {
    const { d, made } = deps({ simulatorEnabled: () => true });
    const { events } = await read(await handleScanRequest(post({ mode: "simulated" }), d));
    assert.deepEqual(made, [], "no HubSpot transport is created");
    assert.ok(events.filter((e) => e.type === "progress").every((e) => e.type === "progress" && e.simulated));
    const last = events.at(-1)!;
    assert.equal(last.type === "done" && last.report.simulated, true);
  });
});
