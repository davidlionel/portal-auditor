import type { Category, Finding } from "@/lib/checks/types";
import type { AccountDetails } from "@/lib/hubspot/client";
import type { ObjectType } from "@/lib/hubspot/properties";
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

const CATEGORY_ORDER: Category[] = ["Properties", "Contacts", "Companies", "Deals"];

// HubSpot's object type IDs, used in record URLs.
const OBJECT_TYPE_IDS: Record<ObjectType, string> = {
  contacts: "0-1",
  companies: "0-2",
  deals: "0-3",
};

function recordUrl(portal: AccountDetails, objectType: ObjectType, id: string): string | null {
  if (!portal.uiDomain) return null;
  return `https://${portal.uiDomain}/contacts/${portal.portalId}/record/${OBJECT_TYPE_IDS[objectType]}/${id}`;
}

function RecordId({ portal, objectType, id }: { portal: AccountDetails; objectType: ObjectType; id: string }) {
  const url = recordUrl(portal, objectType, id);
  if (!url) return <code>{id}</code>;
  return (
    <a className={styles.recordLink} href={url} target="_blank" rel="noreferrer">
      <code>{id}</code>
    </a>
  );
}

function Samples({ finding, portal }: { finding: Finding; portal: AccountDetails }) {
  const groups = finding.recordSamples;
  const shown = groups ? groups.length : finding.samples.length;
  return (
    <details className={styles.samples}>
      <summary>
        {shown < finding.count ? `First ${shown} of ${finding.count}` : `All ${finding.count}`}
      </summary>
      <ul>
        {groups
          ? groups.map((ids) => (
              <li key={ids.join("-")}>
                {ids.map((id, i) => (
                  <span key={id}>
                    {i > 0 && " / "}
                    <RecordId portal={portal} objectType={finding.objectType} id={id} />
                  </span>
                ))}
              </li>
            ))
          : finding.samples.map((s) => (
              <li key={s}>
                <code>{s}</code>
              </li>
            ))}
      </ul>
    </details>
  );
}

export function Report({ report }: { report: ScanReport }) {
  const { portal, findings } = report;
  const scanned = report.scannedObjects.map((o) => OBJECT_LABELS[o]).join(", ") || "none";

  return (
    <section className={styles.report} aria-live="polite">
      <div className={styles.card}>
        <div className={styles.resultHeader}>
          <h2>Health report for portal {portal.portalId}</h2>
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
        <p className={styles.card}>No issues found in the objects scanned.</p>
      ) : (
        CATEGORY_ORDER.filter((c) => findings.some((f) => f.category === c)).map((category) => (
          <section key={category} className={styles.report} aria-label={category}>
            <h2 className={styles.categoryHeading}>{category}</h2>
            {findings
              .filter((f) => f.category === category)
              .map((f) => (
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
                  <Samples finding={f} portal={portal} />
                </article>
              ))}
          </section>
        ))
      )}
    </section>
  );
}
