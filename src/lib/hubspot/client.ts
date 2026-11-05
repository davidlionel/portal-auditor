import { Client } from "@hubspot/api-client";
import { RETRY_CONFIG, type RetryConfig } from "@/config/requests";
import { backoffDelay, retryDecision, sleep } from "./retry";

// Stable, date-versioned account-info endpoint. The SDK (v14) has no typed
// client for it, so we call it through the generic apiRequest.
const ACCOUNT_DETAILS_PATH = "/account-info/2026-09/details";

export type AccountDetails = {
  portalId: number;
  accountType: string;
  timeZone: string;
  companyCurrency: string;
  uiDomain: string;
  dataHostingLocation: string;
};

export type HubSpotErrorKind =
  | "invalid_token"
  | "missing_scope"
  | "rate_limited"
  | "daily_limit"
  | "hubspot_unavailable"
  | "cancelled"
  | "unexpected";

export type HubSpotResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: HubSpotErrorKind; status?: number };

// Sends one HTTP request to HubSpot. The real one wraps the SDK; the dev
// simulator supplies its own, so nothing patches the global fetch.
export type Transport = (request: {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}) => Promise<Response>;

export type RetryWait = {
  delayMs: number;
  retry: number;
  maxRetries: number;
  // What's being waited out: HubSpot's rate limit, or a server error or
  // dropped connection on a call that retries those.
  reason: "rate_limit" | "server_error";
};

// For long reads, where one failed call out of thousands shouldn't end the
// check: retry 502/503/504 and network errors with the same backoff as a
// 429, and give up on a call that hangs.
export type RequestOptions = {
  retryServerErrors?: boolean;
  timeoutMs?: number;
};

const RETRIED_STATUSES = new Set([502, 503, 504]);

// Settles with the transport's response, or rejects when the call takes
// longer than `timeoutMs` or the scan is cancelled, so neither has to wait
// for a hung connection.
function withDeadline(call: Promise<Response>, timeoutMs: number | undefined, signal: AbortSignal | undefined) {
  if (!timeoutMs && !signal) return call;
  return new Promise<Response>((resolve, reject) => {
    const timer = timeoutMs ? setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs) : undefined;
    const onAbort = () => finish(() => reject(new Error("cancelled")));
    function finish(settle: () => void) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    call.then(
      (response) => finish(() => resolve(response)),
      (error) => finish(() => reject(error)),
    );
  });
}

// Per-scan call tracking, passed in rather than global so two scans running
// at once don't mix. `calls` counts every attempt, retries included.
export type CallTracker = {
  calls: number;
  retries: number;
  signal?: AbortSignal;
  onCall?: () => void;
  onRetryWait?: (wait: RetryWait) => void;
  // Defaults to RETRY_CONFIG and a real timer; tests pass their own.
  retry?: RetryConfig;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export function newTracker(fields: Partial<CallTracker> = {}): CallTracker {
  return { calls: 0, retries: 0, ...fields };
}

// The key goes into the SDK client and stays inside this closure. It is
// never logged, stored or returned.
export function hubspotTransport(token: string): Transport {
  const client = new Client({ accessToken: token });
  return (request) => client.apiRequest(request);
}

// One line per HubSpot call: method, path, status and duration. Never the key.
function logCall(method: string, path: string, outcome: number | string, started: number) {
  const ms = Math.round(performance.now() - started);
  console.info(`[hubspot] ${method} ${path} -> ${outcome} in ${ms}ms`);
}

function kindForStatus(status: number): HubSpotErrorKind {
  if (status === 401) return "invalid_token";
  if (status === 403) return "missing_scope";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "hubspot_unavailable";
  return "unexpected";
}

async function policyName(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { policyName?: unknown };
    return typeof body.policyName === "string" ? body.policyName : undefined;
  } catch {
    return undefined;
  }
}

// One HubSpot call, retried on 429 with backoff (honoring Retry-After when
// HubSpot sends it). Gives up with rate_limited or daily_limit.
export async function request<T>(
  transport: Transport,
  tracker: CallTracker,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<HubSpotResult<T>> {
  const retry = tracker.retry ?? RETRY_CONFIG;
  const wait = tracker.sleep ?? sleep;
  // Backs off before retrying a server error or dropped connection, when
  // this call retries those. False when it shouldn't (or can't) retry.
  const retryServerError = async (attempt: number) => {
    if (!options.retryServerErrors || attempt + 1 > retry.maxRetries || tracker.signal?.aborted) return false;
    const delayMs = backoffDelay(attempt + 1, retry);
    tracker.retries++;
    tracker.onRetryWait?.({ delayMs, retry: attempt + 1, maxRetries: retry.maxRetries, reason: "server_error" });
    console.info(`[hubspot] server error; retry ${attempt + 1} of ${retry.maxRetries} in ${delayMs}ms`);
    await wait(delayMs, tracker.signal);
    return true;
  };
  for (let attempt = 0; ; attempt++) {
    if (tracker.signal?.aborted) return { ok: false, kind: "cancelled" };

    let response: Response;
    const started = performance.now();
    tracker.calls++;
    try {
      response = await withDeadline(transport({ method, path, body }), options.timeoutMs, tracker.signal);
    } catch {
      // Network failure, timeout or cancel. Deliberately drop the error: it
      // can carry request details, and the token must never reach logs or
      // the browser.
      const cancelled = tracker.signal?.aborted;
      logCall(method, path, cancelled ? "cancelled" : "network error", started);
      tracker.onCall?.();
      if (cancelled) return { ok: false, kind: "cancelled" };
      if (await retryServerError(attempt)) continue;
      return { ok: false, kind: "hubspot_unavailable" };
    }
    logCall(method, path, response.status, started);
    tracker.onCall?.();

    if (RETRIED_STATUSES.has(response.status) && (await retryServerError(attempt))) continue;

    if (response.status === 429) {
      const decision = retryDecision(
        await policyName(response),
        response.headers.get("retry-after"),
        attempt + 1,
        retry,
      );
      if (decision.action === "give_up") return { ok: false, kind: decision.kind, status: 429 };
      tracker.retries++;
      tracker.onRetryWait?.({ delayMs: decision.delayMs, retry: attempt + 1, maxRetries: retry.maxRetries, reason: "rate_limit" });
      console.info(`[hubspot] rate limited; retry ${attempt + 1} of ${retry.maxRetries} in ${decision.delayMs}ms`);
      await wait(decision.delayMs, tracker.signal);
      continue;
    }

    if (!response.ok) {
      return { ok: false, kind: kindForStatus(response.status), status: response.status };
    }
    try {
      return { ok: true, data: (await response.json()) as T };
    } catch {
      return { ok: false, kind: "unexpected", status: response.status };
    }
  }
}

export async function getAccountDetails(
  transport: Transport,
  tracker: CallTracker,
): Promise<HubSpotResult<AccountDetails>> {
  const result = await request<Partial<AccountDetails>>(
    transport,
    tracker,
    "GET",
    ACCOUNT_DETAILS_PATH,
  );
  if (!result.ok) return result;

  const body = result.data;
  if (typeof body.portalId !== "number") return { ok: false, kind: "unexpected" };

  // Pick fields explicitly so only what the UI needs is returned.
  return {
    ok: true,
    data: {
      portalId: body.portalId,
      accountType: body.accountType ?? "UNKNOWN",
      timeZone: body.timeZone ?? "",
      companyCurrency: body.companyCurrency ?? "",
      uiDomain: body.uiDomain ?? "",
      dataHostingLocation: body.dataHostingLocation ?? "",
    },
  };
}
