import { hubspotTransport } from "@/lib/hubspot/client";
import { fullScanEnabled, liveScanEnabled } from "@/lib/live-scan";
import { handleEstimateRequest } from "@/lib/scan-estimate";
import { simulatorEnabled } from "@/lib/simulator/guard";

// Before a full duplicate scan: what it would cost for this portal. POST
// only, so the service key travels in the request body and never in a URL.
export async function POST(request: Request) {
  return handleEstimateRequest(request, {
    liveScanEnabled: () => liveScanEnabled(),
    makeTransport: hubspotTransport,
    simulatorEnabled: () => simulatorEnabled(),
    loadSimulator: async () => {
      const { simulatorTransport } = await import("@/lib/simulator/transport");
      return simulatorTransport({ latency: true }).transport;
    },
    fullScanEnabled: () => fullScanEnabled(),
  });
}
