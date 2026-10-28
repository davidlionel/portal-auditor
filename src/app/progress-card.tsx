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

export function ProgressCard({
  progress,
  simulated,
  elapsedMs,
  onCancel,
}: {
  progress?: ProgressEvent;
  simulated: boolean;
  elapsedMs: number;
  onCancel: () => void;
}) {
  const percent = progress?.percent ?? 0;
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
      </p>
    </section>
  );
}
