import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import type { RetryConfig } from "@/config/requests";
import { SCORING_CONFIG, type ScoringConfig } from "@/config/scoring";
import {
  DROPDOWN_PLURAL_VARIANTS,
  DROPDOWN_VARIANTS,
  checkDropdownVariants,
  dropdownPopulation,
} from "./checks/properties/dropdown-variants";
import {
  DUPLICATE_LABELS,
  NEAR_DUPLICATE_LABELS,
  checkDuplicateLabels,
  duplicateLabelsPopulation,
} from "./checks/properties/duplicate-labels";
import {
  checkFillRate,
  fillRateCandidates,
  fillRatePopulation,
  nearZeroFill,
} from "./checks/properties/fill-rate";
import {
  NO_DESCRIPTION,
  checkNoDescription,
  noDescriptionPopulation,
} from "./checks/properties/no-description";
import {
  COUNT_CHECKS,
  countCheckMeta,
  countFinding,
  type CountCheck,
} from "./checks/records/count-checks";
import { DUPLICATE_METAS, DUPLICATE_TOOL_PATH, duplicateFindings } from "./checks/records/duplicates";
import { MALFORMED_EMAIL, hasMalformedEmail, malformedEmailFinding } from "./checks/records/email-quality";
import {
  DUPLICATE_SEGMENT_NAMES,
  EMPTY_SEGMENTS,
  SEGMENT_METAS,
  SEGMENT_MISSING_PROPERTY,
  checkDuplicateSegmentNames,
  checkEmptySegments,
  checkSegmentProperties,
  emptySegmentsPopulation,
  filterProperties,
  isActive,
  type MissingProperty,
  type PropertyRef,
} from "./checks/segments";
import {
  CATEGORY_FOR_OBJECT,
  SEVERITY_RANK,
  type Category,
  type CheckMeta,
  type CheckObject,
  type CheckRun,
  type Finding,
} from "./checks/types";
import {
  getAccountDetails,
  newTracker,
  type AccountDetails,
  type CallTracker,
  type HubSpotErrorKind,
  type Transport,
} from "./hubspot/client";
import { FULL_READ_CONFIG, type FullReadConfig } from "@/config/requests";
import { listPagesFor, readAllRecords } from "./hubspot/list";
import { listProperties, type ObjectType, type PropertyDef } from "./hubspot/properties";
import { propertyStatus, readSegmentFilters, readSegments, type PropertyStatus, type SegmentDef } from "./hubspot/segments";
import {
  countRecords,
  countWhere,
  fetchMatching,
  fetchRecentWindow,
  pagesFor,
  type SearchRow,
} from "./hubspot/search";
import { limitMessage } from "./messages";
import { createPacer, type Pacer } from "./pace";
import { COMPANY_MATCH_PROPERTIES, COMPANY_OPTIONAL_PROPERTIES, CompanyStore, matchCompaniesSteps } from "./dedupe/companies";
import { CONTACT_MATCH_PROPERTIES, CONTACT_OPTIONAL_PROPERTIES, ContactStore, matchContactsSteps } from "./dedupe/contacts";
import { runAsync, type Steps } from "./dedupe/match";
import { createProgress, type Progress, type ProgressEvent } from "./progress";
import { scoreChecks, type HealthScore } from "./scoring";

const OBJECT_TYPES: ObjectType[] = ["contacts", "companies", "deals"];

const OBJECT_LABELS: Record<ObjectType, string> = {
  contacts: "Contacts",
  companies: "Companies",
  deals: "Deals",
};

// Singular, lowercase, for progress text: "contact properties".
const OBJECT_NOUNS: Record<ObjectType, string> = {
  contacts: "contact",
  companies: "company",
  deals: "deal",
};

// Property checks that only need the property list.
const PROPERTY_LIST_CHECKS = [
  { meta: NO_DESCRIPTION, population: noDescriptionPopulation, run: checkNoDescription },
  { meta: DUPLICATE_LABELS, population: duplicateLabelsPopulation, run: checkDuplicateLabels },
  { meta: NEAR_DUPLICATE_LABELS, population: duplicateLabelsPopulation, run: checkDuplicateLabels },
  { meta: DROPDOWN_VARIANTS, population: dropdownPopulation, run: checkDropdownVariants },
  { meta: DROPDOWN_PLURAL_VARIANTS, population: dropdownPopulation, run: checkDropdownVariants },
];

// Checks that read field values from the recent-records window (or every
// record, in a full duplicate scan). Only these fields are requested. Each
// page is reduced to matching keys as it arrives and then dropped; the keys
// stay in memory for the scan only and are never returned to the browser.
type WindowCollector = {
  add: (rows: SearchRow[]) => void;
  // Null when the scan was cancelled while matching.
  finish: () => Promise<{ findings: Finding[]; notes: string[] } | null>;
};

