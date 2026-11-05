import type { ProgressEvent } from "@/lib/progress";
import styles from "./page.module.css";

export function SimulatedBanner() {
  return (
    <p className={styles.simulatedBanner} role="note">
      <strong>SIMULATED PORTAL</strong> Fake data from the dev simulator. No HubSpot calls were made.
    </p>
  );
}

const elapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Time left at the pace so far, once there's enough to go on.
function timeLeft(percent: number, elapsedMs: number): string | null {
  if (elapsedMs < 30_000 || percent < 5 || percent >= 99) return null;
  const minutes = Math.round((elapsedMs * (100 - percent)) / percent / 60_000);
  return minutes < 1 ? "under a minute left" : `about ${minutes} min left`;
}

export function ProgressCard({
  progress,
  simulated,
  elapsedMs,
  full = false,
  wakeLock = null,
  onCancel,
}: {
  progress?: ProgressEvent;
  simulated: boolean;
  elapsedMs: number;
  // A full duplicate scan, and whether the screen wake lock is holding.
  full?: boolean;
  wakeLock?: "held" | "unavailable" | null;
  onCancel: () => void;
}) {
  const percent = progress?.percent ?? 0;
  const left = timeLeft(percent, elapsedMs);
  return (
    <section className={styles.card} aria-label="Scan progress">
      {simulated && <SimulatedBanner />}
      <div className={styles.resultHeader}>
        <h2>Scanning… {percent}%</h2>
        <button type="button" className={styles.secondaryButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <progress className={styles.progressBar} max={100} value={percent} aria-label="Scan progress">
        {percent}%
      </progress>
      <p className={styles.progressPhase} aria-live="polite">
        {progress?.phase ?? "Starting"}
        {progress?.detail ? ` · ${progress.detail}` : ""}
      </p>
      <p className={styles.note}>
        API calls: {progress?.apiCalls ?? 0}
        {progress?.retries ? ` (${progress.retries} ${progress.retries === 1 ? "retry" : "retries"})` : ""} ·
        Elapsed {elapsed(elapsedMs)}
        {left ? ` · ${left}` : ""}
      </p>
      {full && (
        <p className={styles.note}>
          Full duplicate scan: keep this tab open.{" "}
          {wakeLock === "held"
            ? "The screen is kept awake while it runs."
            : wakeLock === "unavailable"
              ? "This browser can't keep the computer awake, so stop it from sleeping until the scan finishes."
              : ""}
        </p>
      )}
    </section>
  );
}
