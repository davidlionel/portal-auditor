import { hubspotTransport } from "@/lib/hubspot/client";
import { liveScanEnabled } from "@/lib/live-scan";
import { handleScanRequest } from "@/lib/scan-stream";
import { simulatorEnabled } from "@/lib/simulator/guard";

// A full scan of a large portal takes about two minutes.
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
      return simulatorTransport({ latency: true }).transport;
    },
  });
}
