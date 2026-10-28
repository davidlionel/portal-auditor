import Image from "next/image";
import Link from "next/link";
import { liveScanEnabled } from "@/lib/live-scan";
import { simulatorEnabled } from "@/lib/simulator/guard";
import { ConnectForm } from "./connect-form";
import styles from "./page.module.css";

const RUN_LOCALLY_URL = "https://github.com/davidlionel/portal-auditor#run-it-on-your-own-portal";
const PITCH = "A health check for HubSpot portals: a score out of 100 and the five fixes that matter most.";

// Same scopes as the README's "Scopes to tick on the service key".
const SCOPES = [
  {
    names: ["crm.schemas.contacts.read", "crm.schemas.companies.read", "crm.schemas.deals.read"],
    why: "Read property definitions (labels, descriptions, dropdown options) for the property checks.",
  },
  {
    names: ["crm.objects.contacts.read", "crm.objects.companies.read", "crm.objects.deals.read"],
    why: "Count records for fill rates and record checks, and read name, company, email and domain on recent records for the duplicate and email checks.",
  },
];

function ScopesHelp() {
  return (
    <details className={styles.samples}>
      <summary>Which scopes does my key need?</summary>
      <p className={`${styles.note} ${styles.scopesIntro}`}>
        Create the key in HubSpot under <strong>Development &gt; Keys &gt; Service keys</strong> and
        tick these six read-only scopes. If one is missing, the scan skips that check and says so.
      </p>
      <ul className={styles.scopes}>
        {SCOPES.map((scope) => (
          <li key={scope.names[0]}>
            {scope.names.map((name) => (
              <code key={name} className={styles.scopeName}>
                {name}
              </code>
            ))}
            <span className={styles.note}>{scope.why}</span>
          </li>
        ))}
        <li>
          <span className={styles.scopeName}>No scope needed</span>
          <span className={styles.note}>Account details, to confirm which portal is connected.</span>
        </li>
      </ul>
    </details>
  );
}

export default function Home() {
  // Decided on the server: on locally, off on Vercel, so the public demo never
  // receives a service key. This page is static, so it reads the setting at
  // build time; /api/scan checks it again on every request.
  const liveScan = liveScanEnabled();
  const simulator = simulatorEnabled();

  if (liveScan) {
    return (
      <main className={styles.main}>
        <header className={styles.header}>
          <h1>Portal Health Auditor</h1>
          <p className={styles.pitch}>{PITCH}</p>
        </header>
        <ConnectForm liveScan simulatorAvailable={simulator}>
          <ScopesHelp />
          <p className={styles.note}>
            <Link className={styles.recordLink} href="/demo">
              See a sample report
            </Link>
          </p>
        </ConnectForm>
      </main>
    );
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>Portal Health Auditor</h1>
        <p className={styles.pitch}>{PITCH}</p>
      </header>

      <section className={styles.card}>
        <ul className={styles.pitchList}>
          <li>
            <strong>What it checks:</strong> duplicate contacts and company domains, missing
            lifecycle stages, emails, amounts and close dates, stale deals, and messy custom
            properties.
          </li>
          <li>
            <strong>Read-only by design:</strong> six read-only HubSpot scopes, and the report
            shows record IDs, never names or emails.
          </li>
          <li>
            <strong>Tested at scale:</strong> against a simulated 250,000-contact portal (454 API
            calls in about 2½ minutes); not yet run on a real portal that size.
          </li>
        </ul>

        <Link href="/demo" className={styles.screenshotLink} aria-label="Open the sample report">
          <Image
            src="/report-screenshot.png"
            width={1920}
            height={911}
            sizes="(max-width: 720px) 100vw, 688px"
            fetchPriority="high"
            className={styles.screenshot}
            alt="Sample report: a health score of 56 out of 100, scores for properties, contacts, companies and deals, and the top 5 fixes"
          />
        </Link>

        <div className={styles.row}>
          <Link className={styles.button} href="/demo">
            View sample report
          </Link>
        </div>
        <p className={`${styles.note} ${styles.exportNote}`}>
          This site shows the sample only and never asks for a service key. To scan your own
          portal, <a className={styles.recordLink} href={RUN_LOCALLY_URL}>run it on your machine</a>;
          it takes a few minutes to set up.
        </p>
      </section>

      {simulator && <ConnectForm liveScan={false} simulatorAvailable />}
    </main>
  );
}
