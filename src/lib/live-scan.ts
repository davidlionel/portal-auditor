// Scanning a real portal with a pasted service key is off unless
// ENABLE_LIVE_SCAN=true. The deployed demo leaves it unset, so no key ever
// reaches it; running locally, it goes in .env.local.
export function liveScanEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ENABLE_LIVE_SCAN === "true";
}
