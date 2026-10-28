"use client";

import { findingsCsv, workListCsv, workListObjects } from "@/lib/csv";
import type { ScanReport } from "@/lib/scan";
import styles from "./page.module.css";

const OBJECT_LABELS = { contacts: "Contacts", companies: "Companies", deals: "Deals" };

// Builds the file in the browser from the report already on the page, so
// nothing is sent to or stored on the server.
function download(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function ExportButtons({ report }: { report: ScanReport }) {
  const prefix = `portal-${report.portal.portalId}`;
  return (
    <div className={styles.card}>
      <h2>Export</h2>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => download(`${prefix}-findings.csv`, findingsCsv(report))}
        >
          Findings summary (CSV)
        </button>
        {workListObjects(report).map((objectType) => (
          <button
            key={objectType}
            type="button"
            className={styles.secondaryButton}
            onClick={() => download(`${prefix}-work-list-${objectType}.csv`, workListCsv(report, objectType))}
          >
            Work list: {OBJECT_LABELS[objectType]} (CSV)
          </button>
        ))}
      </div>
      <p className={`${styles.note} ${styles.exportNote}`}>
        Files are built in your browser from this report; nothing is stored. Work lists hold
        record IDs and HubSpot links only, one file per object, ready to import by Record ID.
      </p>
    </div>
  );
}
