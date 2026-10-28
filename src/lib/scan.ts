import type { Client } from "@hubspot/api-client";
import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { checkDropdownVariants } from "./checks/properties/dropdown-variants";
import { checkDuplicateLabels } from "./checks/properties/duplicate-labels";
import { checkFillRate, fillRateCandidates } from "./checks/properties/fill-rate";
import { checkNoDescription } from "./checks/properties/no-description";
import { COUNT_CHECKS, countCheckTitle, countFinding } from "./checks/records/count-checks";
import {
  DUPLICATE_TOOL_PATH,
  checkDuplicateContacts,
  checkDuplicateDomains,
} from "./checks/records/duplicates";
import { checkMalformedEmails } from "./checks/records/email-quality";
import { SEVERITY_RANK, type Finding } from "./checks/types";
import {
  getAccountDetails,
  makeClient,
  type AccountDetails,
  type CallCounter,
  type HubSpotErrorKind,
} from "./hubspot/client";
import { listProperties, type ObjectType } from "./hubspot/properties";
import { countRecords, fetchRecentWindow, searchRecords, type SearchRow } from "./hubspot/search";
import { createPacer, type Pacer } from "./pace";

const OBJECT_TYPES: ObjectType[] = ["contacts", "companies", "deals"];

const OBJECT_LABELS: Record<ObjectType, string> = {
  contacts: "Contacts",
  companies: "Companies",
  deals: "Deals",
};

// Fields the row-level checks read from the recent-records window. Only
// these are requested; values stay in memory for the scan and are never
// returned to the browser.
const WINDOW_PROPERTIES: Partial<Record<ObjectType, string[]>> = {
  contacts: ["firstname", "lastname", "company", "email"],
  companies: ["domain"],
};

const WINDOW_CHECKS: Partial<Record<ObjectType, (rows: SearchRow[], config: ChecksConfig) => Finding[]>> = {
  contacts: (rows, config) => [
    ...checkDuplicateContacts(rows, config),
    ...checkMalformedEmails(rows, config),
  ],
  companies: (rows, config) => checkDuplicateDomains(rows, config),
};

export type ScanReport = {
  portal: AccountDetails;
  scannedObjects: ObjectType[];
  // Plain-language notes on anything the scan couldn't cover.
  notes: string[];
  findings: Finding[];
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

// Record checks either add findings and notes, or stop the whole scan
// because the key itself was rejected.
type PhaseResult = { findings: Finding[]; notes: string[] } | { abort: HubSpotErrorKind };

function problemNote(kind: HubSpotErrorKind, scope: string): string {
  return kind === "missing_scope"
    ? `key lacks ${scope}`
    : `HubSpot returned an error (${kind.replace("_", " ")})`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

async function runRecordChecks(
  ctx: ScanContext,
  objectType: ObjectType,
  propertyNames: Set<string>,
  totalRecords: number,
): Promise<PhaseResult> {
  const { client, counter, pace, config, now } = ctx;
  const label = OBJECT_LABELS[objectType];
  const findings: Finding[] = [];
  const notes: string[] = [];

  // Count checks: one Search call each, whatever the portal's size.
  for (const check of COUNT_CHECKS.filter((c) => c.objectType === objectType)) {
    const absent = check.requiredProps.filter((p) => !propertyNames.has(p));
    if (absent.length) {
      notes.push(
        `"${countCheckTitle(check, config)}" skipped: this portal has no ${absent.join(", ")} property.`,
      );
      continue;
    }
    const result = await searchRecords(client, counter, pace, objectType, {
      filterGroups: check.filterGroups(now, config),
      properties: ["hs_object_id"],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: config.sampleCap,
    });
    if (!result.ok) {
      if (result.kind === "invalid_token") return { abort: result.kind };
      notes.push(`"${countCheckTitle(check, config)}" skipped: ${problemNote(result.kind, `crm.objects.${objectType}.read`)}.`);
      continue;
    }
    findings.push(
      ...countFinding(check, result.data.total, result.data.results.map((r) => r.id), config),
    );
  }

  // Window checks: field values from the most recently created records.
  const properties = WINDOW_PROPERTIES[objectType];
  const runWindowChecks = WINDOW_CHECKS[objectType];
  if (!properties || !runWindowChecks) return { findings, notes };

  const absent = properties.filter((p) => !propertyNames.has(p));
  if (absent.length) {
    notes.push(`${label} duplicate checks skipped: this portal has no ${absent.join(", ")} property.`);
    return { findings, notes };
  }
  const window = await fetchRecentWindow(
    client,
    counter,
    pace,
    objectType,
    properties,
    config.records.recordWindow,
  );
  if (!window.ok) {
    if (window.kind === "invalid_token") return { abort: window.kind };
    notes.push(`${label} duplicate checks skipped: ${problemNote(window.kind, `crm.objects.${objectType}.read`)}.`);
    return { findings, notes };
  }
  findings.push(...runWindowChecks(window.data, config));

  const covered = window.data.length;
  const coverage =
    covered >= totalRecords
      ? `all ${fmt(totalRecords)} ${objectType}`
      : `the ${fmt(covered)} most recently created of ${fmt(totalRecords)} ${objectType}`;
  const tool = objectType === "contacts" || objectType === "companies"
    ? ` HubSpot's own duplicate tool scans the whole portal: ${DUPLICATE_TOOL_PATH[objectType]}.`
    : "";
  notes.push(`${label} duplicate${objectType === "contacts" ? " and email" : ""} checks covered ${coverage}.${tool}`);

  return { findings, notes };
}

export async function runScan(
  token: string,
  config: ChecksConfig = CHECKS_CONFIG,
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

  for (const objectType of OBJECT_TYPES) {
    const label = OBJECT_LABELS[objectType];

    const props = await listProperties(client, counter, objectType);
    if (!props.ok) {
      if (props.kind === "invalid_token") return { ok: false, kind: props.kind };
      notes.push(
        `${label} skipped: ${problemNote(props.kind, `crm.schemas.${objectType}.read`)}.`,
      );
      continue;
    }
    scannedObjects.push(objectType);

    findings.push(
      ...checkNoDescription(objectType, props.data, config),
      ...checkDuplicateLabels(objectType, props.data, config),
      ...checkDropdownVariants(objectType, props.data, config),
    );

    // Fill rate and record checks need record access, which uses a different scope.
    const total = await countRecords(client, counter, pace, objectType);
    if (!total.ok) {
      if (total.kind === "invalid_token") return { ok: false, kind: total.kind };
      notes.push(
        `${label} fill-rate and record checks skipped: ${problemNote(total.kind, `crm.objects.${objectType}.read`)}.`,
      );
      continue;
    }
    if (total.data === 0) {
      notes.push(`${label} fill-rate and record checks skipped: no records yet.`);
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
    findings.push(...checkFillRate(objectType, candidates, filled, total.data, config));

    const records = await runRecordChecks(
      ctx,
      objectType,
      new Set(props.data.map((p) => p.name)),
      total.data,
    );
    if ("abort" in records) return { ok: false, kind: records.abort };
    findings.push(...records.findings);
    notes.push(...records.notes);
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
      apiCalls: counter.calls,
      durationMs: Math.round(performance.now() - started),
    },
  };
}
