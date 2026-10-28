import { RETRY_CONFIG, type RetryConfig } from "@/config/requests";

export type RetryDecision =
  | { action: "retry"; delayMs: number }
  | { action: "give_up"; kind: "rate_limited" | "daily_limit" };

// Retry-After is either whole seconds or an HTTP date. HubSpot doesn't
// document sending it, so it's honored when present and ignored when junk.
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

// 1s, 2s, 4s, 8s, then capped at 10s, each plus up to 25% at random.
export function backoffDelay(
  attempt: number,
  config: RetryConfig = RETRY_CONFIG,
  random: () => number = Math.random,
): number {
  const base = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(base * (1 + config.jitter * random()));
}

// What to do after a 429. `attempt` is the retry about to be made (1 for the
// first retry). HubSpot's 429 body names the limit in `policyName`.
export function retryDecision(
  policyName: string | undefined,
  retryAfter: string | null,
  attempt: number,
  config: RetryConfig = RETRY_CONFIG,
  random: () => number = Math.random,
  now = Date.now(),
): RetryDecision {
  // Waiting seconds can't fix a daily allowance.
  if (policyName === "DAILY") return { action: "give_up", kind: "daily_limit" };
  if (attempt > config.maxRetries) return { action: "give_up", kind: "rate_limited" };

  const asked = parseRetryAfter(retryAfter, now);
  if (asked !== null) {
    return asked > config.maxRetryAfterMs
      ? { action: "give_up", kind: "rate_limited" }
      : { action: "retry", delayMs: asked };
  }
  return { action: "retry", delayMs: backoffDelay(attempt, config, random) };
}

// Resolves after ms, or early when the scan is cancelled.
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
