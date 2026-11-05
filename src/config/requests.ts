export type RetryConfig = {
  // Retries after the first attempt; 5 means up to 6 attempts per call.
  maxRetries: number;
  // Exponential backoff: base, 2×base, 4×base… up to maxDelayMs.
  baseDelayMs: number;
  maxDelayMs: number;
  // A Retry-After longer than this means give up rather than hang the scan.
  maxRetryAfterMs: number;
  // Up to this share of the delay is added at random, so parallel clients
  // don't retry in lockstep.
  jitter: number;
};

// How HubSpot calls are retried after a 429. The reasoning lives in the
// project's decision log, not here.
export const RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 1_000,
  // HubSpot's burst limit is a 10-second rolling window.
  maxDelayMs: 10_000,
  maxRetryAfterMs: 30_000,
  jitter: 0.25,
};

export type FullReadConfig = {
  // Calls in flight at once.
  concurrency: number;
  // Share of HubSpot's reported burst limit the read may use.
  limitShare: number;
  // The burst limit assumed until a response reports the real one: the
  // lowest documented (Free and Starter).
  fallbackMax: number;
  fallbackWindowMs: number;
  // A call that takes longer than this is treated as dropped and retried.
  timeoutMs: number;
  // Before reading, the ID space is cut into pieces of about
  // records ÷ (concurrency × piecesPerWorker), using Search counts, so the
  // workers share the work evenly. At most maxCountCalls counts are made.
  piecesPerWorker: number;
  maxCountCalls: number;
  // A piece with fewer records than this left isn't split again for an
  // idle worker near the end.
  minSplitRecords: number;
};

// How the full duplicate scan reads every record with the basic list
// endpoint. The reasoning lives in the project's decision log, not here.
export const FULL_READ_CONFIG: FullReadConfig = {
  concurrency: 3,
  limitShare: 0.8,
  fallbackMax: 100,
  fallbackWindowMs: 10_000,
  timeoutMs: 30_000,
  piecesPerWorker: 8,
  maxCountCalls: 100,
  minSplitRecords: 500,
};
