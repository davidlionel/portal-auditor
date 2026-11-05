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
  // Whether this deployment accepts real service keys at all.
  liveScanEnabled: () => boolean;
  makeTransport: (token: string) => Transport;
  simulatorEnabled: () => boolean;
  // Loaded only after the guard passes.
  loadSimulator: () => Promise<Transport>;
  // Whether a full duplicate scan may run here: not on a host that cuts
  // requests off after a few minutes.
  fullScanEnabled: () => boolean;
  scanOptions?: Omit<ScanOptions, "onProgress" | "signal" | "simulated">;
};

const HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  // Stops proxies such as nginx holding the stream back.
  "X-Accel-Buffering": "no",
};

const line = (event: ScanStreamEvent) => JSON.stringify(event) + "\n";

// A long scan resends its latest progress at least this often, through
// long retry waits and matching, so the browser always sees it's alive.
export const HEARTBEAT_MS = 5_000;

function errorResponse(status: number, message: string): Response {
  return new Response(line({ type: "error", message }), { status, headers: HEADERS });
}

export type ScanRequestBody = { token?: unknown; mode?: unknown; fullDuplicates?: unknown };

// Reads the request body and turns its key (or the simulator) into a
// transport, refusing what this deployment doesn't allow. Shared by the
// scan and its estimate. The key is never stored, logged or echoed.
export async function openTransport(
  request: Request,
  deps: ScanStreamDeps,
  respond: (status: number, message: string) => Response,
): Promise<{ body: ScanRequestBody; transport: Transport; simulated: boolean } | Response> {
  let body: ScanRequestBody;
  try {
    body = (await request.json()) as ScanRequestBody;
  } catch {
    return respond(400, ERROR_MESSAGES.bad_request);
  }
  if (body?.fullDuplicates === true && !deps.fullScanEnabled()) {
    console.info("[connect] full duplicate scan refused: not available on this host");
    return respond(403, ERROR_MESSAGES.full_scan_off);
  }

  const simulated = body?.mode === "simulated";
  if (simulated) {
    if (!deps.simulatorEnabled()) {
      console.info("[connect] simulated scan refused: simulator disabled");
      return respond(403, "The simulated portal is disabled.");
    }
    return { body, transport: await deps.loadSimulator(), simulated };
  }
  // Refused before the key is even read, so a demo deployment never
  // handles one.
  if (!deps.liveScanEnabled()) {
    console.info("[connect] live scan refused: live scanning is turned off");
    return respond(403, ERROR_MESSAGES.live_scan_off);
  }
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  // Local rejections log the reason so it's clear no HubSpot call was made.
  if (!token) {
    console.info("[connect] no HubSpot call: key field was empty");
    return respond(400, ERROR_MESSAGES.empty);
  }
  if (token.length > 512 || /\s/.test(token)) {
    console.info("[connect] no HubSpot call: key failed local format check");
    return respond(400, ERROR_MESSAGES.malformed);
  }
  return { body, transport: deps.makeTransport(token), simulated };
}

// Handles POST /api/scan. The service key arrives in the JSON body, is
// turned into a transport, and is never stored, logged or echoed: after
// this function returns, only the transport's closure holds it, and that
// closure is dropped when the stream ends.
export async function handleScanRequest(request: Request, deps: ScanStreamDeps): Promise<Response> {
  const opened = await openTransport(request, deps, errorResponse);
  if (opened instanceof Response) return opened;
  const { transport, simulated } = opened;
  const fullDuplicates = opened.body.fullDuplicates === true;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The browser may have gone; writing then would throw.
      let lastSent = Date.now();
      let lastProgress: ProgressEvent | null = null;
      const send = (event: ScanStreamEvent) => {
        lastSent = Date.now();
        if (event.type === "progress") lastProgress = event;
        try {
          controller.enqueue(encoder.encode(line(event)));
        } catch {}
      };
      const heartbeat = setInterval(() => {
        if (lastProgress && Date.now() - lastSent >= HEARTBEAT_MS) send(lastProgress);
      }, 1_000);
      try {
        const result = await runScan(transport, {
          ...deps.scanOptions,
          onProgress: send,
          signal: request.signal,
          simulated,
          fullDuplicates,
        });
        if (result.ok) send({ type: "done", report: result.report });
        else if (result.kind !== "cancelled") send({ type: "error", message: ERROR_MESSAGES[result.kind] });
        else console.info("[connect] scan cancelled by the browser");
      } catch {
        // Never forward the error itself: it could carry request details.
        send({ type: "error", message: ERROR_MESSAGES.unexpected });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: HEADERS });
}
