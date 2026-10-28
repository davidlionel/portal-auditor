import Image from "next/image";
import Link from "next/link";
import { liveScanEnabled } from "@/lib/live-scan";
import { simulatorEnabled } from "@/lib/simulator/guard";
import { ConnectForm } from "./connect-form";
import styles from "./page.module.css";

const RUN_LOCALLY_URL = "https://github.com/davidlionel/portal-auditor#run-it-on-your-own-portal";
const SCOPES_URL = "https://github.com/davidlionel/portal-auditor#scopes-to-tick-on-the-service-key";

export default function Home() {
  // Decided on the server: on locally, off on Vercel, so the public demo never
  // receives a service key. This page is static, so it reads the setting at
  // build time; /api/scan checks it again on every request.
  const liveScan = liveScanEnabled();
  const simulator = simulatorEnabled();
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>Portal Health Auditor</h1>
        <p className={styles.pitch}>
          A health check for HubSpot portals: a score out of 100 and the five fixes that matter most.
        </p>
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
        {!liveScan && (
          <p className={`${styles.note} ${styles.exportNote}`}>
            This site shows the sample only and never asks for a service key. To scan your own
            portal, <a className={styles.recordLink} href={RUN_LOCALLY_URL}>run it on your machine</a>;
            it takes a few minutes to set up.
          </p>
        )}
      </section>

      {liveScan && (
        <p className={styles.note}>
          The key needs six read-only scopes:{" "}
          <a className={styles.recordLink} href={SCOPES_URL}>
            see which and why
          </a>
          .
        </p>
      )}
      {(liveScan || simulator) && <ConnectForm liveScan={liveScan} simulatorAvailable={simulator} />}
    </main>
  );
}
