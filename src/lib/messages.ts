import { RETRY_CONFIG } from "@/config/requests";
import type { HubSpotErrorKind } from "./hubspot/client";
import type { LimitKind } from "./scan";

// "5 retries (about 25 seconds)", from the retry settings.
function retriesText(): string {
  const { maxRetries, baseDelayMs, maxDelayMs } = RETRY_CONFIG;
  let ms = 0;
  for (let i = 0; i < maxRetries; i++) ms += Math.min(maxDelayMs, baseDelayMs * 2 ** i);
  return `${maxRetries} retries (about ${Math.round(ms / 1000)} seconds)`;
}

// What the user sees when a scan can't start or can't finish.
export const ERROR_MESSAGES: Record<
  HubSpotErrorKind | "empty" | "malformed" | "bad_request" | "live_scan_off",
  string
> = {
  live_scan_off:
    "This site shows a sample report only and doesn't accept service keys. To scan your own portal, run the app locally (see the README).",
  empty: "Paste a HubSpot service key to connect.",
  malformed: "That doesn't look like a service key. Copy it again from Development > Keys > Service keys.",
  bad_request: "The scan request was malformed. Reload the page and try again.",
  invalid_token: "HubSpot rejected that service key. It may be wrong, revoked, or expired after rotation.",
  missing_scope: "The service key is valid but lacks permission for this call. Check the key's scopes.",
  rate_limited: `HubSpot kept rate-limiting this portal after ${retriesText()}. Another app may be using the same allowance. Wait a minute and scan again.`,
  daily_limit:
    "This portal has used its daily HubSpot API allowance. It resets at midnight in the portal's time zone.",
  hubspot_unavailable: "Couldn't reach HubSpot. Try again in a moment.",
  cancelled: "Scan cancelled.",
  unexpected: "HubSpot returned something unexpected. Try again.",
};

// The banner on a report that HubSpot's rate limit cut short.
export function limitMessage(kind: LimitKind, timeZone: string): string {
  return kind === "daily_limit"
    ? `This portal used up its daily HubSpot API allowance partway through the scan. It resets at midnight ${timeZone ? `${timeZone} time` : "in the portal's time zone"}; scan again after that for a complete report.`
    : `HubSpot kept rate-limiting this portal after ${retriesText()}, so the scan stopped making calls. Another app may be using the same allowance. Wait a minute and scan again for a complete report.`;
}