type WindowCheck = {
  // Needed for the checks to run.
  properties: string[];
  optional: string[];
  metas: CheckMeta[];
  // `capacity` is how many records the read will hand over, to size the store.
  collect: (ctx: ScanContext, capacity: number) => WindowCollector;
  // Contacts are matched after the company window is read, so they can use
  // their companies' domains.
  deferred?: boolean;
};

// Matching moves the progress bar by about one step per this many records,
// in proportion to the time it's expected to take.
const RECORDS_PER_MATCH_STEP = 2_000;
const MATCH_MS_PER_RECORD = 0.03;
const matchSteps = (records: number) => Math.ceil(records / RECORDS_PER_MATCH_STEP);

// Runs matching in slices, so progress updates and Cancel get through, and
// moves the bar as it goes. Null when cancelled.
async function runMatching<T>(ctx: ScanContext, records: number, steps: Steps<T>): Promise<T | null> {
  const total = matchSteps(records);
  const expectedMs = Math.max(1, records * MATCH_MS_PER_RECORD);
  const started = performance.now();
  let given = 0;
  const result = await runAsync(steps, {
    signal: ctx.tracker.signal,
    onSlice: () => {
      const due = Math.min(total - 1, Math.floor(((performance.now() - started) / expectedMs) * total));
      if (due > given) ctx.progress.advance(due - given);
      given = Math.max(given, due);
      ctx.progress.tick();
    },
  });
  if (result !== null) ctx.progress.advance(total - given);
  return result;
}

const WINDOW_CHECKS: Partial<Record<ObjectType, WindowCheck>> = {
  contacts: {
    properties: CONTACT_MATCH_PROPERTIES,
    optional: CONTACT_OPTIONAL_PROPERTIES,
    metas: [...DUPLICATE_METAS.contacts, MALFORMED_EMAIL],
    deferred: true,
    collect: (ctx, capacity) => {
      const { config } = ctx;
      const store = new ContactStore(new Set(config.duplicates.freeEmailDomains), capacity);
      // Only as many IDs as the export can list; the rest are counted.
      const keep = Math.max(config.records.workListCap, config.sampleCap);
      const malformed: string[] = [];
      let malformedCount = 0;
      return {
        add: (rows) => {
          for (const row of rows) {
            store.add(row);
            if (!hasMalformedEmail(row, config)) continue;
            malformedCount++;
            if (malformed.length < keep) malformed.push(row.id);
          }
        },
        finish: async () => {
          const domains = ctx.companyDomains();
          const result = await runMatching(
            ctx,
            store.size,
            matchContactsSteps(store, config, (id) => domains.get(id) ?? 0),
          );
          if (!result) return null;
          const shared = result.sharedPhones;
          return {
            findings: [
              ...duplicateFindings("contacts", result.matches, store.idOf, store.size, config),
              ...malformedEmailFinding(malformed, store.size, config, malformedCount),
            ],
            notes: shared
              ? [
                  `${fmt(shared)} phone ${shared === 1 ? "number is" : "numbers are"} shared by ${config.duplicates.sharedPhoneMin} or more contacts (a switchboard or household, say), so the duplicate checks don't count ${shared === 1 ? "it" : "them"} as a match.`,
                ]
              : [],
          };
        },
      };
    },
  },
  companies: {
    properties: COMPANY_MATCH_PROPERTIES,
    optional: COMPANY_OPTIONAL_PROPERTIES,
    metas: DUPLICATE_METAS.companies,
    collect: (ctx, capacity) => {
      const store = new CompanyStore(capacity);
      return {
        add: (rows) => rows.forEach((row) => store.add(row)),
        finish: async () => {
          const domains = store.domainById();
          ctx.companyDomains = () => domains;
          const result = await runMatching(ctx, store.size, matchCompaniesSteps(store, ctx.config));
          if (!result) return null;
          return { findings: duplicateFindings("companies", result.matches, store.idOf, store.size, ctx.config), notes: [] };
        },
      };
    },
  },
};

// Whether this object's duplicate checks read every record: asked for, and
// more records than the window holds.
const readsEveryRecord = (ctx: ScanContext, total: number) => ctx.fullDuplicates && total > ctx.config.records.recordWindow;

export type LimitKind = "rate_limited" | "daily_limit";

export type ScanReport = {
  // ISO timestamp of when the scan finished.
  scannedAt: string;
  portal: AccountDetails;
  scannedObjects: ObjectType[];
  // Plain-language notes on anything the scan couldn't cover.
  notes: string[];
  findings: Finding[];
  // Every check attempted, scored or not.
  checks: CheckRun[];
  score: HealthScore;
  apiCalls: number;
  retries: number;
  durationMs: number;
  // True when the report came from the dev-only simulated portal.
  simulated: boolean;
  // True when the duplicate checks were asked to read every record.
  fullDuplicates?: boolean;
  // Set when HubSpot's rate limit stopped the scan early. The checks that
  // didn't run are listed as not scored.
  incomplete?: { kind: LimitKind; message: string };
};

