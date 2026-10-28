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
import {
  DUPLICATE_CONTACTS,
  DUPLICATE_DOMAINS,
  DUPLICATE_TOOL_PATH,
  checkDuplicateContacts,
  checkDuplicateDomains,
} from "./checks/records/duplicates";
import { MALFORMED_EMAIL, checkMalformedEmails } from "./checks/records/email-quality";
import {
  CATEGORY_FOR_OBJECT,
  SEVERITY_RANK,
  type Category,
  type CheckMeta,
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
import { listProperties, type ObjectType, type PropertyDef } from "./hubspot/properties";
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

// Checks that read field values from the recent-records window. Only these
// fields are requested; values stay in memory for the scan and are never
// returned to the browser.
type WindowCheck = {
  properties: string[];
  metas: CheckMeta[];
  run: (rows: SearchRow[], config: ChecksConfig) => Finding[];
};

const WINDOW_CHECKS: Partial<Record<ObjectType, WindowCheck>> = {
  contacts: {
    properties: ["firstname", "lastname", "company", "email"],
    metas: [DUPLICATE_CONTACTS, MALFORMED_EMAIL],
    run: (rows, config) => [
      ...checkDuplicateContacts(rows, config),
      ...checkMalformedEmails(rows, config),
    ],
  },
  companies: {
    properties: ["domain"],
    metas: [DUPLICATE_DOMAINS],
    run: (rows, config) => checkDuplicateDomains(rows, config),
  },
};

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
};

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
  objectType: ObjectType,
  population: number,
  findings: Finding[],
): CheckRun {
  const found = findings.find((f) => f.checkId === meta.checkId && f.objectType === objectType);
  return {
    ...meta,
    category,
    objectType,
    status: population > 0 ? "scored" : "empty",
    affected: found?.affected ?? 0,
    population,
  };
}

function skippedChecks(
  metas: CheckMeta[],
  category: Category,
  objectType: ObjectType,
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

// Calls the checks phase will make for one object, known once setup is done.
// Count checks that need more than one page add theirs as they find out.
function plannedCalls(setup: ObjectSetup, config: ChecksConfig, now: number): number {
  if (!setup.props || !setup.total) return 0;
  const countChecks = runnableCountChecks(setup);
  const populations = new Set(
    countChecks.flatMap((c) => (c.populationFilterGroups ? [JSON.stringify(c.populationFilterGroups())] : [])),
  );
  const window = WINDOW_CHECKS[setup.objectType];
  const windowPages =
    window && window.properties.every((p) => setup.propertyNames.has(p))
      ? pagesFor(Math.min(config.records.recordWindow, setup.total))
      : 0;
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

  // Window checks: field values from the most recently created records.
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

  const pages = pagesFor(Math.min(config.records.recordWindow, totalRecords));
  progress.phase(`Reading recent ${objectType} for duplicates`, `page 1 of ${pages}`);
  const window = await fetchRecentWindow(
    transport,
    tracker,
    pace,
    objectType,
    windowCheck.properties,
    config.records.recordWindow,
    { onPage: (fetched) => progress.detail(`page ${Math.min(pages, Math.ceil(fetched / 200) + 1)} of ${pages}`) },
  );
  if (!window.ok) {
    const outcome = classify(ctx, window.kind);
    if (outcome === "abort") return { abort: window.kind };
    return skipWindow(outcome === "stop" ? LIMIT_REASON : problemNote(window.kind, scope), outcome === "skip");
  }
  const found = windowCheck.run(window.data, config);
  findings.push(...found);
  notes.push(...found.flatMap(cappedNote));
  runs.push(
    ...windowCheck.metas.map((meta) => ranCheck(meta, category, objectType, window.data.length, found)),
  );

  const covered = window.data.length;
  const coverage =
    covered >= totalRecords
      ? `all ${fmt(totalRecords)} ${objectType}`
      : `the ${fmt(covered)} most recently created of ${fmt(totalRecords)} ${objectType}`;
  const tool = objectType === "contacts" || objectType === "companies"
    ? ` HubSpot's own duplicate tool scans the whole portal: ${DUPLICATE_TOOL_PATH[objectType]}.`
    : "";
  notes.push(`${label} duplicate${objectType === "contacts" ? " and email" : ""} checks covered ${coverage}.${tool}`);

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
  tracker.onRetryWait = (w) => progress.waiting(w.delayMs, w.retry, w.maxRetries);
  const ctx: ScanContext = {
    transport,
    tracker,
    pace: createPacer(config.searchMinIntervalMs),
    config,
    now: Date.now(),
    progress,
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

  progress.beginChecks(setups.reduce((n, setup) => n + plannedCalls(setup, config, ctx.now), 0));

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
    ...(ctx.stopped && {
      incomplete: { kind: ctx.stopped, message: limitMessage(ctx.stopped, account.data.timeZone) },
    }),
  };
  progress.finish(ctx.stopped ? "Stopped early: HubSpot rate limit" : "Done");
  return { ok: true, report };
}
