import { FULL_READ_CONFIG, type FullReadConfig } from "@/config/requests";
import type { Pacer } from "../pace";
import { request, type CallTracker, type HubSpotErrorKind, type HubSpotResult, type Transport } from "./client";
import { createLimiter } from "./limiter";
import type { ObjectType } from "./properties";
import { countWhere, searchRecords, type SearchRow } from "./search";

// The basic list endpoint returns up to 100 records a page (HubSpot refuses
// more), in ascending record ID order. `after` is the record ID to start
// from: any ID works, not only one HubSpot returned, so the read can be
// split into ID ranges read side by side. A page that starts in a gap
// between IDs jumps straight to the next record, so gaps cost nothing.
export const LIST_PAGE_SIZE = 100;

export const listPagesFor = (records: number) => Math.max(1, Math.ceil(records / LIST_PAGE_SIZE));

type RawListResponse = {
  results?: { id: string; properties?: Record<string, string | null> }[];
  paging?: { next?: { after?: string } };
};

export type FullReadHooks = {
  // Each page's rows as they arrive. The caller turns them into keys; they
  // aren't kept here.
  onRows: (rows: SearchRow[]) => void;
  // After each page, with the records read so far.
  onPage?: (read: number) => void;
  // A call beyond one per 100 records and the planning searches: the first
  // page of a piece split off for an idle worker.
  onExtraCall?: () => void;
};

export type FullReadResult =
  | { ok: true; read: number }
  // Stopped partway: `read` records were handed to onRows before it did.
  | { ok: false; kind: HubSpotErrorKind; read: number };

// A slice of the ID space: from `next` up to, not including, `end`, with
// about `count` records not yet read. Another worker may lower `end`.
type Piece = { next: number; end: number; count: number; split: boolean };

// The lowest or highest record ID, from one Search call.
async function edgeId(
  transport: Transport,
  tracker: CallTracker,
  pace: Pacer,
  objectType: ObjectType,
  direction: "ASCENDING" | "DESCENDING",
): Promise<HubSpotResult<number | null>> {
  const page = await searchRecords(transport, tracker, pace, objectType, {
    limit: 1,
    properties: ["hs_object_id"],
    sorts: [{ propertyName: "hs_object_id", direction }],
  });
  if (!page.ok) return page;
  const id = Number(page.data.results[0]?.id);
  return { ok: true, data: Number.isSafeInteger(id) ? id : null };
}

// Cuts [low, high] into pieces of roughly equal record counts: the piece
// with the most records is halved by ID, until there are enough pieces or
// the count budget runs out. One Search count per split: the second half's
// count is the rest. Counts only steer the planning. Pieces counted as
// empty are merged into a neighbour rather than dropped, so a record too
// new for Search's index is still read.
export async function planPieces(
  count: (from: number, to: number) => Promise<HubSpotResult<number>>,
  low: number,
  high: number,
  total: number,
  config: FullReadConfig = FULL_READ_CONFIG,
): Promise<HubSpotResult<Piece[]>> {
  const target = Math.max(LIST_PAGE_SIZE * 10, Math.ceil(total / (config.concurrency * config.piecesPerWorker)));
  let pieces: Piece[] = [{ next: low, end: high + 1, count: total, split: false }];
  for (let calls = 0; calls < config.maxCountCalls; calls++) {
    const largest = pieces.reduce((a, b) => (b.count > a.count ? b : a));
    if (largest.count <= target || largest.end - largest.next < 2) break;
    const mid = largest.next + Math.floor((largest.end - largest.next) / 2);
    const counted = await count(largest.next, mid);
    if (!counted.ok) return counted;
    const first = Math.min(counted.data, largest.count);
    const halves: Piece[] = [
      { next: largest.next, end: mid, count: first, split: false },
      { next: mid, end: largest.end, count: largest.count - first, split: false },
    ];
    pieces = pieces.flatMap((p) => (p === largest ? halves : [p]));
  }
  // Empty pieces join the one before (or, at the start, the one after).
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged.at(-1);
    if (last && (p.count === 0 || last.count === 0)) {
      last.end = p.end;
      last.count += p.count;
    } else merged.push({ ...p });
  }
  return { ok: true, data: merged };
}

