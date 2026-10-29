
import type { Pacer } from "../pace";
import { request, type CallTracker, type HubSpotResult, type Transport } from "./client";
import type { ObjectType } from "./properties";

// HubSpot's documented Search limits: 200 results per page, and no paging
// past 10,000 results for one query.
const MAX_PAGE_SIZE = 200;
const MAX_RESULTS_PER_QUERY = 10_000;

export type Filter = { propertyName: string; operator: string; value?: string };
// Filters inside a group are ANDed; groups are ORed.
export type FilterGroup = { filters: Filter[] };

export type SearchRequest = {
  filterGroups?: FilterGroup[];
  properties?: string[];
  sorts?: { propertyName: string; direction: "ASCENDING" | "DESCENDING" }[];
  limit?: number;
  after?: string;
};

export type SearchRow = { id: string; properties: Record<string, string | null> };

export type SearchPage = { total: number; results: SearchRow[]; nextAfter?: string };

type RawSearchResponse = {
  total?: number;
  results?: { id: string; properties?: Record<string, string | null> }[];
  paging?: { next?: { after?: string } };
};

// One paced Search call. Every search in the scan goes through here, so the
// pacer and call tracker see all of them.
export async function searchRecords(
  transport: Transport,
  tracker: CallTracker,
  pace: Pacer,
  objectType: ObjectType,
  search: SearchRequest,
): Promise<HubSpotResult<SearchPage>> {
  const body = { filterGroups: [], ...search };
  const result = await pace(() =>
    request<RawSearchResponse>(
      transport,
      tracker,
      "POST",
      `/crm/objects/2026-09/${objectType}/search`,
      body,
    ),
  );
  if (!result.ok) return result;
  if (typeof result.data.total !== "number") return { ok: false, kind: "unexpected" };

  return {
    ok: true,
    data: {
      total: result.data.total,
      results: (result.data.results ?? []).map((r) => ({ id: r.id, properties: r.properties ?? {} })),
      nextAfter: result.data.paging?.next?.after,
    },
  };
}

// Counts records matching the filter groups via the Search API's `total`,
// without pulling the records.
export async function countWhere(
  transport: Transport,
  tracker: CallTracker,
  pace: Pacer,
  objectType: ObjectType,
  filterGroups: FilterGroup[],
): Promise<HubSpotResult<number>> {
  const result = await searchRecords(transport, tracker, pace, objectType, {
    limit: 1,
    properties: ["hs_object_id"],
    filterGroups,
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data.total };
}

// With no propertyName it counts every record of the object.
export function countRecords(
  transport: Transport,
  tracker: CallTracker,
  pace: Pacer,
  objectType: ObjectType,
  propertyName?: string,
): Promise<HubSpotResult<number>> {
  return countWhere(
    transport,
    tracker,
    pace,
    objectType,
    propertyName ? [{ filters: [{ propertyName, operator: "HAS_PROPERTY" }] }] : [],
  );
}

// Search calls needed to read this many results.
export const pagesFor = (results: number) => Math.max(1, Math.ceil(results / MAX_PAGE_SIZE));

export type PagingHooks = {
  // Once the first page says how many matched, so progress can plan the
  // remaining pages before they're fetched.
  onTotal?: (total: number, pages: number) => void;
  // After each page, with the rows fetched so far.
  onPage?: (fetched: number) => void;
  // Each page's rows as they arrive.
  onRows?: (rows: SearchRow[]) => void;
};

// Pages through a search, 200 per call, until `cap` rows (never more than one
// query's 10,000 ceiling) or the results run out. Returns the search's total
// too, so a capped list still knows how many matched.
export async function fetchMatching(
  transport: Transport,
  tracker: CallTracker,
  pace: Pacer,
  objectType: ObjectType,
  search: Omit<SearchRequest, "limit" | "after">,
  cap: number,
  hooks: PagingHooks = {},
  // False to hand each page to onRows and drop it, instead of returning all
  // rows at the end.
  keep = true,
): Promise<HubSpotResult<{ total: number; rows: SearchRow[]; fetched: number }>> {
  const limit = Math.max(1, Math.min(cap, MAX_RESULTS_PER_QUERY));
  const rows: SearchRow[] = [];
  let fetched = 0;
  let total = 0;
  let after: string | undefined;

  do {
    const page = await searchRecords(transport, tracker, pace, objectType, {
      ...search,
      limit: Math.min(MAX_PAGE_SIZE, limit - fetched),
      after,
    });
    if (!page.ok) return page;
    if (!fetched) hooks.onTotal?.(page.data.total, pagesFor(Math.min(page.data.total, limit)));
    total = page.data.total;
    fetched += page.data.results.length;
    hooks.onRows?.(page.data.results);
    if (keep) rows.push(...page.data.results);
    hooks.onPage?.(fetched);
    after = page.data.nextAfter;
    if (!page.data.results.length) break;
  } while (after && fetched < limit);

  return { ok: true, data: { total, rows, fetched } };
}

// The most recently created records, newest first, up to `cap`. Used by
// checks that need field values. Each page goes to `hooks.onRows` and is
// then dropped, so the raw values never pile up; returns how many were read.
export async function fetchRecentWindow(
  transport: Transport,
  tracker: CallTracker,
  pace: Pacer,
  objectType: ObjectType,
  properties: string[],
  cap: number,
  hooks: PagingHooks = {},
): Promise<HubSpotResult<number>> {
  const result = await fetchMatching(
    transport,
    tracker,
    pace,
    objectType,
    { properties, sorts: [{ propertyName: "createdate", direction: "DESCENDING" }] },
    cap,
    hooks,
    false,
  );
  return result.ok ? { ok: true, data: result.data.fetched } : result;
}
