import type { Metadata } from "next";
import Link from "next/link";
// Bundled into the page at build time, so the sample is static HTML and no
// request ever touches HubSpot. Written by `npm run demo:snapshot`.
import snapshot from "@/demo/snapshot.json";
import { prepareDemo } from "@/lib/demo/load";
import { Report } from "../report";
import styles from "../page.module.css";

export const metadata: Metadata = {
  title: "Sample report · Portal Health Auditor",
  description: "A health report from a HubSpot developer test portal: score, top fixes and every finding.",
};

export default function DemoPage() {
  const demo = prepareDemo(snapshot);
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <p className={styles.note}>
          <Link className={styles.recordLink} href="/">
            Portal Health Auditor
          </Link>
        </p>
        <h1>Sample report</h1>
        <p>What the auditor finds in a HubSpot portal with planted data problems.</p>
      </header>
      {demo.ok ? (
        <Report report={demo.report} demo={{ scannedAt: demo.scannedAt }} />
      ) : (
        <p role="alert" className={styles.error}>
          {demo.reason}
        </p>
      )}
    </main>
  );
}
