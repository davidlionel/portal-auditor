import { CATEGORY_ORDER, checkKey, type Finding } from "@/lib/checks/types";
import type { AccountDetails } from "@/lib/hubspot/client";
import { recordUrl } from "@/lib/hubspot/links";
import type { ObjectType } from "@/lib/hubspot/properties";
import type { ScanReport } from "@/lib/scan";
import { checkRate, topFixes } from "@/lib/scoring";
import { ExportButtons } from "./export-buttons";
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

function RecordId({ portal, objectType, id }: { portal: AccountDetails; objectType: ObjectType; id: string }) {
  const url = recordUrl(portal, objectType, id);
  if (!url) return <code>{id}</code>;
  return (
    <a className={styles.recordLink} href={url} target="_blank" rel="noreferrer">
      <code>{id}</code>
    </a>
  );
}

const findingAnchor = (f: Finding) => `finding-${checkKey(f).replace(/[.:]/g, "-")}`;

const pct = (rate: number) => `${+(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;

const points = (n: number) => `+${n.toFixed(1)} pts`;

// "3 of 41 checked (7.3%)": the numbers behind a finding's score.
const rateText = (f: Finding) =>
  `${f.affected.toLocaleString("en-US")} of ${f.population.toLocaleString("en-US")} checked (${pct(checkRate(f))})`;

function scoreClass(score: number) {
  if (score >= 80) return styles.scoreGood;
  if (score >= 50) return styles.scoreFair;
  return styles.scorePoor;
}

function ScoreCard({ report }: { report: ScanReport }) {
  const { score, checks } = report;
  const skipped = checks.filter((c) => c.status === "skipped");
  const scored = checks.filter((c) => c.status === "scored").length;

  return (
    <div className={styles.card}>
      <div className={styles.resultHeader}>
        <h2>Health report for portal {report.portal.portalId}</h2>
        <span className={styles.badge}>
          {ACCOUNT_TYPE_LABELS[report.portal.accountType] ?? report.portal.accountType}
        </span>
      </div>
      <div className={styles.scoreHeader}>
        {score.overall === null ? (
          <span className={styles.scoreValue}>Not scored</span>
        ) : (
          <span className={`${styles.scoreValue} ${scoreClass(score.overall)}`}>
            {Math.round(score.overall)}
          </span>
        )}
        {score.overall !== null && <span className={styles.note}>out of 100</span>}
      </div>
      <p className={styles.note}>
        {scored} checks scored{skipped.length ? `, ${skipped.length} skipped and not scored` : ""}.
      </p>

      <div className={styles.categoryGrid}>
        {score.categories.map((c) => (
          <div key={c.category} className={styles.categoryTile}>
            <span className={styles.note}>{c.category}</span>
            <span className={`${styles.categoryScore} ${c.score === null ? "" : scoreClass(c.score)}`}>
              {c.score === null ? "Not scored" : Math.round(c.score)}
            </span>
            <span className={styles.note}>
              {c.scored} scored{c.skipped ? ` · ${c.skipped} skipped` : ""}
            </span>
          </div>
        ))}
      </div>

      <p className={`${styles.note} ${styles.explanation}`}>{score.explanation}</p>
      <ul className={styles.notes}>
        <li>Automation (lists and workflows) isn&apos;t checked yet, so it isn&apos;t part of the score.</li>
        {skipped.map((c) => (
          <li key={`${c.checkId}-${c.objectType}`}>
            Not scored: {c.title}
            {c.category === "Properties" ? ` (${OBJECT_LABELS[c.objectType].toLowerCase()})` : ""}. {c.reason}.
          </li>
        ))}
      </ul>
    </div>
  );
}

function TopFixes({ report }: { report: ScanReport }) {
  const fixes = topFixes(report.findings, report.score);
  if (!fixes.length) return null;
  return (
    <div className={styles.card}>
      <h2>Top {fixes.length} fixes</h2>
      <ol className={styles.topFixes}>
        {fixes.map(({ finding: f, points: gain }) => (
          <li key={checkKey(f)}>
            <span className={styles.points}>{points(gain)}</span>
            <a className={styles.recordLink} href={`#${findingAnchor(f)}`}>
              {f.title}
            </a>
            <p className={styles.note}>
              {f.category === "Properties" ? `${OBJECT_LABELS[f.objectType]} properties` : f.category} ·{" "}
              {f.severity} · {rateText(f)}
            </p>
          </li>
        ))}
      </ol>
      <p className={`${styles.note} ${styles.explanation}`}>
        Ranked by how much the overall score would rise if that problem were fixed.
      </p>
    </div>
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
      <ScoreCard report={report} />
      <TopFixes report={report} />
      <ExportButtons report={report} />

      <div className={styles.card}>
        <h2>Scan details</h2>
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
                <article key={checkKey(f)} id={findingAnchor(f)} className={styles.card}>
                  <div className={styles.findingHeader}>
                    <span className={`${styles.severity} ${styles[f.severity]}`}>{f.severity}</span>
                    <h3>{f.title}</h3>
                  </div>
                  <p className={styles.note}>
                    {OBJECT_LABELS[f.objectType]} · {f.count.toLocaleString("en-US")} {f.records?.some((r) => r.group) ? "duplicate groups" : "found"} ·{" "}
                    {rateText(f)}
                    {report.score.pointsRecovered[checkKey(f)] ? ` · fixing it: ${points(report.score.pointsRecovered[checkKey(f)])}` : ""}
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
