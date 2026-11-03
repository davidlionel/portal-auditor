import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { OBJECT_FOR_TYPE_ID, type FilterBranch, type PropertyStatus, type SegmentDef } from "@/lib/hubspot/segments";
import type { ObjectType } from "@/lib/hubspot/properties";
import { normalizeLabel } from "@/lib/text";
import type { CheckMeta, Finding, SegmentRow } from "./types";

export const SEGMENT_MISSING_PROPERTY: CheckMeta = {
  checkId: "segments.filters-missing-property",
  title: "Active segments that filter on archived or missing properties",
  severity: "medium",
};

export const EMPTY_SEGMENTS: CheckMeta = {
  checkId: "segments.empty",
  title: "Empty segments",
  severity: "low",
};

export const DUPLICATE_SEGMENT_NAMES: CheckMeta = {
  checkId: "segments.duplicate-names",
  title: "Segments with the same name",
  severity: "low",
};

export const SEGMENT_METAS = [SEGMENT_MISSING_PROPERTY, EMPTY_SEGMENTS, DUPLICATE_SEGMENT_NAMES];

const DAY_MS = 24 * 60 * 60 * 1000;

// Segments are configuration, not record data, so findings name them.
export const describeSegment = (s: Pick<SegmentDef, "id" | "name">) => `${s.id} "${s.name}"`;

export const isActive = (s: SegmentDef) => s.processingType === "DYNAMIC";
const kind = (s: SegmentDef) => (isActive(s) ? "active" : "static");

// A segment HubSpot has finished processing. One still processing may not
// have its members yet.
const processed = (s: SegmentDef) => s.processingStatus === "COMPLETE";

// A property a segment's filters name, on the object it belongs to.
export type PropertyRef = { objectType: ObjectType; property: string };

// Every property a segment filters on, including properties of associated
// records and properties a date filter compares against. Filters on objects
// the scan doesn't read (tickets, custom objects) and on events are counted
// as unchecked rather than guessed at.
export function filterProperties(root: FilterBranch, segmentObjectTypeId: string): { refs: PropertyRef[]; unchecked: number } {
  const refs = new Map<string, PropertyRef>();
  let unchecked = 0;

  // Date filters can compare against another property:
  // { timeType: "PROPERTY_REFERENCED", property: "..." } anywhere in the operation.
  function referenced(value: unknown, out: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((v) => referenced(v, out));
    else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (o.timeType === "PROPERTY_REFERENCED" && typeof o.property === "string") out.push(o.property);
      for (const v of Object.values(o)) referenced(v, out);
    }
    return out;
  }

  function walk(branch: FilterBranch, objectTypeId: string) {
    if (branch.filterBranchType === "UNIFIED_EVENTS") {
      unchecked += branch.filters?.length ?? 0;
      return;
    }
    const here = branch.filterBranchType === "ASSOCIATION" && branch.objectTypeId ? branch.objectTypeId : objectTypeId;
    const objectType = OBJECT_FOR_TYPE_ID[here];
    for (const filter of branch.filters ?? []) {
      if (filter.filterType !== "PROPERTY" || typeof filter.property !== "string") continue;
      if (!objectType) {
        unchecked++;
        continue;
      }
      for (const property of [filter.property, ...referenced(filter.operation)]) {
        refs.set(`${objectType}:${property}`, { objectType, property });
      }
    }
    for (const child of branch.filterBranches ?? []) walk(child, here);
  }

  walk(root, segmentObjectTypeId);
  return { refs: [...refs.values()], unchecked };
}

// One active segment's filters checked against the property lists.
export type MissingProperty = PropertyRef & { status: Extract<PropertyStatus, "archived" | "not_found"> };
export type SegmentPropertyResult = { segment: SegmentDef; missing: MissingProperty[] };

const missingText = ({ missing }: SegmentPropertyResult) =>
  missing.map((m) => `${m.objectType}.${m.property} (${m.status === "archived" ? "archived" : "not found"})`).join("; ");
