import type { Client } from "@hubspot/api-client";
import type { Pacer } from "../pace";
import { request, type CallCounter, type HubSpotResult } from "./client";
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
// pacer and call counter see all of them.
export async function searchRecords(
  client: Client,
  counter: CallCounter,
  pace: Pacer,
  objectType: ObjectType,
  search: SearchRequest,
): Promise<HubSpotResult<SearchPage>> {
  const body = { filterGroups: [], ...search };
  const result = await pace(() =>
    request<RawSearchResponse>(
      client,
      counter,
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

// Counts records via the Search API's `total`, without pulling the records.
// With no propertyName it counts every record of the object.
export async function countRecords(
  client: Client,
  counter: CallCounter,
  pace: Pacer,
  objectType: ObjectType,
  propertyName?: string,
): Promise<HubSpotResult<number>> {
  const result = await searchRecords(client, counter, pace, objectType, {
    limit: 1,
    properties: ["hs_object_id"],
    filterGroups: propertyName
      ? [{ filters: [{ propertyName, operator: "HAS_PROPERTY" }] }]
      : [],
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data.total };
}

// The most recently created records, newest first, up to `cap` (never more
// than one query's 10,000 ceiling). Used by checks that need field values.
export async function fetchRecentWindow(
  client: Client,
  counter: CallCounter,
  pace: Pacer,
  objectType: ObjectType,
  properties: string[],
  cap: number,
): Promise<HubSpotResult<SearchRow[]>> {
  const limit = Math.min(cap, MAX_RESULTS_PER_QUERY);
  const rows: SearchRow[] = [];
  let after: string | undefined;

  while (rows.length < limit) {
    const page = await searchRecords(client, counter, pace, objectType, {
      properties,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: Math.min(MAX_PAGE_SIZE, limit - rows.length),
      after,
    });
    if (!page.ok) return page;
    rows.push(...page.data.results);
    after = page.data.nextAfter;
    if (!after || !page.data.results.length) break;
  }
  return { ok: true, data: rows };
}
