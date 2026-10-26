// Simple limiter for HubSpot search calls: one at a time, at least
// minIntervalMs apart. HubSpot allows 5 search requests/second per account;
// 250ms keeps us at 4/second. The full queue with 429 backoff comes later.
export function createPacer(minIntervalMs: number) {
  let lastStart = 0;
  let chain: Promise<unknown> = Promise.resolve();

  return function pace<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) {
        console.info(`[pace] waited ${wait}ms`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      lastStart = Date.now();
      return task();
    };
    // Queue behind the previous task whether it succeeded or failed.
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  };
}

export type Pacer = ReturnType<typeof createPacer>;
