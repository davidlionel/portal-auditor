import styles from "./page.module.css";

// What the scan covers and what it doesn't: below the key form card or the
// sample report card on the home page, and under the heading on /demo.
export function ScopeSummary() {
  return (
    <div className={styles.scope}>
      <p>
        <strong>Checks:</strong> duplicates, missing or messy data on contacts, companies and deals, stale deals,
        cluttered properties, and segments (lists) that are empty, near-duplicates or filter on missing properties.
      </p>
      <p>
        <strong>Doesn&apos;t check:</strong> workflows, or how your team uses HubSpot day to day. It only reads your
        portal and never changes anything.
      </p>
    </div>
  );
}