const describeMissing = (r: SegmentPropertyResult) => `${describeSegment(r.segment)}: ${missingText(r)}`;
const row = (s: SegmentDef, extra: Omit<SegmentRow, "id" | "name"> = {}): SegmentRow => ({ id: s.id, name: s.name, ...extra });

// `checked` is how many active segments had their filters read: the population.
export function checkSegmentProperties(
  results: SegmentPropertyResult[],
  checked: number,
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const affected = results.filter((r) => r.missing.length);
  if (!affected.length) return [];
  return [
    {
      ...SEGMENT_MISSING_PROPERTY,
      category: "Segments",
      objectType: "segments",
      count: affected.length,
      affected: affected.length,
      population: checked,
      samples: affected.slice(0, config.sampleCap).map(describeMissing),
      items: affected.slice(0, config.records.workListCap).map(describeMissing),
      segments: affected.slice(0, config.records.workListCap).map((r) => row(r.segment, { detail: missingText(r) })),
      why: "A filter on a property that has been archived or deleted no longer means what it did, so the segment, and the emails, workflows and reports that use it, may include the wrong records.",
      fix: "Open each segment's filters and replace or remove the filter on the missing property, or restore the property if it's still needed.",
    },
  ];
}

// Segments old enough to have filled up and finished processing, whose size
// HubSpot reported.
export function emptySegmentsPopulation(segments: SegmentDef[], now = Date.now(), config: ChecksConfig = CHECKS_CONFIG) {
  const minAgeMs = config.segments.emptyMinAgeDays * DAY_MS;
  return segments.filter(
    (s) => s.size !== null && processed(s) && (s.createdAt === null || now - Date.parse(s.createdAt) >= minAgeMs),
  );
}

export function checkEmptySegments(
  segments: SegmentDef[],
  now = Date.now(),
  config: ChecksConfig = CHECKS_CONFIG,
): Finding[] {
  const population = emptySegmentsPopulation(segments, now, config);
  const empty = population.filter((s) => s.size === 0);
  if (!empty.length) return [];
  const describe = (s: SegmentDef) => `${describeSegment(s)} (${kind(s)})`;
  return [
    {
      ...EMPTY_SEGMENTS,
      category: "Segments",
      objectType: "segments",
      count: empty.length,
      affected: empty.length,
      population: population.length,
      samples: empty.slice(0, config.sampleCap).map(describe),
      items: empty.slice(0, config.records.workListCap).map(describe),
      segments: empty.slice(0, config.records.workListCap).map((s) => row(s, { detail: kind(s) })),
      why: "Empty segments clutter the segment list and make the ones in use harder to find; an email or workflow that uses one reaches nobody.",
      fix: "Check where each is used; delete the ones nothing uses, and fix the filters of any that should have members.",
    },
  ];
}

// Same object, same name once case, spacing and punctuation are ignored.
// Numbered series ("Webinar 2025", "Webinar 2026") keep their digits, so
// they never match.
export function checkDuplicateSegmentNames(segments: SegmentDef[], config: ChecksConfig = CHECKS_CONFIG): Finding[] {
  const groups = new Map<string, SegmentDef[]>();
  for (const s of segments) {
    const name = normalizeLabel(s.name);
    if (!name) continue;
    const key = `${s.objectTypeId}:${name}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const duplicates = [...groups.values()].filter((g) => g.length > 1);
  if (!duplicates.length) return [];
  const describe = (group: SegmentDef[]) => group.map(describeSegment).join(" / ");
  return [
    {
      ...DUPLICATE_SEGMENT_NAMES,
      category: "Segments",
      objectType: "segments",
      count: duplicates.length,
      affected: duplicates.reduce((n, g) => n + g.length, 0),
      population: segments.length,
      samples: duplicates.slice(0, config.sampleCap).map(describe),
      items: duplicates.slice(0, config.records.workListCap).map(describe),
      segments: duplicates.slice(0, config.records.workListCap).flatMap((g, i) => g.map((s) => row(s, { group: i + 1 }))),
      why: "Segments with the same name make it easy to pick the wrong one for an email, workflow or report.",
      fix: "Compare each pair's filters and where each is used, keep one, then rename or delete the other.",
    },
  ];
}
