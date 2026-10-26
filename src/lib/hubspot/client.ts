import { Client } from "@hubspot/api-client";

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
  | "hubspot_unavailable"
  | "unexpected";

export type HubSpotResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: HubSpotErrorKind; status?: number };

// Counts HubSpot calls for one scan. Passed in, not global, so two scans
// running at once don't mix their numbers.
export type CallCounter = { calls: number };

export function makeClient(token: string): Client {
  return new Client({ accessToken: token });
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

export async function request<T>(
  client: Client,
  counter: CallCounter,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HubSpotResult<T>> {
  let response: Response;
  const started = performance.now();
  counter.calls++;
  try {
    response = await client.apiRequest({ method, path, body });
  } catch {
    // Network failure. Deliberately drop the error: it can carry request
    // details, and the token must never reach logs or the browser.
    logCall(method, path, "network error", started);
    return { ok: false, kind: "hubspot_unavailable" };
  }
  logCall(method, path, response.status, started);

  if (!response.ok) {
    return { ok: false, kind: kindForStatus(response.status), status: response.status };
  }

  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, kind: "unexpected", status: response.status };
  }
}

export async function getAccountDetails(
  client: Client,
  counter: CallCounter,
): Promise<HubSpotResult<AccountDetails>> {
  const result = await request<Partial<AccountDetails>>(
    client,
    counter,
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
