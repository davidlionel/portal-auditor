import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FULL_READ_CONFIG, RETRY_CONFIG } from "@/config/requests";
import { newTracker, type Transport } from "@/lib/hubspot/client";
import { createLimiter } from "@/lib/hubspot/limiter";
import { listPagesFor, planPieces, readAllRecords } from "@/lib/hubspot/list";
import { createPacer } from "@/lib/pace";

console.info = () => {};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

// A fake HubSpot holding the given record IDs: the list endpoint (100 a
// page max, ascending by ID, `after` = first ID to return) and the one
// search the reader makes (lowest or highest ID).
// `fail` can replace the nth list call's answer; `limitHeaders` adds HubSpot's
// rate-limit headers to list pages.
function fakePortal(
  ids: number[],
  options: { fail?: (listCall: number) => Response | null; delayMs?: number; limitHeaders?: boolean } = {},
) {
  const sorted = [...ids].sort((a, b) => a - b);
  let calls = 0;
  let gets = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const transport: Transport = async ({ method, path, body }) => {
    calls++;
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, options.delayMs ?? 0));
      if (method === "POST") {
        const search = body as { sorts?: { direction: string }[]; filterGroups?: { filters: { operator: string; value: string }[] }[] };
        const range = search.filterGroups?.[0]?.filters;
        if (range) {
          const [from, to] = [Number(range.find((f) => f.operator === "GTE")!.value), Number(range.find((f) => f.operator === "LT")!.value)];
          return json({ total: sorted.filter((id) => id >= from && id < to).length, results: [] });
        }
        const id = search.sorts?.[0].direction === "ASCENDING" ? sorted[0] : sorted.at(-1);
        return json({ total: sorted.length, results: id === undefined ? [] : [{ id: String(id), properties: {} }] });
      }
      gets++;
      const failed = options.fail?.(gets);
      if (failed) return failed;
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const limit = Number(q.get("limit"));
      if (limit > 100) return json({ message: "limit too high" }, 400);
      const after = Number(q.get("after") ?? 0);
      const from = sorted.findIndex((id) => id >= after);
      const page = from < 0 ? [] : sorted.slice(from, from + limit);
      const next = from >= 0 && from + limit < sorted.length ? { next: { after: String(sorted[from + limit]) } } : undefined;
      return json(
        { results: page.map((id) => ({ id: String(id), properties: { firstname: `n${id}` } })), ...(next && { paging: next }) },
        200,
        options.limitHeaders ? { "x-hubspot-ratelimit-max": "190", "x-hubspot-ratelimit-interval-milliseconds": "10000" } : {},
      );
    } finally {
      inFlight--;
    }
  };
  return { transport, calls: () => calls, gets: () => gets, maxInFlight: () => maxInFlight, total: sorted.length };
}

// Clusters of consecutive IDs far apart, like a real portal's.
function clusteredIds(clusters: number[]): number[] {
  return clusters.flatMap((size, c) => Array.from({ length: size }, (_, i) => 548_000_000_000 + c * 3_000_000_000 + i));
}

const FAST_RETRY = { ...RETRY_CONFIG, jitter: 0 };
// The real settings, with a rate window short enough for a unit test.
const FAST_READ = { ...FULL_READ_CONFIG, fallbackMax: 1_000, fallbackWindowMs: 10 };
const read = async (
  portal: ReturnType<typeof fakePortal>,
  tracker = newTracker({ retry: FAST_RETRY, sleep: async () => {} }),
) => {
  const seen: string[] = [];
  let planned = listPagesFor(portal.total);
  const result = await readAllRecords(portal.transport, tracker, createPacer(0), "contacts", ["firstname"], portal.total, {
    onRows: (rows) => seen.push(...rows.map((r) => r.id)),
    onExtraCall: () => planned++,
  }, FAST_READ);
  return { result, seen, tracker, planned };
};

