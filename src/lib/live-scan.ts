// Scanning a real portal with a pasted service key is on by default, so a
// fresh clone scans with no setup. On Vercel (which sets VERCEL=1 at build
// time and runtime) it is off, so the public demo never receives a key.
// ENABLE_LIVE_SCAN overrides both: "true" turns it on for your own Vercel
// copy, "false" turns it off anywhere.
export function liveScanEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.ENABLE_LIVE_SCAN === "true") return true;
  if (env.ENABLE_LIVE_SCAN === "false") return false;
  return !env.VERCEL;
}

// A full duplicate scan of a large portal runs for half an hour or more, so
// it's only offered where a request can run that long: not on Vercel, whose
// functions stop after a few minutes (the scan route asks for 300 seconds).
export function fullScanEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !env.VERCEL;
}
