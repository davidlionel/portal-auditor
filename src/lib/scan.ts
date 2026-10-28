import type { Client } from "@hubspot/api-client";
import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
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
  makeClient,
  type AccountDetails,
  type CallCounter,
  type HubSpotErrorKind,
} from "./hubspot/client";
import { listProperties, type ObjectType } from "./hubspot/properties";
import {
  countRecords,
  countWhere,
  fetchMatching,
  fetchRecentWindow,
  type SearchRow,
} from "./hubspot/search";
import { createPacer, type Pacer } from "./pace";
import { scoreChecks, type HealthScore } from "./scoring";

const OBJECT_TYPES: ObjectType[] = ["contacts", "companies", "deals"];

const OBJECT_LABELS: Record<ObjectType, string> = {
  contacts: "Contacts",
  companies: "Companies",
  deals: "Deals",
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

export type ScanReport = {
  portal: AccountDetails;
  scannedObjects: ObjectType[];
  // Plain-language notes on anything the scan couldn't cover.
  notes: string[];
  findings: Finding[];
  // Every check attempted, scored or not.
  checks: CheckRun[];
  score: HealthScore;
  apiCalls: number;
  durationMs: number;
};

export type ScanResult =
  | { ok: true; report: ScanReport }
  | { ok: false; kind: HubSpotErrorKind };

type ScanContext = {
  client: Client;
  counter: CallCounter;
  pace: Pacer;
  config: ChecksConfig;
  now: number;
};

// What a phase adds to the report, or a stop because the key was rejected.
type PhaseResult =
  | { findings: Finding[]; notes: string[]; runs: CheckRun[] }
  | { abort: HubSpotErrorKind };

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

async function runRecordChecks(
  ctx: ScanContext,
  objectType: ObjectType,
  propertyNames: Set<string>,
  totalRecords: number,
): Promise<PhaseResult> {
  const { client, counter, pace, config, now } = ctx;
  const label = OBJECT_LABELS[objectType];
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
    const result = await countWhere(client, counter, pace, objectType, groups);
    if (result.ok) populations.set(key, result.data);
    return result;
  }

  // Count checks: the first page gives the total and samples; further pages,
  // up to the work-list cap, give the export IDs.
  for (const check of COUNT_CHECKS.filter((c) => c.objectType === objectType)) {
    const meta = countCheckMeta(check, config);
    const skip = (reason: string) => {
      notes.push(`"${meta.title}" skipped: ${reason}.`);
      runs.push(...skippedChecks([meta], category, objectType, reason));
    };

    const absent = check.requiredProps.filter((p) => !propertyNames.has(p));
    if (absent.length) {
      skip(`this portal has no ${absent.join(", ")} property`);
      continue;
    }
    const matched = await fetchMatching(
      client,
      counter,
      pace,
      objectType,
      {
        filterGroups: check.filterGroups(now, config),
        properties: ["hs_object_id"],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      },
      Math.max(config.records.workListCap, config.sampleCap),
    );
    if (!matched.ok) {
      if (matched.kind === "invalid_token") return { abort: matched.kind };
      skip(problemNote(matched.kind, scope));
      continue;
    }
    const population = await populationOf(check);
    if (!population.ok) {
      if (population.kind === "invalid_token") return { abort: population.kind };
      skip(problemNote(population.kind, scope));
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
  const skipWindow = (reason: string) => {
    notes.push(`${label} duplicate checks skipped: ${reason}.`);
    runs.push(...skippedChecks(windowCheck.metas, category, objectType, reason));
    return { findings, notes, runs };
  };

  const absent = windowCheck.properties.filter((p) => !propertyNames.has(p));
  if (absent.length) return skipWindow(`this portal has no ${absent.join(", ")} property`);

  const window = await fetchRecentWindow(
    client,
    counter,
    pace,
    objectType,
    windowCheck.properties,
    config.records.recordWindow,
  );
  if (!window.ok) {
    if (window.kind === "invalid_token") return { abort: window.kind };
    return skipWindow(problemNote(window.kind, scope));
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

export async function runScan(
  token: string,
  config: ChecksConfig = CHECKS_CONFIG,
  scoring: ScoringConfig = SCORING_CONFIG,
): Promise<ScanResult> {
  const started = performance.now();
  const ctx: ScanContext = {
    client: makeClient(token),
    counter: { calls: 0 },
    pace: createPacer(config.searchMinIntervalMs),
    config,
    now: Date.now(),
  };
  const { client, counter, pace } = ctx;

  const account = await getAccountDetails(client, counter);
  if (!account.ok) return { ok: false, kind: account.kind };

  const scannedObjects: ObjectType[] = [];
  const notes: string[] = [];
  const findings: Finding[] = [];
  const runs: CheckRun[] = [];

  for (const objectType of OBJECT_TYPES) {
    const label = OBJECT_LABELS[objectType];
    const category = CATEGORY_FOR_OBJECT[objectType];
    // Fill rate and record checks need record access, which uses a different scope.
    const skipRecordAccess = (reason: string) => {
      notes.push(`${label} fill-rate and record checks skipped: ${reason}.`);
      runs.push(
        ...skippedChecks([nearZeroFill(config)], "Properties", objectType, reason),
        ...skippedChecks(recordCheckMetas(objectType, config), category, objectType, reason),
      );
    };

    const props = await listProperties(client, counter, objectType);
    if (!props.ok) {
      if (props.kind === "invalid_token") return { ok: false, kind: props.kind };
      const reason = problemNote(props.kind, `crm.schemas.${objectType}.read`);
      notes.push(`${label} skipped: ${reason}.`);
      runs.push(
        ...skippedChecks(
          [...PROPERTY_LIST_CHECKS.map((c) => c.meta), nearZeroFill(config)],
          "Properties",
          objectType,
          reason,
        ),
        ...skippedChecks(recordCheckMetas(objectType, config), category, objectType, reason),
      );
      continue;
    }
    scannedObjects.push(objectType);

    // Some functions report two checks (exact and near duplicates), so each
    // function runs once and its findings are matched to both.
    const listFindings = [...new Set(PROPERTY_LIST_CHECKS.map((c) => c.run))].flatMap((run) =>
      run(objectType, props.data, config),
    );
    findings.push(...listFindings);
    runs.push(
      ...PROPERTY_LIST_CHECKS.map((c) =>
        ranCheck(c.meta, "Properties", objectType, c.population(props.data), listFindings),
      ),
    );

    const total = await countRecords(client, counter, pace, objectType);
    if (!total.ok) {
      if (total.kind === "invalid_token") return { ok: false, kind: total.kind };
      skipRecordAccess(problemNote(total.kind, `crm.objects.${objectType}.read`));
      continue;
    }
    if (total.data === 0) {
      skipRecordAccess("no records yet");
      continue;
    }

    const candidates = fillRateCandidates(props.data, ctx.now, config);
    const filled = new Map<string, number>();
    let failed = 0;
    for (const p of candidates) {
      const count = await countRecords(client, counter, pace, objectType, p.name);
      if (count.ok) filled.set(p.name, count.data);
      else if (count.kind === "invalid_token") return { ok: false, kind: count.kind };
      else failed++;
    }
    if (failed) {
      notes.push(`${label}: couldn't measure fill rate for ${failed} of ${candidates.length} properties.`);
    }
    const fillFindings = checkFillRate(objectType, candidates, filled, total.data, config);
    findings.push(...fillFindings);
    runs.push(
      ranCheck(nearZeroFill(config), "Properties", objectType, fillRatePopulation(candidates, filled), fillFindings),
    );

    const records = await runRecordChecks(
      ctx,
      objectType,
      new Set(props.data.map((p) => p.name)),
      total.data,
    );
    if ("abort" in records) return { ok: false, kind: records.abort };
    findings.push(...records.findings);
    notes.push(...records.notes);
    runs.push(...records.runs);
  }

  findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
  );

  return {
    ok: true,
    report: {
      portal: account.data,
      scannedObjects,
      notes,
      findings,
      checks: runs,
      score: scoreChecks(runs, scoring),
      apiCalls: counter.calls,
      durationMs: Math.round(performance.now() - started),
    },
  };
}
