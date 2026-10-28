import type { ScanReport } from "../scan";
import { scoreChecks } from "../scoring";
import { validateSnapshot, type DemoSnapshot } from "./snapshot";

export type DemoResult =
  | { ok: true; scannedAt: string; report: ScanReport }
  | { ok: false; reason: string };

// Validates a snapshot and re-scores it with the current scoring config, so
// the score, Top 5 and explanation always match the code. Snapshots saved
// before reports carried a scan date get the snapshot's.
export function prepareDemo(snapshot: unknown): DemoResult {
  const errors = validateSnapshot(snapshot);
  if (errors.length) return { ok: false, reason: `The sample failed its safety check: ${errors[0]}` };
  const { scannedAt, report } = snapshot as DemoSnapshot;
  return {
    ok: true,
    scannedAt,
    report: { ...report, scannedAt: report.scannedAt ?? scannedAt, score: scoreChecks(report.checks) },
  };
}
