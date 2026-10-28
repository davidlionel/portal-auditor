import type { ScanReport } from "../scan";
import { scoreChecks } from "../scoring";
import { validateSnapshot, type DemoSnapshot } from "./snapshot";

export type DemoResult =
  | { ok: true; scannedAt: string; report: ScanReport }
  | { ok: false; reason: string };

// Validates a snapshot and re-scores it with the current scoring config, so
// the score, Top 5 and explanation always match the code.
export function prepareDemo(snapshot: unknown): DemoResult {
  const errors = validateSnapshot(snapshot);
  if (errors.length) return { ok: false, reason: `The sample failed its safety check: ${errors[0]}` };
  const { scannedAt, report } = snapshot as DemoSnapshot;
  return { ok: true, scannedAt, report: { ...report, score: scoreChecks(report.checks) } };
}