export type ScanResult =
  | { ok: true; report: ScanReport }
  | { ok: false; kind: HubSpotErrorKind };

export type ScanOptions = {
  config?: ChecksConfig;
  scoring?: ScoringConfig;
  onProgress?: (event: ProgressEvent) => void;
  // Aborted when the browser cancels or disconnects.
  signal?: AbortSignal;
  simulated?: boolean;
  // Check every contact and company for duplicates, not only the newest
  // 10,000. Slower: one call per 100 records.
  fullDuplicates?: boolean;
  // How the full read paces itself; tests change it.
  fullRead?: FullReadConfig;
  // Retry settings and timer; tests shorten them.
  retry?: RetryConfig;
  sleep?: CallTracker["sleep"];
};

type ScanContext = {
  transport: Transport;
  tracker: CallTracker;
  pace: Pacer;
  config: ChecksConfig;
  now: number;
  progress: Progress;
  // Set once HubSpot's rate limit has run out: no more calls are made.
  stopped?: LimitKind;
  // Company domains by company ID, once the company window is read.
  companyDomains: () => Map<number, number>;
  // Window checks that finish after every object is read. Null when the
  // scan was cancelled while matching.
  deferred: (() => Promise<WindowResult | null>)[];
  // Duplicate checks read every contact and company, not the newest 10,000.
  fullDuplicates: boolean;
  fullRead: FullReadConfig;
};

type WindowResult = { findings: Finding[]; notes: string[]; runs: CheckRun[] };

// What happens to a failed call: the key or the user ended the scan
// ("abort"), HubSpot's limit ran out ("stop", keep what we have), or just
// this check is skipped.
function classify(ctx: ScanContext, kind: HubSpotErrorKind): "abort" | "stop" | "skip" {
  if (kind === "invalid_token" || kind === "cancelled") return "abort";
  if (kind === "rate_limited" || kind === "daily_limit") {
    ctx.stopped = kind;
    return "stop";
  }
  return "skip";
}

const LIMIT_REASON = "not run: HubSpot's rate limit ran out first";

