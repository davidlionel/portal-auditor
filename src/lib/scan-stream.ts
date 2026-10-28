import type { Transport } from "./hubspot/client";
import { ERROR_MESSAGES } from "./messages";
import type { ProgressEvent } from "./progress";
import { runScan, type ScanOptions, type ScanReport } from "./scan";

// One line of the scan response stream (NDJSON: one JSON object per line).
export type ScanStreamEvent =
  | ProgressEvent
  | { type: "done"; report: ScanReport }
  | { type: "error"; message: string };

export type ScanStreamDeps = {
  makeTransport: (token: string) => Transport;
  simulatorEnabled: () => boolean;
  // Loaded only after the guard passes.
  loadSimulator: () => Promise<Transport>;
  scanOptions?: Omit<ScanOptions, "onProgress" | "signal" | "simulated">;
};

const HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  // Stops proxies such as nginx holding the stream back.
  "X-Accel-Buffering": "no",
};

const line = (event: ScanStreamEvent) => JSON.stringify(event) + "\n";

function errorResponse(status: number, message: string): Response {
  return new Response(line({ type: "error", message }), { status, headers: HEADERS });
}

// Handles POST /api/scan. The service key arrives in the JSON body, is
// turned into a transport, and is never stored, logged or echoed: after
// this function returns, only the transport's closure holds it, and that
// closure is dropped when the stream ends.
export async function handleScanRequest(request: Request, deps: ScanStreamDeps): Promise<Response> {
  let body: { token?: unknown; mode?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse(400, ERROR_MESSAGES.bad_request);
  }

  const simulated = body?.mode === "simulated";
  let transport: Transport;
  if (simulated) {
    if (!deps.simulatorEnabled()) {
      console.info("[connect] simulated scan refused: simulator disabled");
      return errorResponse(403, "The simulated portal is disabled.");
    }
    transport = await deps.loadSimulator();
  } else {
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    // Local rejections log the reason so it's clear no HubSpot call was made.
    if (!token) {
      console.info("[connect] no HubSpot call: key field was empty");
      return errorResponse(400, ERROR_MESSAGES.empty);
    }
    if (token.length > 512 || /\s/.test(token)) {
      console.info("[connect] no HubSpot call: key failed local format check");
      return errorResponse(400, ERROR_MESSAGES.malformed);
    }
    transport = deps.makeTransport(token);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The browser may have gone; writing then would throw.
      const send = (event: ScanStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(line(event)));
        } catch {}
      };
      try {
        const result = await runScan(transport, {
          ...deps.scanOptions,
          onProgress: send,
          signal: request.signal,
          simulated,
        });
        if (result.ok) send({ type: "done", report: result.report });
        else if (result.kind !== "cancelled") send({ type: "error", message: ERROR_MESSAGES[result.kind] });
        else console.info("[connect] scan cancelled by the browser");
      } catch {
        // Never forward the error itself: it could carry request details.
        send({ type: "error", message: ERROR_MESSAGES.unexpected });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: HEADERS });
}
