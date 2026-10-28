import { CHECKS_CONFIG } from "@/config/checks";
import type { Transport } from "@/lib/hubspot/client";
import { runScan, type ScanReport } from "@/lib/scan";
import { SIZE_SMALL } from "@/lib/simulator/portal";
import { simulatorTransport } from "@/lib/simulator/transport";

// Record fields whose values must never reach a report, playbook or export.
const RECORD_VALUE_FIELDS = ["firstname", "lastname", "email", "company", "domain"];

// A full scan of the small simulated portal, plus every record value
// HubSpot (the simulator) sent back during it, for privacy checks.
export async function simulatedReport(): Promise<{ report: ScanReport; recordValues: string[] }> {
  const values = new Set<string>();
  const inner = simulatorTransport({ size: SIZE_SMALL, rateLimits: "none" }).transport;
  const transport: Transport = async (request) => {
    const response = await inner(request);
    const body = (await response.clone().json().catch(() => null)) as {
      results?: { properties?: Record<string, string | null> }[];
    } | null;
    for (const row of body?.results ?? []) {
      for (const field of RECORD_VALUE_FIELDS) {
        const value = row.properties?.[field];
        if (value) values.add(value);
      }
    }
    return response;
  };
  const result = await runScan(transport, { config: { ...CHECKS_CONFIG, searchMinIntervalMs: 0 } });
  if (!result.ok) throw new Error(`simulated scan failed: ${result.kind}`);
  return { report: result.report, recordValues: [...values] };
}

export const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
// Phone-shaped text such as "(415) 555-0142" or "+44 20 7946 0958".
export const PHONE_PATTERN = /(\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{3,4}/;
