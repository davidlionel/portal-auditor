import styles from "./page.module.css";

// What the scan covers and what it doesn't: under the key form or the sample
// report button on the home page, and under the heading on /demo.
export function ScopeSummary() {
  return (
    <div className={styles.scope}>
      <p>
        <strong>Checks:</strong> duplicates, missing or messy data on contacts, companies and deals, stale deals, and
        cluttered properties.
      </p>
      <p>
        <strong>Doesn&apos;t check:</strong> workflows, lists, or how your team uses HubSpot day to day. It only reads your
        portal and never changes anything.
      </p>
    </div>
  );
}