function problemNote(kind: HubSpotErrorKind, scope: string): string {
  return kind === "missing_scope"
    ? `key lacks ${scope}`
    : `HubSpot returned an error (${kind.replace("_", " ")})`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

// A check that ran. Checks with nothing to look at aren't scored.
function ranCheck(
  meta: CheckMeta,
  category: Category,
  objectType: CheckObject,
  population: number,
  findings: Finding[],
): CheckRun {
  const found = findings.find((f) => f.checkId === meta.checkId && f.objectType === objectType);
  return {
    ...meta,
    category,
    objectType,
    status: population === 0 ? "empty" : meta.scored === false ? "unscored" : "scored",
    affected: found?.affected ?? 0,
    population,
  };
}

function skippedChecks(
  metas: CheckMeta[],
  category: Category,
  objectType: CheckObject,
  reason: string,
): CheckRun[] {
  return metas.map((meta) => ({
    ...meta,
    category,
    objectType,
    status: "skipped",
    affected: 0,
    population: 0,
    reason,
  }));
}

function recordCheckMetas(objectType: ObjectType, config: ChecksConfig): CheckMeta[] {
  return [
    ...COUNT_CHECKS.filter((c) => c.objectType === objectType).map((c) => countCheckMeta(c, config)),
    ...(WINDOW_CHECKS[objectType]?.metas ?? []),
  ];
}

function cappedNote(f: Finding): string[] {
  const listed = f.records?.length ?? 0;
  return f.records && listed < f.affected
    ? [`"${f.title}": the work list has the first ${fmt(listed)} of ${fmt(f.affected)} records.`]
    : [];
}

// Results of the setup phase for one object.
type ObjectSetup = {
  objectType: ObjectType;
  props?: PropertyDef[];
  propertyNames: Set<string>;
  total?: number;
};

const runnableCountChecks = (setup: ObjectSetup) =>
  COUNT_CHECKS.filter(
    (c) => c.objectType === setup.objectType && c.requiredProps.every((p) => setup.propertyNames.has(p)),
  );

// Calls the checks phase will make for one object, known once setup is done,
// plus the progress steps its duplicate matching will take. Count checks
// that need more than one page add theirs as they find out.
function plannedCalls(setup: ObjectSetup, ctx: ScanContext): number {
  const { config, now } = ctx;
  if (!setup.props || !setup.total) return 0;
  const countChecks = runnableCountChecks(setup);
  const populations = new Set(
    countChecks.flatMap((c) => (c.populationFilterGroups ? [JSON.stringify(c.populationFilterGroups())] : [])),
  );
  const window = WINDOW_CHECKS[setup.objectType];
  const windowRuns = !!window && window.properties.every((p) => setup.propertyNames.has(p));
  const full = readsEveryRecord(ctx, setup.total);
  // A full read: the lowest and highest ID, the counts that split the work,
  // and one call per 100 records.
  const { maxCountCalls, concurrency, piecesPerWorker } = ctx.fullRead;
  const fullReadCalls = 2 + Math.min(maxCountCalls, concurrency * piecesPerWorker) + listPagesFor(setup.total);
  const windowPages = !windowRuns
    ? 0
    : full
      ? fullReadCalls + matchSteps(setup.total)
      : pagesFor(Math.min(config.records.recordWindow, setup.total)) + matchSteps(Math.min(config.records.recordWindow, setup.total));
  return fillRateCandidates(setup.props, now, config).length + countChecks.length + populations.size + windowPages;
}

type PhaseResult =
  | { findings: Finding[]; notes: string[]; runs: CheckRun[] }
  | { abort: HubSpotErrorKind };

async function runRecordChecks(ctx: ScanContext, setup: ObjectSetup): Promise<PhaseResult> {
  const { transport, tracker, pace, config, now, progress } = ctx;
  const { objectType, propertyNames } = setup;
  const totalRecords = setup.total!;
  const label = OBJECT_LABELS[objectType];
  const noun = OBJECT_NOUNS[objectType];
  const category = CATEGORY_FOR_OBJECT[objectType];
  const findings: Finding[] = [];
  const notes: string[] = [];
  const runs: CheckRun[] = [];
  const scope = `crm.objects.${objectType}.read`;

  // Narrower populations (open deals, say) are shared between checks, so
  // each one costs a single Search call.
  const populations = new Map<string, number>();
  async function populationOf(check: CountCheck) {
    if (!check.populationFilterGroups) return { ok: true as const, data: totalRecords };
    const groups = check.populationFilterGroups();
    const key = JSON.stringify(groups);
    const known = populations.get(key);
    if (known !== undefined) return { ok: true as const, data: known };
    const result = await countWhere(transport, tracker, pace, objectType, groups);
    if (result.ok) populations.set(key, result.data);
    return result;
  }

  // Count checks: the first page gives the total and samples; further pages,
  // up to the work-list cap, give the export IDs.
  const countChecks = COUNT_CHECKS.filter((c) => c.objectType === objectType);
  progress.phase(`Counting ${noun} record problems`, `0 of ${countChecks.length}`);
  for (const [i, check] of countChecks.entries()) {
    const meta = countCheckMeta(check, config);
    const skip = (reason: string, note = true) => {
      if (note) notes.push(`"${meta.title}" skipped: ${reason}.`);
      runs.push(...skippedChecks([meta], category, objectType, reason));
    };
    if (ctx.stopped) {
      skip(LIMIT_REASON, false);
      continue;
    }
    progress.detail(`${i + 1} of ${countChecks.length}`);

    const absent = check.requiredProps.filter((p) => !propertyNames.has(p));
    if (absent.length) {
      skip(`this portal has no ${absent.join(", ")} property`);
      continue;
    }
    const matched = await fetchMatching(
      transport,
      tracker,
      pace,
      objectType,
      {
        filterGroups: check.filterGroups(now, config),
        properties: ["hs_object_id"],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      },
      Math.max(config.records.workListCap, config.sampleCap),
      { onTotal: (_total, pages) => progress.plan(pages - 1) },
    );
    if (!matched.ok) {
      const outcome = classify(ctx, matched.kind);
      if (outcome === "abort") return { abort: matched.kind };
      skip(outcome === "stop" ? LIMIT_REASON : problemNote(matched.kind, scope), outcome === "skip");
      continue;
    }
    const population = await populationOf(check);
    if (!population.ok) {
      const outcome = classify(ctx, population.kind);
      if (outcome === "abort") return { abort: population.kind };
      skip(outcome === "stop" ? LIMIT_REASON : problemNote(population.kind, scope), outcome === "skip");
      continue;
    }

    const found = countFinding(
      check,
      { total: matched.data.total, population: population.data, ids: matched.data.rows.map((r) => r.id) },
      config,
    );
    findings.push(...found);
    notes.push(...found.flatMap(cappedNote));
    runs.push(ranCheck(meta, category, objectType, population.data, found));
  }

  // Window checks: field values from the most recently created records, or,
  // in a full duplicate scan, from every record.
  const windowCheck = WINDOW_CHECKS[objectType];
  if (!windowCheck) return { findings, notes, runs };
  const skipWindow = (reason: string, note = true) => {
    if (note) notes.push(`${label} duplicate checks skipped: ${reason}.`);
    runs.push(...skippedChecks(windowCheck.metas, category, objectType, reason));
    return { findings, notes, runs };
  };
  if (ctx.stopped) return skipWindow(LIMIT_REASON, false);

  const absent = windowCheck.properties.filter((p) => !propertyNames.has(p));
  if (absent.length) return skipWindow(`this portal has no ${absent.join(", ")} property`);

  const full = readsEveryRecord(ctx, totalRecords);
  const properties = [...windowCheck.properties, ...windowCheck.optional.filter((p) => propertyNames.has(p))];
  const collector = windowCheck.collect(ctx, full ? totalRecords : Math.min(config.records.recordWindow, totalRecords));
  let covered: number;
  // Why a full read ended early, when it did.
  let cutShort: "limit" | "error" | null = null;
  if (full) {
    progress.phase(`Reading every ${noun} for duplicates`, `0 of ${fmt(totalRecords)}`);
    const read = await readAllRecords(
      transport,
      tracker,
      pace,
      objectType,
      properties,
      totalRecords,
      {
        onRows: collector.add,
        onPage: (n) => progress.detail(`${fmt(n)} of ${fmt(totalRecords)}`),
        onExtraCall: () => progress.plan(1),
      },
      ctx.fullRead,
    );
    covered = read.read;
    if (!read.ok) {
      const outcome = classify(ctx, read.kind);
      if (outcome === "abort") return { abort: read.kind };
      // Records read before the stop are still matched: a partial read can
      // only miss pairs, not invent them.
      if (!covered) return skipWindow(outcome === "stop" ? LIMIT_REASON : problemNote(read.kind, scope), outcome === "skip");
      cutShort = outcome === "stop" ? "limit" : "error";
    }
  } else {
    const pages = pagesFor(Math.min(config.records.recordWindow, totalRecords));
    progress.phase(`Reading recent ${objectType} for duplicates`, `page 1 of ${pages}`);
    const window = await fetchRecentWindow(transport, tracker, pace, objectType, properties, config.records.recordWindow, {
      onRows: collector.add,
      onPage: (fetched) => progress.detail(`page ${Math.min(pages, Math.ceil(fetched / 200) + 1)} of ${pages}`),
    });
    if (!window.ok) {
      const outcome = classify(ctx, window.kind);
      if (outcome === "abort") return { abort: window.kind };
      return skipWindow(outcome === "stop" ? LIMIT_REASON : problemNote(window.kind, scope), outcome === "skip");
    }
    covered = window.data;
  }

  const coverage = cutShort
    ? `${fmt(covered)} of ${fmt(totalRecords)} ${objectType}, before ${cutShort === "limit" ? "HubSpot's rate limit" : "an error from HubSpot"} stopped the read`
    : full || covered >= totalRecords
      ? `all ${fmt(covered)} ${objectType}`
      : `the newest ${fmt(covered)} of ${fmt(totalRecords)} ${objectType}`;
  const complete = async (): Promise<WindowResult | null> => {
    progress.phase(`Matching ${noun} duplicates`, `${fmt(covered)} ${objectType}`);
    const done = await collector.finish();
    if (!done) return null;
    const tool =
      full && !cutShort
        ? ""
        : ` On Professional and Enterprise plans, HubSpot's Manage duplicates tool checks the whole portal: ${DUPLICATE_TOOL_PATH[objectType as "contacts" | "companies"]}.`;
    const checked = `Checked ${coverage}.${cutShort ? " Not scored: the read didn't finish." : ""}`;
    const unfinished = `partial: ${coverage}`;
    return {
      findings: done.findings.map((f) => ({ ...f, coverage: checked })),
      notes: [
        ...done.findings.flatMap(cappedNote),
        `${label} duplicate${objectType === "contacts" ? " and email" : ""} checks covered ${coverage}.${tool}`,
        ...done.notes,
      ],
      runs: windowCheck.metas.map((meta) => {
        const run = ranCheck(meta, category, objectType, covered, done.findings);
        return cutShort && run.status === "scored" ? { ...run, status: "unscored" as const, reason: unfinished } : run;
      }),
    };
  };
  if (windowCheck.deferred) {
    ctx.deferred.push(complete);
    return { findings, notes, runs };
  }
  const done = await complete();
  if (!done) return { abort: "cancelled" };
  return { findings: [...findings, ...done.findings], notes: [...notes, ...done.notes], runs: [...runs, ...done.runs] };
}

const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;

// Segment (list) checks: the segment list gives names, sizes and ages; the
// active segments' filter definitions are read in batches and checked
// against the property lists the scan already has. Properties missing from
// those lists are looked up one by one before anything is flagged.
async function runSegmentChecks(ctx: ScanContext, setups: ObjectSetup[]): Promise<PhaseResult> {
  const { transport, tracker, config, now, progress } = ctx;
  const findings: Finding[] = [];
  const notes: string[] = [];
  const runs: CheckRun[] = [];
  const scope = "crm.lists.read";
  const skip = (metas: CheckMeta[], reason: string, note: string | false) => {
    if (note) notes.push(`${note} skipped: ${reason}.`);
    runs.push(...skippedChecks(metas, "Segments", "segments", reason));
  };
  if (ctx.stopped) {
    skip(SEGMENT_METAS, LIMIT_REASON, false);
    return { findings, notes, runs };
  }

  progress.phase("Reading segments");
  const read = await readSegments(transport, tracker, { onTotal: (_total, pages) => progress.plan(pages - 1) });
  if (!read.ok) {
    const outcome = classify(ctx, read.kind);
    if (outcome === "abort") return { abort: read.kind };
    skip(SEGMENT_METAS, outcome === "stop" ? LIMIT_REASON : problemNote(read.kind, scope), outcome === "skip" && "Segment checks");
    return { findings, notes, runs };
  }
  const segments = read.data;
  const active = segments.filter(isActive);
  notes.push(`Segment checks covered all ${plural(segments.length, "segment", "segments")} (${fmt(active.length)} active).`);

  // The segment list alone is enough for these two.
  const empty = checkEmptySegments(segments, now, config);
  const duplicates = checkDuplicateSegmentNames(segments, config);
  findings.push(...empty, ...duplicates);
  runs.push(
    ranCheck(EMPTY_SEGMENTS, "Segments", "segments", emptySegmentsPopulation(segments, now, config).length, empty),
    ranCheck(DUPLICATE_SEGMENT_NAMES, "Segments", "segments", segments.length, duplicates),
  );

  // Active segments' filters.
  const batchSize = config.segments.filterBatchSize;
  progress.plan(Math.ceil(active.length / batchSize));
  progress.phase("Checking segment filters", `0 of ${fmt(active.length)}`);
  const filters = await readSegmentFilters(transport, tracker, active.map((s) => s.id), batchSize, (done) =>
    progress.detail(`${fmt(done)} of ${fmt(active.length)}`),
  );
  if (!filters.ok) {
    const outcome = classify(ctx, filters.kind);
    if (outcome === "abort") return { abort: filters.kind };
    const reason = outcome === "stop" ? LIMIT_REASON : problemNote(filters.kind, scope);
    skip([SEGMENT_MISSING_PROPERTY], reason, outcome === "skip" && `"${SEGMENT_MISSING_PROPERTY.title}"`);
    return { findings, notes, runs };
  }

  // Properties each segment uses, and the ones the property lists don't have.
  const known = new Map(setups.flatMap((s) => (s.props ? [[s.objectType, s.propertyNames] as const] : [])));
  const keyOf = (ref: PropertyRef) => `${ref.objectType}.${ref.property}`;
  const checked: { segment: SegmentDef; refs: PropertyRef[] }[] = [];
  const toLookUp = new Map<string, PropertyRef>();
  const unreadObjects = new Set<ObjectType>();
  let unchecked = 0;
  for (const segment of active) {
    const branch = filters.data.get(segment.id);
    if (!branch) continue;
    const used = filterProperties(branch, segment.objectTypeId);
    unchecked += used.unchecked;
    const refs = used.refs.filter((ref) => {
      if (known.has(ref.objectType)) return true;
      unreadObjects.add(ref.objectType);
      return false;
    });
    for (const ref of refs) if (!known.get(ref.objectType)!.has(ref.property)) toLookUp.set(keyOf(ref), ref);
    checked.push({ segment, refs });
  }

  // Archived, sensitive, or gone? A refused lookup (403) can't be verified,
  // so it isn't flagged.
  const statuses = new Map<string, PropertyStatus>();
  const lookups = [...toLookUp.entries()].slice(0, config.segments.maxPropertyLookups);
  const notLookedUp = toLookUp.size - lookups.length;
  if (lookups.length) progress.phase("Looking up properties used in segment filters", `0 of ${lookups.length}`);
  progress.plan(lookups.length);
  for (const [i, [key, ref]] of lookups.entries()) {
    const status = await propertyStatus(transport, tracker, ref.objectType, ref.property);
    progress.detail(`${i + 1} of ${lookups.length}`);
    if (status.ok) {
      statuses.set(key, status.data);
      continue;
    }
    const outcome = classify(ctx, status.kind);
    if (outcome === "abort") return { abort: status.kind };
    if (outcome === "stop") break;
    statuses.set(key, "unverified");
  }
  if (ctx.stopped) {
    skip([SEGMENT_MISSING_PROPERTY], LIMIT_REASON, false);
    return { findings, notes, runs };
  }

  const results = checked.map(({ segment, refs }) => ({
    segment,
    missing: refs.flatMap((ref): MissingProperty[] => {
      const status = statuses.get(keyOf(ref));
      return status === "archived" || status === "not_found" ? [{ ...ref, status }] : [];
    }),
  }));
  const missing = checkSegmentProperties(results, checked.length, config);
  findings.push(...missing);
  runs.push(ranCheck(SEGMENT_MISSING_PROPERTY, "Segments", "segments", checked.length, missing));

  const unverified = [...statuses].filter(([, s]) => s === "unverified").map(([key]) => key);
  if (unverified.length) {
    notes.push(
      `Segment filters: couldn't verify ${plural(unverified.length, "property", "properties")} (${unverified.join(", ")}). HubSpot refused the lookup, as it does for sensitive properties this key can't see, so segments that use ${unverified.length === 1 ? "it" : "them"} weren't flagged.`,
    );
  }
  if (notLookedUp) {
    notes.push(
      `Segment filters: ${plural(notLookedUp, "more property", "more properties")} missing from the property lists ${notLookedUp === 1 ? "wasn't" : "weren't"} looked up (the scan looks up at most ${config.segments.maxPropertyLookups}), so segments that use ${notLookedUp === 1 ? "it" : "them"} weren't flagged.`,
    );
  }
  if (unreadObjects.size) {
    notes.push(`Segment filters on ${[...unreadObjects].join(", ")} properties weren't checked: the scan couldn't read those property lists.`);
  }
  if (unchecked) {
    notes.push(`Segment filters on events, tickets or custom objects aren't checked (${plural(unchecked, "filter", "filters")}).`);
  }
  return { findings, notes, runs };
}

export async function runScan(transport: Transport, options: ScanOptions = {}): Promise<ScanResult> {
  const config = options.config ?? CHECKS_CONFIG;
  const scoring = options.scoring ?? SCORING_CONFIG;
  const simulated = options.simulated ?? false;
  const started = performance.now();

  const tracker = newTracker({ signal: options.signal, retry: options.retry, sleep: options.sleep });
  const progress = createProgress({
    emit: options.onProgress ?? (() => {}),
    counts: () => ({ calls: tracker.calls, retries: tracker.retries }),
    simulated,
  });
  tracker.onCall = () => progress.tick();
  tracker.onRetryWait = (w) => progress.waiting(w.delayMs, w.retry, w.maxRetries, w.reason);
  const ctx: ScanContext = {
    transport,
    tracker,
    pace: createPacer(config.searchMinIntervalMs),
    config,
    now: Date.now(),
    progress,
    companyDomains: () => new Map(),
    deferred: [],
    fullDuplicates: options.fullDuplicates ?? false,
    fullRead: options.fullRead ?? FULL_READ_CONFIG,
  };
  const { pace } = ctx;

  // Setup: account, then each object's property list and record total. After
  // this the scan knows how many calls the checks will make.
  progress.plan(1 + OBJECT_TYPES.length * 2);
  progress.phase("Reading portal setup");
  const account = await getAccountDetails(transport, tracker);
  // With no account details there's nothing to report, even when the cause
  // is the rate limit.
  if (!account.ok) return { ok: false, kind: account.kind };

  const scannedObjects: ObjectType[] = [];
  const notes: string[] = [];
  const findings: Finding[] = [];
  const runs: CheckRun[] = [];
  const setups: ObjectSetup[] = [];

  for (const objectType of OBJECT_TYPES) {
    const label = OBJECT_LABELS[objectType];
    const category = CATEGORY_FOR_OBJECT[objectType];
    const setup: ObjectSetup = { objectType, propertyNames: new Set() };
    setups.push(setup);
    const allMetas = [...PROPERTY_LIST_CHECKS.map((c) => c.meta), nearZeroFill(config)];
    if (ctx.stopped) {
      runs.push(
        ...skippedChecks(allMetas, "Properties", objectType, LIMIT_REASON),
        ...skippedChecks(recordCheckMetas(objectType, config), category, objectType, LIMIT_REASON),
      );
      continue;
    }

    const props = await listProperties(transport, tracker, objectType);
    if (!props.ok) {
      const outcome = classify(ctx, props.kind);
      if (outcome === "abort") return { ok: false, kind: props.kind };
      const reason = outcome === "stop" ? LIMIT_REASON : problemNote(props.kind, `crm.schemas.${objectType}.read`);
      if (outcome === "skip") notes.push(`${label} skipped: ${reason}.`);
      runs.push(
        ...skippedChecks(allMetas, "Properties", objectType, reason),
        ...skippedChecks(recordCheckMetas(objectType, config), category, objectType, reason),
      );
      continue;
    }
    setup.props = props.data;
    setup.propertyNames = new Set(props.data.map((p) => p.name));
    scannedObjects.push(objectType);

    // Fill rate and record checks need record access, which uses a different scope.
    const skipRecordAccess = (reason: string, note = true) => {
      if (note) notes.push(`${label} fill-rate and record checks skipped: ${reason}.`);
      runs.push(
        ...skippedChecks([nearZeroFill(config)], "Properties", objectType, reason),
        ...skippedChecks(recordCheckMetas(objectType, config), category, objectType, reason),
      );
    };
    const total = await countRecords(transport, tracker, pace, objectType);
    if (!total.ok) {
      const outcome = classify(ctx, total.kind);
      if (outcome === "abort") return { ok: false, kind: total.kind };
      skipRecordAccess(
        outcome === "stop" ? LIMIT_REASON : problemNote(total.kind, `crm.objects.${objectType}.read`),
        outcome === "skip",
      );
      continue;
    }
    if (total.data === 0) {
      skipRecordAccess("no records yet");
      continue;
    }
    setup.total = total.data;
  }

  // Plus the segments' first page; the rest are planned once its total is known.
  progress.beginChecks(setups.reduce((n, setup) => n + plannedCalls(setup, ctx), 0) + 1);

  // Checks, object by object.
  for (const setup of setups) {
    const { objectType, props } = setup;
    if (!props) continue;
    const label = OBJECT_LABELS[objectType];
    const noun = OBJECT_NOUNS[objectType];

    progress.phase(`Checking ${noun} properties`);
    // Some functions report two checks (exact and near duplicates), so each
    // function runs once and its findings are matched to both.
    const listFindings = [...new Set(PROPERTY_LIST_CHECKS.map((c) => c.run))].flatMap((run) =>
      run(objectType, props, config),
    );
    findings.push(...listFindings);
    runs.push(
      ...PROPERTY_LIST_CHECKS.map((c) =>
        ranCheck(c.meta, "Properties", objectType, c.population(props), listFindings),
      ),
    );
    if (setup.total === undefined) continue;

    // Fill rate.
    const fill = nearZeroFill(config);
    if (ctx.stopped) {
      runs.push(...skippedChecks([fill], "Properties", objectType, LIMIT_REASON));
    } else {
      const candidates = fillRateCandidates(props, ctx.now, config);
      const filled = new Map<string, number>();
      let failed = 0;
      progress.phase(`Measuring ${noun} fill rates`, `0 of ${candidates.length}`);
      for (const [i, p] of candidates.entries()) {
        const count = await countRecords(transport, tracker, pace, objectType, p.name);
        progress.detail(`${i + 1} of ${candidates.length}`);
        if (count.ok) {
          filled.set(p.name, count.data);
          continue;
        }
        const outcome = classify(ctx, count.kind);
        if (outcome === "abort") return { ok: false, kind: count.kind };
        if (outcome === "stop") break;
        failed++;
      }
      if (ctx.stopped) {
        // A half-measured fill rate would be misleading, so none is scored.
        runs.push(...skippedChecks([fill], "Properties", objectType, LIMIT_REASON));
      } else {
        if (failed) {
          notes.push(`${label}: couldn't measure fill rate for ${failed} of ${candidates.length} properties.`);
        }
        const fillFindings = checkFillRate(objectType, candidates, filled, setup.total, config);
        findings.push(...fillFindings);
        runs.push(ranCheck(fill, "Properties", objectType, fillRatePopulation(candidates, filled), fillFindings));
      }
    }

    const records = await runRecordChecks(ctx, setup);
    if ("abort" in records) return { ok: false, kind: records.abort };
    findings.push(...records.findings);
    notes.push(...records.notes);
    runs.push(...records.runs);
  }

  // Contacts are matched once the company window is read.
  for (const complete of ctx.deferred) {
    const done = await complete();
    if (!done) return { ok: false, kind: "cancelled" };
    findings.push(...done.findings);
    notes.push(...done.notes);
    runs.push(...done.runs);
  }

  const segments = await runSegmentChecks(ctx, setups);
  if ("abort" in segments) return { ok: false, kind: segments.abort };
  findings.push(...segments.findings);
  notes.push(...segments.notes);
  runs.push(...segments.runs);

  progress.phase("Scoring");
  findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
  );
  const report: ScanReport = {
    scannedAt: new Date().toISOString(),
    portal: account.data,
    scannedObjects,
    notes,
    findings,
    checks: runs,
    score: scoreChecks(runs, scoring),
    apiCalls: tracker.calls,
    retries: tracker.retries,
    durationMs: Math.round(performance.now() - started),
    simulated,
    ...(ctx.fullDuplicates && { fullDuplicates: true }),
    ...(ctx.stopped && {
      incomplete: { kind: ctx.stopped, message: limitMessage(ctx.stopped, account.data.timeZone) },
    }),
  };
  progress.finish(ctx.stopped ? "Stopped early: HubSpot rate limit" : "Done");
  return { ok: true, report };
}
