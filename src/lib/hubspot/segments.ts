import { request, type CallTracker, type HubSpotResult, type Transport } from "./client";
import type { ObjectType } from "./properties";

// HubSpot's UI calls lists "segments"; the API is still /crm/lists/.
const LISTS_PATH = "/crm/lists/2026-09";

// Most segments one read-all call returns.
export const SEGMENT_PAGE_SIZE = 500;

// Every processing type, so the read-all call returns every segment.
// MANUAL and SNAPSHOT segments are static; DYNAMIC ones are active.
const PROCESSING_TYPES = ["MANUAL", "DYNAMIC", "SNAPSHOT"];

// HubSpot's object type IDs for the objects the scan reads properties of.
export const OBJECT_FOR_TYPE_ID: Record<string, ObjectType> = {
  "0-1": "contacts",
  "0-2": "companies",
  "0-3": "deals",
};

// The subset of a segment the checks use. No members, only the definition.
export type SegmentDef = {
  id: string;
  name: string;
  objectTypeId: string;
  processingType: string;
  processingStatus: string;
  createdAt: string | null;
  // Records in the segment, or null when HubSpot didn't say.
  size: number | null;
};

type RawSegment = {
  listId?: string | number;
  name?: string;
  objectTypeId?: string;
  processingType?: string;
  processingStatus?: string;
  createdAt?: string;
  deletedAt?: string;
  additionalProperties?: Record<string, string | undefined>;
};

type AllResponse = { results?: RawSegment[]; total?: number; paging?: { next?: { after?: string } } };

const sizeOf = (raw: string | undefined) => {
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
};

// Every segment in the portal, a page at a time. `onTotal` hears HubSpot's
// total after the first page, so the scan can plan the rest.
export async function readSegments(
  transport: Transport,
  tracker: CallTracker,
  { onTotal }: { onTotal?: (total: number, pages: number) => void } = {},
): Promise<HubSpotResult<SegmentDef[]>> {
  const segments: SegmentDef[] = [];
  let after: string | undefined;
  for (let page = 0; ; page++) {
    const result = await request<AllResponse>(transport, tracker, "POST", `${LISTS_PATH}/all`, {
      count: SEGMENT_PAGE_SIZE,
      processingTypes: PROCESSING_TYPES,
      additionalProperties: ["hs_list_size"],
      ...(after && { after }),
    });
    if (!result.ok) return result;
    const { results = [], total, paging } = result.data;
    if (page === 0 && typeof total === "number") onTotal?.(total, Math.max(1, Math.ceil(total / SEGMENT_PAGE_SIZE)));
    for (const raw of results) {
      if (raw.listId === undefined || raw.deletedAt) continue;
      segments.push({
        id: String(raw.listId),
        name: raw.name ?? "",
        objectTypeId: raw.objectTypeId ?? "",
        processingType: raw.processingType ?? "",
        processingStatus: raw.processingStatus ?? "",
        createdAt: raw.createdAt ?? null,
        size: sizeOf(raw.additionalProperties?.hs_list_size),
      });
    }
    after = paging?.next?.after;
    if (!after || !results.length) return { ok: true, data: segments };
  }
}

// A segment's filter tree, as HubSpot returns it. Only the parts the
// property check reads are typed.
export type FilterBranch = {
  filterBranchType?: string;
  objectTypeId?: string;
  filterBranches?: FilterBranch[];
  filters?: { filterType?: string; property?: string; operation?: unknown }[];
};

type ByIdResponse = { lists?: { listId?: string | number; filterBranch?: FilterBranch }[] };

// Filter definitions for some segments, `batchSize` IDs per call.
export async function readSegmentFilters(
  transport: Transport,
  tracker: CallTracker,
  ids: string[],
  batchSize: number,
  onBatch?: (done: number) => void,
): Promise<HubSpotResult<Map<string, FilterBranch>>> {
  const filters = new Map<string, FilterBranch>();
  for (let i = 0; i < ids.length; i += batchSize) {
    const query = ids
      .slice(i, i + batchSize)
      .map((id) => `listIds=${encodeURIComponent(id)}`)
      .join("&");
    const result = await request<ByIdResponse>(transport, tracker, "GET", `${LISTS_PATH}?${query}&includeFilters=true`);
    if (!result.ok) return result;
    for (const list of result.data.lists ?? []) {
      if (list.listId !== undefined && list.filterBranch) filters.set(String(list.listId), list.filterBranch);
    }
    onBatch?.(Math.min(ids.length, i + batchSize));
  }
  return { ok: true, data: filters };
}

// What a property missing from the property list turned out to be.
// "unverified": HubSpot refused the lookup (403), so it may be a sensitive
// property this key can't see.
export type PropertyStatus = "archived" | "sensitive" | "not_found" | "unverified";

// Looks up one property that isn't among the object's active, non-sensitive
// properties. Each query matches only its own kind, so a name is "not found"
// only when it isn't archived, sensitive or highly sensitive.
export async function propertyStatus(
  transport: Transport,
  tracker: CallTracker,
  objectType: ObjectType,
  name: string,
): Promise<HubSpotResult<PropertyStatus>> {
  const queries: [string, PropertyStatus][] = [
    ["archived=true", "archived"],
    ["dataSensitivity=sensitive", "sensitive"],
    ["dataSensitivity=highly_sensitive", "sensitive"],
  ];
  for (const [query, status] of queries) {
    const result = await request<unknown>(
      transport,
      tracker,
      "GET",
      `/crm/properties/2026-09/${objectType}/${encodeURIComponent(name)}?${query}`,
    );
    if (result.ok) return { ok: true, data: status };
    if (result.status === 404) continue;
    if (result.kind === "missing_scope") return { ok: true, data: "unverified" };
    return result;
  }
  return { ok: true, data: "not_found" };
}
