import { hubspotTransport } from "@/lib/hubspot/client";
import { fullScanEnabled, liveScanEnabled } from "@/lib/live-scan";
import { handleScanRequest } from "@/lib/scan-stream";
import { simulatorEnabled } from "@/lib/simulator/guard";

// A full scan of a large portal takes about two minutes. A full duplicate
// scan takes longer and is only offered where this limit doesn't apply
// (see fullScanEnabled).
export const maxDuration = 300;

// Streams scan progress, then the report, as NDJSON. POST only, so the
// service key travels in the request body and never in a URL.
export async function POST(request: Request) {
  return handleScanRequest(request, {
    liveScanEnabled: () => liveScanEnabled(),
    makeTransport: hubspotTransport,
    simulatorEnabled: () => simulatorEnabled(),
    loadSimulator: async () => {
      const { simulatorTransport } = await import("@/lib/simulator/transport");
      return simulatorTransport({ latency: true, serverErrorRate: 0.0005 }).transport;
    },
    fullScanEnabled: () => fullScanEnabled(),
  });
}
