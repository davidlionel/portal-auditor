import { CHECKS_CONFIG } from "@/config/checks";
import { FULL_READ_CONFIG, type FullReadConfig } from "@/config/requests";
import { getAccountDetails, newTracker, type CallTracker } from "./hubspot/client";
import { listPagesFor } from "./hubspot/list";
import { countRecords } from "./hubspot/search";
import { ERROR_MESSAGES } from "./messages";
import { createPacer } from "./pace";
import { openTransport, type ScanStreamDeps } from "./scan-stream";

// What a full duplicate scan of this portal would cost, shown before it starts.
export type FullScanEstimate = {
  contacts: number;
  companies: number;
  // False when neither object has more records than the normal scan reads,
  // so a full scan would check nothing extra.
  needed: boolean;
  calls: number;
  minutes: number;
  // From HubSpot's headers, when it sends them.
  dailyLimit?: number;
  dailyRemaining?: number;
  // "warn": the scan would use more than half of what's left today;
  // "block": more than what's left.
  daily: "ok" | "warn" | "block";
};

// The model behind the estimate. A list page of 100 records took 250–670 ms
// on a test portal; the rest of the scan (properties, fill rates, record
// counts, segments) made about 470 calls in about 2½ minutes on the
// simulated 250K portal, and matching takes about 0.03 ms a record.
export const ESTIMATE_MODEL = {
  listCallMs: 450,
  otherCalls: 470,
  otherSeconds: 150,
  matchMsPerRecord: 0.03,
};

export function estimateFullScan(
  contacts: number,
  companies: number,
  limit: { max?: number; windowMs?: number; daily?: number; dailyRemaining?: number },
  config: FullReadConfig = FULL_READ_CONFIG,
  window = CHECKS_CONFIG.records.recordWindow,
): FullScanEstimate {
  const full = (n: number) => n > window;
  const planning = 2 + Math.min(config.maxCountCalls, config.concurrency * config.piecesPerWorker);
  const readCalls = (n: number) => (full(n) ? planning + listPagesFor(n) : 0);
  const listCalls = readCalls(contacts) + readCalls(companies);
  // The normal scan's 200-record search pages the full read replaces.
  const windowPages = (n: number) => (full(n) ? Math.ceil(Math.min(window, n) / 200) : 0);
  const calls = ESTIMATE_MODEL.otherCalls + listCalls - windowPages(contacts) - windowPages(companies);

  // Calls a second: as many as the workers keep in flight, never more than
  // the share of the burst limit the read may use.
  const max = limit.max ?? config.fallbackMax;
  const windowMs = limit.windowMs ?? config.fallbackWindowMs;
  const capPerSecond = (Math.floor(max * config.limitShare) * 1000) / windowMs;
  const perSecond = Math.min(capPerSecond, config.concurrency / (ESTIMATE_MODEL.listCallMs / 1000));
  const seconds =
    listCalls / perSecond +
    ESTIMATE_MODEL.otherSeconds +
    ((full(contacts) ? contacts : 0) + (full(companies) ? companies : 0)) * (ESTIMATE_MODEL.matchMsPerRecord / 1000);

  const remaining = limit.dailyRemaining;
  return {
    contacts,
    companies,
    needed: full(contacts) || full(companies),
    calls,
    minutes: Math.max(1, Math.round(seconds / 60)),
    ...(limit.daily !== undefined && { dailyLimit: limit.daily }),
    ...(remaining !== undefined && { dailyRemaining: remaining }),
    daily: remaining === undefined ? "ok" : calls > remaining ? "block" : calls > remaining / 2 ? "warn" : "ok",
  };
}

type EstimateEvent = { type: "estimate"; estimate: FullScanEstimate } | { type: "error"; message: string };

const json = (event: EstimateEvent, status = 200) =>
  new Response(JSON.stringify(event), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// The numbers HubSpot reports in a list response's rate-limit headers.
function limitHeaders(headers: Headers) {
  const number = (name: string) => {
    const value = Number(headers.get(name));
    return value > 0 ? value : undefined;
  };
  return {
    max: number("x-hubspot-ratelimit-max"),
    windowMs: number("x-hubspot-ratelimit-interval-milliseconds"),
    daily: number("x-hubspot-ratelimit-daily"),
    dailyRemaining: number("x-hubspot-ratelimit-daily-remaining"),
  };
}

// Handles POST /api/scan/estimate: with the same key the scan will use,
// counts contacts and companies and reads the limits HubSpot reports, about
// four calls. The key is used for these calls only, like the scan's.
export async function handleEstimateRequest(request: Request, deps: ScanStreamDeps): Promise<Response> {
  const opened = await openTransport(request, deps, (status, message) => json({ type: "error", message }, status));
  if (opened instanceof Response) return opened;
  if (!deps.fullScanEnabled()) return json({ type: "error", message: ERROR_MESSAGES.full_scan_off }, 403);
  const { transport } = opened;
  const tracker: CallTracker = newTracker({ signal: request.signal });
  const fail = (kind: keyof typeof ERROR_MESSAGES) => json({ type: "error", message: ERROR_MESSAGES[kind] }, 502);

  const account = await getAccountDetails(transport, tracker);
  if (!account.ok) return fail(account.kind);
  const pace = createPacer(CHECKS_CONFIG.searchMinIntervalMs);
  const contacts = await countRecords(transport, tracker, pace, "contacts");
  if (!contacts.ok) return fail(contacts.kind);
  const companies = await countRecords(transport, tracker, pace, "companies");
  if (!companies.ok) return fail(companies.kind);

  // One list call, for the burst and daily limits HubSpot reports.
  let limit = {};
  try {
    const response = await transport({ method: "GET", path: "/crm/objects/2026-09/contacts?limit=1&properties=hs_object_id" });
    limit = limitHeaders(response.headers);
  } catch {
    // Without headers the estimate assumes the lowest documented limits.
  }
  return json({ type: "estimate", estimate: estimateFullScan(contacts.data, companies.data, limit) });
}
