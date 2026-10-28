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

export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>Portal Health Auditor</h1>
        <p>Scan a HubSpot portal&apos;s properties with a read-only service key.</p>
      </header>

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

      <ConnectForm simulatorAvailable={simulatorEnabled()} />
    </main>
  );
}