describe("full read", () => {
  it("reads every record exactly once, across uneven clusters of IDs", async () => {
    const ids = clusteredIds([1_234, 5, 0, 2_890, 1, 777]);
    const portal = fakePortal(ids);
    const { result, seen } = await read(portal);
    assert.deepEqual(result, { ok: true, read: ids.length });
    assert.equal(new Set(seen).size, seen.length, "no record read twice");
    assert.deepEqual(seen.map(Number).sort((a, b) => a - b), ids);
  });

  it("keeps 3 calls in flight, and wastes almost no list calls on gaps between clusters", async () => {
    const ids = clusteredIds([3_000, 3_000, 3_000]);
    const portal = fakePortal(ids, { delayMs: 2 });
    const { result, planned } = await read(portal);
    assert.equal(result.ok, true);
    assert.equal(portal.maxInFlight(), FULL_READ_CONFIG.concurrency);
    // 90 pages of 100, plus at most one extra page where pieces meet.
    assert.ok(portal.gets() <= 90 + 12, `list calls ${portal.gets()}`);
    assert.ok(Math.abs(planned - portal.gets()) <= 12, `planned ${planned}, made ${portal.gets()}`);
    assert.ok(portal.calls() - portal.gets() <= 2 + FULL_READ_CONFIG.maxCountCalls, "searches stay within the count budget");
  });

  it("splits a large uniform portal into balanced pieces with few counts", async () => {
    const ids = Array.from({ length: 100_000 }, (_, i) => 1_000_000 + i * 7);
    const portal = fakePortal(ids);
    const { result } = await read(portal);
    assert.deepEqual(result, { ok: true, read: 100_000 });
    assert.ok(portal.gets() <= 1_000 + 30, `list calls ${portal.gets()}`);
    assert.ok(portal.calls() - portal.gets() <= 2 + 32, `searches ${portal.calls() - portal.gets()}`);
  });

  it("handles an empty object and a single record", async () => {
    assert.deepEqual((await read(fakePortal([]))).result, { ok: true, read: 0 });
    assert.deepEqual((await read(fakePortal([42]))).result, { ok: true, read: 1 });
  });

  it("retries a 502 mid-read and still reads everything", async () => {
    const ids = clusteredIds([800]);
    const portal = fakePortal(ids, { fail: (call) => (call === 3 ? json({}, 502) : null) });
    const { result, seen, tracker } = await read(portal);
    assert.deepEqual(result, { ok: true, read: 800 });
    assert.equal(new Set(seen).size, 800);
    assert.equal(tracker.retries, 1);
  });

  it("stops at a rate limit that won't clear, and says how many it read", async () => {
    const ids = clusteredIds([2_000]);
    const limited = json({ policyName: "DAILY" }, 429);
    const portal = fakePortal(ids, { fail: (call) => (call >= 8 ? limited.clone() : null) });
    const { result, seen } = await read(portal);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.kind, "daily_limit");
    assert.equal(result.read, seen.length);
    assert.ok(seen.length > 0 && seen.length < 2_000);
  });

  it("stops within one call when cancelled", async () => {
    const controller = new AbortController();
    const portal = fakePortal(clusteredIds([5_000]), { delayMs: 5 });
    const tracker = newTracker({ signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const { result } = await read(portal, tracker);
    assert.equal(!result.ok && result.kind, "cancelled");
    assert.ok(Date.now() - started < 1_000);
  });
});

describe("full read planning", () => {
  it("covers the whole ID range with no gaps, even when Search counts everything as empty", async () => {
    for (const counts of [() => 0, (from: number) => (from < 5_000 ? 3_000 : 1)]) {
      const planned = await planPieces(async (from) => ({ ok: true, data: counts(from) }), 1_000, 1_000_000, 50_000, FULL_READ_CONFIG);
      assert.ok(planned.ok);
      const pieces = planned.data.sort((a, b) => a.next - b.next);
      assert.equal(pieces[0].next, 1_000);
      assert.equal(pieces.at(-1)!.end, 1_000_001);
      for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i].next, pieces[i - 1].end, "pieces meet");
    }
  });

  it("stops splitting at the count budget", async () => {
    let calls = 0;
    await planPieces(async () => (calls++, { ok: true, data: 1 }), 0, 1e12, 10_000_000, { ...FULL_READ_CONFIG, maxCountCalls: 7 });
    assert.equal(calls, 7);
  });
});

describe("full read limiter", () => {
  it("starts no more calls per window than 80% of the reported limit", async () => {
    let t = 0;
    const limiter = createLimiter({ ...FULL_READ_CONFIG, concurrency: 50, fallbackMax: 10, fallbackWindowMs: 200 }, () => (t = Date.now()));
    const starts: number[] = [];
    const transport = limiter.wrap(async () => {
      starts.push(Date.now());
      return new Response("{}");
    });
    await Promise.all(Array.from({ length: 24 }, () => transport({ method: "GET", path: "/x" })));
    void t;
    // 8 per 200 ms: the first 8 at once, then the next 8 a window later.
    for (let i = 8; i < starts.length; i++) assert.ok(starts[i] - starts[i - 8] >= 195, `call ${i} too soon`);
  });

  it("adopts the limit HubSpot reports", async () => {
    const limiter = createLimiter();
    assert.deepEqual(limiter.limit(), { max: 100, windowMs: 10_000, cap: 80 });
    const transport = limiter.wrap(async () =>
      new Response("{}", { headers: { "x-hubspot-ratelimit-max": "190", "x-hubspot-ratelimit-interval-milliseconds": "10000" } }),
    );
    await transport({ method: "GET", path: "/x" });
    assert.deepEqual(limiter.limit(), { max: 190, windowMs: 10_000, cap: 152 });
  });

  it("frees the slot of a call that hangs", async () => {
    const limiter = createLimiter({ ...FULL_READ_CONFIG, concurrency: 1, timeoutMs: 20 });
    let call = 0;
    const transport = limiter.wrap(() => (call++ === 0 ? new Promise<Response>(() => {}) : Promise.resolve(new Response("{}"))));
    await assert.rejects(transport({ method: "GET", path: "/x" }), /timeout/);
    assert.equal((await transport({ method: "GET", path: "/x" })).status, 200);
  });
});
