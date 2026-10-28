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
