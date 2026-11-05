import { FULL_READ_CONFIG, type FullReadConfig } from "@/config/requests";
import type { Transport } from "./client";

// Paces the full read: at most `concurrency` calls in flight, and no more
// call starts in any rolling window than `limitShare` of the burst limit
// HubSpot reports in each response's X-HubSpot-RateLimit-Max and
// X-HubSpot-RateLimit-Interval-Milliseconds headers. Retries go through it
// too, so they count against the same window. It also times out calls, so
// a hung connection can't hold a slot.
export function createLimiter(config: FullReadConfig = FULL_READ_CONFIG, now: () => number = Date.now) {
  let max = config.fallbackMax;
  let windowMs = config.fallbackWindowMs;
  let inFlight = 0;
  // Start times of calls in the current window, oldest first.
  const starts: number[] = [];
  const waiters = new Set<() => void>();
  const cap = () => Math.max(1, Math.floor(max * config.limitShare));

  function wakeOne() {
    const next = waiters.values().next();
    if (next.done) return;
    waiters.delete(next.value);
    next.value();
  }

  async function acquire() {
    for (;;) {
      const t = now();
      while (starts.length && starts[0] <= t - windowMs) starts.shift();
      if (inFlight < config.concurrency && starts.length < cap()) {
        inFlight++;
        starts.push(t);
        return;
      }
      // Wait for a call to finish, or for the oldest start to leave the window.
      const until = inFlight < config.concurrency ? starts[0] + windowMs - t : undefined;
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = until === undefined ? undefined : setTimeout(wake, Math.max(1, until));
        waiters.add(wake);
      });
    }
  }

  function release() {
    inFlight--;
    wakeOne();
  }

  // HubSpot's own numbers for this key, when it sends them.
  function observe(headers: Headers) {
    const reportedMax = Number(headers.get("x-hubspot-ratelimit-max"));
    const reportedWindow = Number(headers.get("x-hubspot-ratelimit-interval-milliseconds"));
    if (reportedMax > 0 && reportedWindow > 0) {
      max = reportedMax;
      windowMs = reportedWindow;
    }
  }

  return {
    // The transport, paced.
    wrap(transport: Transport): Transport {
      return async (request) => {
        await acquire();
        // A call that hangs gives its slot back after timeoutMs and counts as
        // dropped, so it's retried. Waiting for a slot isn't part of it.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), config.timeoutMs);
        });
        try {
          const response = await Promise.race([transport(request), timeout]);
          observe(response.headers);
          return response;
        } finally {
          clearTimeout(timer);
          release();
        }
      };
    },
    limit: () => ({ max, windowMs, cap: cap() }),
  };
}

export type Limiter = ReturnType<typeof createLimiter>;
