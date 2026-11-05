import type { Transport } from "../hubspot/client";
import type { ObjectType } from "../hubspot/properties";
import type { SearchRequest } from "../hubspot/search";
import { ID_BASE, SIM_ARCHIVED_PROPERTY, SIM_SENSITIVE_PROPERTY, SIZE_250K, createPortal, filterSignature, type PortalSize } from "./portal";

export type RateLimitMode =
  // About 2% of searches get a 10-second-window 429 (half with
  // Retry-After: 1), plus one burst of three in a row.
  | "realistic"
  | "none"
  // Every search is rate-limited, so retries run out.
  | "always"
  // Searches hit the daily limit after `dailyAfter` calls.
  | "daily";

export type SimulatorOptions = {
  size?: PortalSize;
  // Adds HubSpot-like response times (searches 120–350ms, GETs 80–200ms,
  // list pages of 100 records 250–650ms, as measured on a test portal).
  latency?: boolean;
  rateLimits?: RateLimitMode;
  dailyAfter?: number;
  seed?: number;
  // The burst limit for calls other than search, enforced over a rolling
  // 10 seconds and reported in HubSpot's rate-limit headers: 190 on
  // Professional and Enterprise (the default), 100 on Free and Starter.
  burstMax?: number;
  // Share of list calls answered 502, as HubSpot sometimes does under load.
  serverErrorRate?: number;
};

export type SimulatorStats = { requests: number; rateLimited: number; listCalls: number; serverErrors: number };

// Small seeded random generator, so runs are repeatable.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const rateLimited = (policyName: string, retryAfter?: string) =>
  json(
    {
      status: "error",
      message: policyName === "DAILY" ? "You have reached your daily limit." : "You have reached your ten_secondly_rolling limit.",
      errorType: "RATE_LIMIT",
      policyName,
    },
    429,
    retryAfter ? { "retry-after": retryAfter } : {},
  );

