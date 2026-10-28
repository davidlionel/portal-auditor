import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RetryConfig } from "@/config/requests";
import { RETRY_CONFIG } from "@/config/requests";
import { newTracker, request, type Transport } from "@/lib/hubspot/client";
import { backoffDelay, parseRetryAfter, retryDecision } from "@/lib/hubspot/retry";

const NOW = Date.parse("2026-10-28T12:00:00Z");

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates, and ignores junk", () => {
    assert.equal(parseRetryAfter("3", NOW), 3000);
    assert.equal(parseRetryAfter("Wed, 28 Oct 2026 12:00:05 GMT", NOW), 5000);
    assert.equal(parseRetryAfter("Wed, 28 Oct 2026 11:00:00 GMT", NOW), 0, "a past date means now");
    assert.equal(parseRetryAfter("soon", NOW), null);
    assert.equal(parseRetryAfter(null, NOW), null);
  });
});

describe("backoffDelay", () => {
  it("doubles from 1s and caps at 10s", () => {
    const noJitter = () => 0;
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, RETRY_CONFIG, noJitter)),
      [1000, 2000, 4000, 8000, 10000, 10000],
    );
  });

  it("adds up to 25% jitter", () => {
    assert.equal(backoffDelay(1, RETRY_CONFIG, () => 1), 1250);
    assert.equal(backoffDelay(5, RETRY_CONFIG, () => 0.5), 11250);
  });
});

describe("retryDecision", () => {
  const noJitter = () => 0;

  it("never retries the daily limit", () => {
    assert.deepEqual(retryDecision("DAILY", null, 1), { action: "give_up", kind: "daily_limit" });
    assert.deepEqual(retryDecision("DAILY", "1", 1), { action: "give_up", kind: "daily_limit" });
  });

  it("backs off on the 10-second limit and gives up after the last retry", () => {
    assert.deepEqual(retryDecision("TEN_SECONDLY_ROLLING", null, 3, RETRY_CONFIG, noJitter), {
      action: "retry",
      delayMs: 4000,
    });
    assert.deepEqual(retryDecision("TEN_SECONDLY_ROLLING", null, 6, RETRY_CONFIG, noJitter), {
      action: "give_up",
      kind: "rate_limited",
    });
  });

  it("honors Retry-After, but gives up when it asks for too long", () => {
    assert.deepEqual(retryDecision(undefined, "2", 1, RETRY_CONFIG, noJitter, NOW), { action: "retry", delayMs: 2000 });
    assert.deepEqual(retryDecision(undefined, "120", 1, RETRY_CONFIG, noJitter, NOW), {
      action: "give_up",
      kind: "rate_limited",
    });
  });
});

// A transport that returns the given responses in order.
function scripted(responses: (() => Response)[]): { transport: Transport; calls: () => number } {
  let i = 0;
  return {
    transport: async () => responses[Math.min(i++, responses.length - 1)](),
    calls: () => i,
  };
}

const ok = () => new Response(JSON.stringify({ fine: true }), { status: 200 });
const limited = (policyName = "TEN_SECONDLY_ROLLING", retryAfter?: string) => () =>
  new Response(JSON.stringify({ errorType: "RATE_LIMIT", policyName }), {
    status: 429,
    headers: retryAfter ? { "retry-after": retryAfter } : {},
  });
const status = (code: number) => () => new Response("{}", { status: code });

const FAST: RetryConfig = { ...RETRY_CONFIG, jitter: 0 };

// A tracker whose waits are recorded instead of slept.
function tracker() {
  const waits: number[] = [];
  const t = newTracker({ retry: FAST, sleep: async (ms) => void waits.push(ms) });
  return { t, waits };
}

describe("request retries", () => {
  it("succeeds after two 429s, backing off 1s then 2s", async () => {
    const { transport } = scripted([limited(), limited(), ok]);
    const { t, waits } = tracker();
    const result = await request(transport, t, "POST", "/search");
    assert.equal(result.ok, true);
    assert.deepEqual(waits, [1000, 2000]);
    assert.equal(t.calls, 3, "every attempt is an API call");
    assert.equal(t.retries, 2);
  });

  it("waits what Retry-After asks", async () => {
    const { transport } = scripted([limited("TEN_SECONDLY_ROLLING", "3"), ok]);
    const { t, waits } = tracker();
    await request(transport, t, "POST", "/search");
    assert.deepEqual(waits, [3000]);
  });

  it("gives up after the maximum retries with rate_limited", async () => {
    const { transport, calls } = scripted([limited()]);
    const { t, waits } = tracker();
    const result = await request(transport, t, "POST", "/search");
    assert.deepEqual(result, { ok: false, kind: "rate_limited", status: 429 });
    assert.equal(calls(), FAST.maxRetries + 1);
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 10000]);
  });

  it("stops at once on the daily limit", async () => {
    const { transport, calls } = scripted([limited("DAILY"), ok]);
    const { t } = tracker();
    const result = await request(transport, t, "GET", "/x");
    assert.deepEqual(result, { ok: false, kind: "daily_limit", status: 429 });
    assert.equal(calls(), 1);
  });

  it("doesn't retry other errors", async () => {
    for (const [code, kind] of [
      [401, "invalid_token"],
      [403, "missing_scope"],
      [500, "hubspot_unavailable"],
    ] as const) {
      const { transport, calls } = scripted([status(code), ok]);
      const result = await request(transport, tracker().t, "GET", "/x");
      assert.deepEqual(result, { ok: false, kind, status: code });
      assert.equal(calls(), 1);
    }
  });

  it("reports each wait so progress can show it", async () => {
    const { transport } = scripted([limited(), ok]);
    const seen: unknown[] = [];
    const t = newTracker({ retry: FAST, sleep: async () => {}, onRetryWait: (w) => seen.push(w) });
    await request(transport, t, "POST", "/search");
    assert.deepEqual(seen, [{ delayMs: 1000, retry: 1, maxRetries: 5 }]);
  });

  it("stops when the scan is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, calls } = scripted([ok]);
    const result = await request(transport, newTracker({ signal: controller.signal }), "GET", "/x");
    assert.deepEqual(result, { ok: false, kind: "cancelled" });
    assert.equal(calls(), 0);
  });
});
