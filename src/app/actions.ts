"use server";

import type { HubSpotErrorKind } from "@/lib/hubspot/client";
import { runScan as runPortalScan, type ScanReport } from "@/lib/scan";

export type ScanState =
  | { status: "idle" }
  | { status: "done"; report: ScanReport }
  | { status: "error"; message: string };

const ERROR_MESSAGES: Record<HubSpotErrorKind | "empty" | "malformed", string> = {
  empty: "Paste a HubSpot service key to connect.",
  malformed: "That doesn't look like a service key. Copy it again from Development > Keys > Service keys.",
  invalid_token: "HubSpot rejected that service key. It may be wrong, revoked, or expired after rotation.",
  missing_scope: "The service key is valid but lacks permission for this call. Check the key's scopes.",
  rate_limited: "HubSpot is rate-limiting this portal right now. Wait a few seconds and try again.",
  hubspot_unavailable: "Couldn't reach HubSpot. Try again in a moment.",
  unexpected: "HubSpot returned something unexpected. Try again.",
};

// The token lives only in this function's scope for the duration of the
// request. It is never stored, logged, or returned to the browser.
export async function runScan(_prev: ScanState, formData: FormData): Promise<ScanState> {
  const raw = formData.get("token");
  const token = typeof raw === "string" ? raw.trim() : "";

  // Local rejections log the reason so it's clear no HubSpot call was made.
  if (!token) {
    console.info("[connect] no HubSpot call: key field was empty");
    return { status: "error", message: ERROR_MESSAGES.empty };
  }
  if (token.length > 512 || /\s/.test(token)) {
    console.info("[connect] no HubSpot call: key failed local format check");
    return { status: "error", message: ERROR_MESSAGES.malformed };
  }

  const result = await runPortalScan(token);
  if (!result.ok) return { status: "error", message: ERROR_MESSAGES[result.kind] };

  return { status: "done", report: result.report };
}