// A Transport that answers the calls the scan makes from a simulated portal
// instead of HubSpot. The service key is never used.
export function simulatorTransport(options: SimulatorOptions = {}): { transport: Transport; stats: SimulatorStats } {
  const portal = createPortal(options.size ?? SIZE_250K);
  const random = mulberry32(options.seed ?? 42);
  const mode = options.rateLimits ?? "realistic";
  const stats: SimulatorStats = { requests: 0, rateLimited: 0, listCalls: 0, serverErrors: 0 };
  let searches = 0;
  const burstMax = options.burstMax ?? 190;
  const BURST_WINDOW_MS = 10_000;
  // Arrival times of calls other than search in the last 10 seconds.
  const recent: number[] = [];
  let dailyUsed = 0;
  const limitHeaders = () => ({
    "x-hubspot-ratelimit-max": String(burstMax),
    "x-hubspot-ratelimit-interval-milliseconds": String(BURST_WINDOW_MS),
    "x-hubspot-ratelimit-remaining": String(Math.max(0, burstMax - recent.length)),
    "x-hubspot-ratelimit-daily": "1000000",
    "x-hubspot-ratelimit-daily-remaining": String(1_000_000 - dailyUsed),
  });
  // Counts a call against the rolling window; false when it's over the limit.
  const withinBurst = () => {
    const now = Date.now();
    while (recent.length && recent[0] <= now - BURST_WINDOW_MS) recent.shift();
    if (recent.length >= burstMax) return false;
    recent.push(now);
    dailyUsed++;
    return true;
  };

  const delay = (min: number, max: number) =>
    options.latency ? new Promise((r) => setTimeout(r, min + random() * (max - min))) : Promise.resolve();

  const transport: Transport = async ({ method, path, body }) => {
    stats.requests++;
    // Every record of an object, 100 a page at most, in ascending ID order
    // from `after` (any ID).
    const list = method === "GET" ? /^\/crm\/objects\/[\w-]+\/(contacts|companies|deals)\?(.*)$/.exec(path) : null;
    if (list) {
      stats.listCalls++;
      if (!withinBurst()) {
        stats.rateLimited++;
        return json(
          { status: "error", message: "You have reached your ten_secondly_rolling limit.", errorType: "RATE_LIMIT", policyName: "TEN_SECONDLY_ROLLING" },
          429,
          limitHeaders(),
        );
      }
      await delay(250, 650);
      if (random() < (options.serverErrorRate ?? 0)) {
        stats.serverErrors++;
        return json({ message: "Bad gateway" }, 502);
      }
      const objectType = list[1] as ObjectType;
      const query = new URLSearchParams(list[2]);
      const limit = Number(query.get("limit") ?? 10);
      if (limit > 100) return json({ status: "error", message: "limit must be 100 or less", category: "VALIDATION_ERROR" }, 400);
      const records = portal.size.records[objectType];
      const start = Math.max(0, Number(query.get("after") ?? 0) - ID_BASE[objectType]);
      const count = Math.max(0, Math.min(limit, records - start));
      const wanted = (query.get("properties") ?? "").split(",");
      const results = Array.from({ length: count }, (_, i) => {
        const r = portal.record(objectType, start + i);
        return { id: r.id, properties: Object.fromEntries(wanted.map((p) => [p, r.properties[p] ?? null])), archived: false };
      });
      const next = start + count < records ? { next: { after: String(ID_BASE[objectType] + start + count) } } : undefined;
      return json({ results, ...(next && { paging: next }) }, 200, limitHeaders());
    }
    if (method === "GET") {
      await delay(80, 200);
      if (path.startsWith("/account-info/")) {
        return json({
          portalId: 99_000_001,
          accountType: "DEVELOPER_TEST",
          timeZone: "US/Eastern",
          companyCurrency: "USD",
          uiDomain: "app.hubspot.com",
          dataHostingLocation: "na1",
        });
      }
      const props = /^\/crm\/properties\/[\w-]+\/(contacts|companies|deals)$/.exec(path);
      if (props) return json({ results: portal.properties[props[1] as ObjectType] });
      // One property looked up by name. Each query matches only its own kind.
      const one = /^\/crm\/properties\/[\w-]+\/(?:contacts|companies|deals)\/([\w-]+)\?(.*)$/.exec(path);
      if (one) {
        if (one[1] === SIM_ARCHIVED_PROPERTY && one[2] === "archived=true") return json({ name: one[1], archived: true });
        if (one[1] === SIM_SENSITIVE_PROPERTY && one[2].startsWith("dataSensitivity=")) {
          return json({ status: "error", category: "MISSING_SCOPES" }, 403);
        }
        return json({ status: "error", category: "OBJECT_NOT_FOUND" }, 404);
      }
      // Segments by ID, with their filters.
      if (/^\/crm\/lists\/[\w-]+\?/.test(path)) {
        const ids = [...new URLSearchParams(path.slice(path.indexOf("?") + 1)).getAll("listIds")];
        const lists = ids
          .map((id) => Number(id) - 1_000)
          .filter((i) => i >= 0 && i < portal.size.segments)
          .map((i) => portal.segment(i));
        return json({ lists });
      }
      return json({ message: "Not found" }, 404);
    }

    // Every segment, up to 500 a page.
    if (/^\/crm\/lists\/[\w-]+\/all$/.test(path)) {
      await delay(150, 400);
      const req = body as { count?: number; after?: string };
      const start = Number(req.after ?? 0);
      const count = Math.max(0, Math.min(req.count ?? 20, 500, portal.size.segments - start));
      const results = Array.from({ length: count }, (_, i) => {
        // The read-all call has no filters; the size comes as a string.
        const { size, filterBranch, ...segment } = portal.segment(start + i);
        void filterBranch;
        return { ...segment, listVersion: 1, additionalProperties: { hs_list_size: String(size) } };
      });
      const next = start + count < portal.size.segments ? { next: { after: String(start + count) } } : undefined;
      return json({ total: portal.size.segments, results, ...(next && { paging: next }) });
    }

    const search = /^\/crm\/objects\/[\w-]+\/(contacts|companies|deals)\/search$/.exec(path);
    if (!search) return json({ message: "Not found" }, 404);
    await delay(120, 350);
    searches++;

    const limited =
      mode === "always" ||
      (mode === "daily" && searches > (options.dailyAfter ?? 50)) ||
      (mode === "realistic" && (random() < 0.02 || (searches >= 150 && searches <= 152)));
    if (limited) {
      stats.rateLimited++;
      if (mode === "daily") return rateLimited("DAILY");
      return rateLimited("TEN_SECONDLY_ROLLING", random() < 0.5 ? "1" : undefined);
    }

    const objectType = search[1] as ObjectType;
    const req = body as SearchRequest;
    const groups = req.filterGroups ?? [];
    const records = portal.size.records[objectType];
    // The full read's searches: the lowest or highest record ID, and counts
    // of records in an ID range.
    if (req.sorts?.[0]?.propertyName === "hs_object_id" && !groups.length) {
      const index = req.sorts[0].direction === "ASCENDING" ? 0 : records - 1;
      return json({ total: records, results: records ? [{ id: String(ID_BASE[objectType] + index), properties: {} }] : [] });
    }
    const idRange = groups.length === 1 && groups[0].filters.every((f) => f.propertyName === "hs_object_id") ? groups[0].filters : null;
    if (idRange) {
      const bound = (op: string) => Number(idRange.find((f) => f.operator === op)?.value) - ID_BASE[objectType];
      const from = Math.max(0, bound("GTE"));
      const to = Math.min(records, bound("LT"));
      return json({ total: Math.max(0, to - from), results: [] });
    }
    const total = portal.total(objectType, groups);
    const limit = req.limit ?? 10;
    const start = Number(req.after ?? 0);
    // HubSpot refuses to page past 10,000 results.
    if (start + limit > 10_000) return json({ message: "Cannot page past 10,000 results" }, 400);
    const count = Math.max(0, Math.min(limit, total - start));
    const signature = filterSignature(groups);
    const results = Array.from({ length: count }, (_, i) =>
      groups.length
        ? { id: portal.matchId(objectType, signature, start + i), properties: {} }
        : portal.record(objectType, start + i),
    );
    const next = start + count < Math.min(total, 10_000) ? { next: { after: String(start + count) } } : undefined;
    return json({ total, results, ...(next && { paging: next }) });
  };

  return { transport, stats };
}
