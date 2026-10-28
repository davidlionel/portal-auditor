// Live scan progress, sent to the browser while the scan runs.
export type ProgressEvent = {
  type: "progress";
  // What the scan is doing, e.g. "Measuring contact fill rates".
  phase: string;
  // Where it is within the phase, e.g. "120 of 200".
  detail?: string;
  // 0–100. Never goes backwards; 100 only when the scan is done.
  percent: number;
  apiCalls: number;
  retries: number;
  // Set while waiting out a HubSpot rate limit.
  waitingMs?: number;
  simulated: boolean;
};

export type ProgressOptions = {
  emit: (event: ProgressEvent) => void;
  // Calls made so far, retries included, and retries alone.
  counts: () => { calls: number; retries: number };
  simulated: boolean;
  // Routine updates are sent at most this often; phase changes and
  // rate-limit waits go out at once.
  minIntervalMs?: number;
  now?: () => number;
};

// The share of the bar given to the setup step (account, property lists,
// record totals), before the scan knows how many calls the checks need.
const SETUP_SHARE = 5;

// Percent = calls done ÷ calls planned. Setup fills the first 5% of the bar;
// once setup has counted the checks' calls (beginChecks), they fill the rest.
// Pages a search turns out to need are added to the plan as they're found.
export function createProgress(options: ProgressOptions) {
  const { emit, counts, simulated, minIntervalMs = 250, now = Date.now } = options;
  let setupPlanned = 0;
  let checksPlanned = 0;
  // Calls done when the checks began; null during setup.
  let checksFrom: number | null = null;
  let shown = 0;
  let phase = "Starting";
  let detail: string | undefined;
  let lastSent = -Infinity;

  function percent(): number {
    const { calls, retries } = counts();
    // Retries are extra attempts at planned calls, not progress.
    const done = calls - retries;
    const raw =
      checksFrom === null
        ? setupPlanned > 0
          ? Math.min(SETUP_SHARE, Math.floor((done / setupPlanned) * SETUP_SHARE))
          : 0
        : checksPlanned > 0
          ? SETUP_SHARE + Math.floor(((done - checksFrom) / checksPlanned) * (99 - SETUP_SHARE))
          : 99;
    // Held below 100 until finish(), and never allowed to go backwards.
    shown = Math.max(shown, Math.min(99, raw));
    return shown;
  }

  function send(extra: Partial<ProgressEvent> = {}, force = false) {
    const t = now();
    if (!force && t - lastSent < minIntervalMs) return;
    lastSent = t;
    const { calls, retries } = counts();
    emit({ type: "progress", phase, detail, percent: percent(), apiCalls: calls, retries, simulated, ...extra });
  }

  return {
    // More calls are now expected: setup calls before beginChecks, check
    // calls (such as extra search pages) after.
    plan(calls: number) {
      if (checksFrom === null) setupPlanned += Math.max(0, calls);
      else checksPlanned += Math.max(0, calls);
    },
    // Setup is done and has counted the checks' calls.
    beginChecks(calls: number) {
      const { calls: made, retries } = counts();
      checksFrom = made - retries;
      checksPlanned += Math.max(0, calls);
    },
    phase(name: string, newDetail?: string) {
      phase = name;
      detail = newDetail;
      send({}, true);
    },
    detail(newDetail: string) {
      detail = newDetail;
      send();
    },
    // After each HubSpot call.
    tick() {
      send();
    },
    waiting(delayMs: number, retry: number, maxRetries: number) {
      send(
        { detail: `HubSpot rate limit: retrying in ${Math.ceil(delayMs / 1000)}s (${retry} of ${maxRetries})`, waitingMs: delayMs },
        true,
      );
    },
    finish(name = "Done") {
      phase = name;
      detail = undefined;
      shown = 100;
      const { calls, retries } = counts();
      lastSent = now();
      emit({ type: "progress", phase, percent: 100, apiCalls: calls, retries, simulated });
    },
  };
}

export type Progress = ReturnType<typeof createProgress>;

// A progress sink that does nothing, for callers that don't stream.
export const silentProgress = (): Progress =>
  createProgress({ emit: () => {}, counts: () => ({ calls: 0, retries: 0 }), simulated: false });