// Reads every record of an object, `concurrency` pieces at a time, paced by
// HubSpot's reported burst limit. 502/503/504s, dropped connections and
// hung calls are retried like 429s. Cancelling stops it within one call.
// `total` is the object's record count, already known from setup.
export async function readAllRecords(
  transport: Transport,
  tracker: CallTracker,
  pace: Pacer,
  objectType: ObjectType,
  properties: string[],
  total: number,
  hooks: FullReadHooks,
  config: FullReadConfig = FULL_READ_CONFIG,
): Promise<FullReadResult> {
  const low = await edgeId(transport, tracker, pace, objectType, "ASCENDING");
  if (!low.ok) return { ...low, read: 0 };
  const high = await edgeId(transport, tracker, pace, objectType, "DESCENDING");
  if (!high.ok) return { ...high, read: 0 };
  if (low.data === null || high.data === null) return { ok: true, read: 0 };

  const planned = await planPieces(
    (from, to) =>
      countWhere(transport, tracker, pace, objectType, [
        {
          filters: [
            { propertyName: "hs_object_id", operator: "GTE", value: String(from) },
            { propertyName: "hs_object_id", operator: "LT", value: String(to) },
          ],
        },
      ]),
    low.data,
    high.data,
    total,
    config,
  );
  if (!planned.ok) return { ...planned, read: 0 };
  // Largest first, so the last pieces read are small.
  const queue = planned.data.sort((a, b) => b.count - a.count);

  const limited = createLimiter(config).wrap(transport);
  const active = new Set<Piece>();
  let read = 0;
  let failure: HubSpotErrorKind | null = null;
  const fields = properties.join(",");

  // Near the end, an idle worker takes the second half (by ID) of the
  // piece with the most records left. Each piece is split at most once,
  // so a guess that lands in a gap between clusters costs one call.
  function steal(): Piece | null {
    let most: Piece | null = null;
    for (const p of active) if (!p.split && (!most || p.count > most.count)) most = p;
    if (!most || most.count < config.minSplitRecords || most.end - most.next < 2) return null;
    const mid = most.next + Math.floor((most.end - most.next) / 2);
    const half = Math.floor(most.count / 2);
    const taken: Piece = { next: mid, end: most.end, count: half, split: true };
    most.end = mid;
    most.count -= half;
    most.split = true;
    hooks.onExtraCall?.();
    return taken;
  }

  async function worker() {
    for (;;) {
      const piece = queue.shift() ?? steal();
      if (!piece) return;
      active.add(piece);
      while (piece.next < piece.end && failure === null) {
        const page = await request<RawListResponse>(
          limited,
          tracker,
          "GET",
          `/crm/objects/2026-09/${objectType}?limit=${LIST_PAGE_SIZE}&after=${piece.next}&properties=${fields}`,
          undefined,
          { retryServerErrors: true },
        );
        if (!page.ok) {
          failure ??= page.kind;
          break;
        }
        // `end` may have been lowered while this page was in flight.
        const results = page.data.results ?? [];
        const rows: SearchRow[] = [];
        for (const r of results) {
          if (Number(r.id) >= piece.end) break;
          rows.push({ id: r.id, properties: r.properties ?? {} });
        }
        if (rows.length) {
          hooks.onRows(rows);
          read += rows.length;
          piece.count = Math.max(0, piece.count - rows.length);
          hooks.onPage?.(read);
        }
        const after = Number(page.data.paging?.next?.after);
        piece.next = rows.length < results.length || !Number.isSafeInteger(after) ? piece.end : after;
      }
      active.delete(piece);
      if (failure !== null) return;
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, worker));
  return failure === null ? { ok: true, read } : { ok: false, kind: failure, read };
}
