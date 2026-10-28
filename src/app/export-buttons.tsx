"use client";

import { useState } from "react";
import {
  findingsCsv,
  findingsFileName,
  playbookFileName,
  workListCsv,
  workListFileName,
  workListObjects,
  zipFileName,
} from "@/lib/csv";
import type { ScanReport } from "@/lib/scan";
import styles from "./page.module.css";

const OBJECT_LABELS = { contacts: "Contacts", companies: "Companies", deals: "Deals" };

// Builds the file in the browser from the report already on the page, so
// nothing is sent to or stored on the server.
function download(filename: string, data: string | Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Released a moment later so large files finish handing off to the browser.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CSV = "text/csv;charset=utf-8";

// `sample` marks the public sample report: its work lists leave the link
// column blank, since the links would only lead to a HubSpot login, and the
// note says so. Real scans never show that sentence.
export function ExportButtons({ report, sample = false }: { report: ScanReport; sample?: boolean }) {
  const recordLinks = !sample;
  const [busy, setBusy] = useState<"pdf" | "zip" | null>(null);
  const [failed, setFailed] = useState(false);

  // The playbook code (and pdfmake, about 2 MB) loads on first click.
  async function makeFile(kind: "pdf" | "zip") {
    setBusy(kind);
    setFailed(false);
    try {
      if (kind === "pdf") {
        const [{ buildPlaybook }, { renderPlaybookPdf }] = await Promise.all([
          import("@/lib/playbook/build"),
          import("@/lib/playbook/pdf"),
        ]);
        download(playbookFileName(report), await renderPlaybookPdf(buildPlaybook(report, { sample })), "application/pdf");
      } else {
        const { buildZip } = await import("@/lib/playbook/zip");
        download(zipFileName(report), await buildZip(report, { sample }), "application/zip");
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.card}>
      <h2>Export</h2>
      <div className={styles.row}>
        <button type="button" className={styles.button} disabled={busy !== null} onClick={() => void makeFile("pdf")}>
          {busy === "pdf" ? "Preparing playbook…" : "Download playbook (PDF)"}
        </button>
        <button type="button" className={styles.button} disabled={busy !== null} onClick={() => void makeFile("zip")}>
          {busy === "zip" ? "Preparing ZIP…" : "Download everything (ZIP)"}
        </button>
      </div>
      <p className={`${styles.note} ${styles.exportNote}`}>
        The playbook walks through each fix in HubSpot, biggest score gain first. The ZIP holds the
        playbook and every CSV, including the import files the playbook refers to.
      </p>
      {failed && (
        <p role="alert" className={`${styles.error} ${styles.exportNote}`}>
          Couldn&apos;t build the file. Try again, or download the CSVs below.
        </p>
      )}
      <div className={`${styles.row} ${styles.exportNote}`}>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => download(findingsFileName(report), findingsCsv(report), CSV)}
        >
          Findings summary (CSV)
        </button>
        {workListObjects(report).map((objectType) => (
          <button
            key={objectType}
            type="button"
            className={styles.secondaryButton}
            onClick={() => download(workListFileName(report, objectType), workListCsv(report, objectType, { recordLinks }), CSV)}
          >
            Work list: {OBJECT_LABELS[objectType]} (CSV)
          </button>
        ))}
      </div>
      <p className={`${styles.note} ${styles.exportNote}`}>
        Files are built in your browser from this report; nothing is stored. Work lists hold
        record IDs, HubSpot links and a cleanup reason, one file per object, ready to import by
        Record ID.
        {sample && " In the sample, the link column is left blank."}
      </p>
    </div>
  );
}
