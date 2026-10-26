import type { ScanReport } from "@/lib/scan";
import styles from "./page.module.css";

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  DEVELOPER_TEST: "Developer test portal",
  SANDBOX: "Sandbox",
  STANDARD: "Standard portal",
  APP_DEVELOPER: "App developer account",
};

const OBJECT_LABELS: Record<string, string> = {
  contacts: "Contacts",
  companies: "Companies",
  deals: "Deals",
};

export function Report({ report }: { report: ScanReport }) {
  const { portal, findings } = report;
  const scanned = report.scannedObjects.map((o) => OBJECT_LABELS[o]).join(", ") || "none";

  return (
    <section className={styles.report} aria-live="polite">
      <div className={styles.card}>
        <div className={styles.resultHeader}>
          <h2>Properties report for portal {portal.portalId}</h2>
          <span className={styles.badge}>
            {ACCOUNT_TYPE_LABELS[portal.accountType] ?? portal.accountType}
          </span>
        </div>
        <dl className={styles.details}>
          <dt>Objects scanned</dt>
          <dd>{scanned}</dd>
          <dt>Findings</dt>
          <dd>{findings.length}</dd>
          <dt>API calls</dt>
          <dd>{report.apiCalls}</dd>
          <dt>Scan time</dt>
          <dd>{(report.durationMs / 1000).toFixed(1)}s</dd>
          <dt>Data center</dt>
          <dd>{portal.dataHostingLocation || "—"}</dd>
        </dl>
        <ul className={styles.notes}>
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          <li>
            Sensitive and highly sensitive properties are excluded by default. HubSpot&apos;s
            properties API only returns them when asked, and this key has no sensitive-data
            scopes.
          </li>
        </ul>
      </div>

      {findings.length === 0 ? (
        <p className={styles.card}>No property issues found in the objects scanned.</p>
      ) : (
        findings.map((f) => (
          <article key={`${f.checkId}-${f.objectType}`} className={styles.card}>
            <div className={styles.findingHeader}>
              <span className={`${styles.severity} ${styles[f.severity]}`}>{f.severity}</span>
              <h3>{f.title}</h3>
            </div>
            <p className={styles.note}>
              {OBJECT_LABELS[f.objectType]} · {f.count} found
            </p>
            <p className={styles.findingText}>
              <strong>Why it matters:</strong> {f.why}
            </p>
            <p className={styles.findingText}>
              <strong>How to fix:</strong> {f.fix}
            </p>
            <details className={styles.samples}>
              <summary>
                {f.samples.length < f.count
                  ? `First ${f.samples.length} of ${f.count}`
                  : `All ${f.count}`}
              </summary>
              <ul>
                {f.samples.map((s) => (
                  <li key={s}>
                    <code>{s}</code>
                  </li>
                ))}
              </ul>
            </details>
          </article>
        ))
      )}
    </section>
  );
}
