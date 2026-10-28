import Link from "next/link";
import { liveScanEnabled } from "@/lib/live-scan";
import { simulatorEnabled } from "@/lib/simulator/guard";
import { ConnectForm } from "./connect-form";
import styles from "./page.module.css";

const SCOPES = [
  {
    scopes: ["crm.schemas.contacts.read", "crm.schemas.companies.read", "crm.schemas.deals.read"],
    why: "List property definitions: labels, descriptions and dropdown options.",
  },
  {
    scopes: ["crm.objects.contacts.read", "crm.objects.companies.read", "crm.objects.deals.read"],
    why: "Count records for fill rates and record checks, and read name, company, email and domain on recent records to find duplicates. Values stay in server memory during the scan; the report shows record IDs only.",
  },
];

const RUN_LOCALLY_URL = "https://github.com/davidlionel/portal-auditor#run-it-on-your-own-portal";

export default function Home() {
  // Decided on the server. The public deployment leaves live scanning off,
  // so it never receives a service key. This page is static, so it reads the
  // setting at build time; /api/scan checks it again on every request.
  const liveScan = liveScanEnabled();
  const simulator = simulatorEnabled();
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>Portal Health Auditor</h1>
        <p>
          Scores a HubSpot portal&apos;s data health out of 100 with a read-only service key, and
          ranks the fixes that matter most.
        </p>
      </header>

      <section className={styles.card}>
        <h2>{liveScan ? "See an example first" : "See what it finds"}</h2>
        <p className={styles.note} style={{ marginBottom: 12 }}>
          A full report from a HubSpot developer test portal with planted problems: duplicates,
          missing data, stale deals and messy properties.
        </p>
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

      <section className={styles.card}>
        <h2>What your service key needs and why</h2>
        <p className={styles.note} style={{ marginBottom: 12 }}>
          Create a service key in HubSpot under Development &gt; Keys &gt; Service keys and tick
          only these read-only scopes. If one is missing, the scan skips that part and says so.
        </p>
        <table className={styles.scopeTable}>
          <thead>
            <tr>
              <th scope="col">Scopes</th>
              <th scope="col">Why</th>
            </tr>
          </thead>
          <tbody>
            {SCOPES.map((row) => (
              <tr key={row.scopes[0]}>
                <td>
                  {row.scopes.map((s) => (
                    <div key={s}>
                      <code>{s}</code>
                    </div>
                  ))}
                </td>
                <td>{row.why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {(liveScan || simulator) && <ConnectForm liveScan={liveScan} simulatorAvailable={simulator} />}
    </main>
  );
}
