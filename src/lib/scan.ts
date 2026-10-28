import { CHECKS_CONFIG, type ChecksConfig } from "@/config/checks";
import { checkDropdownVariants } from "./checks/properties/dropdown-variants";
import { checkDuplicateLabels } from "./checks/properties/duplicate-labels";
import { checkFillRate, fillRateCandidates } from "./checks/properties/fill-rate";
import { checkNoDescription } from "./checks/properties/no-description";
import { SEVERITY_RANK, type Finding } from "./checks/types";
import {
  getAccountDetails,
  makeClient,
  type AccountDetails,
  type CallCounter,
  type HubSpotErrorKind,
} from "./hubspot/client";
import { listProperties, type ObjectType } from "./hubspot/properties";
import { countRecords } from "./hubspot/search";
import { createPacer } from "./pace";

const OBJECT_TYPES: ObjectType[] = ["contacts", "companies", "deals"];

const OBJECT_LABELS: Record<ObjectType, string> = {
  contacts: "Contacts",
  companies: "Companies",
  deals: "Deals",
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

function problemNote(kind: HubSpotErrorKind, scope: string): string {
  return kind === "missing_scope"
    ? `key lacks ${scope}`
    : `HubSpot returned an error (${kind.replace("_", " ")})`;
}

export async function runPropertiesScan(
  token: string,
  config: ChecksConfig = CHECKS_CONFIG,
): Promise<ScanResult> {
  const started = performance.now();
  const client = makeClient(token);
  const counter: CallCounter = { calls: 0 };
  const pace = createPacer(config.searchMinIntervalMs);

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

    // Fill rate needs record counts, which use a different scope.
    const total = await countRecords(client, counter, pace, objectType);
    if (!total.ok) {
      if (total.kind === "invalid_token") return { ok: false, kind: total.kind };
      notes.push(
        `${label} fill-rate check skipped: ${problemNote(total.kind, `crm.objects.${objectType}.read`)}.`,
      );
      continue;
    }
    if (total.data === 0) {
      notes.push(`${label} fill-rate check skipped: no records yet.`);
      continue;
    }

    const candidates = fillRateCandidates(props.data, Date.now(), config);
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
