"use client";

import { useActionState } from "react";
import { runScan, type ScanState } from "./actions";
import { Report } from "./report";
import styles from "./page.module.css";

const initialState: ScanState = { status: "idle" };

export function ConnectForm() {
  const [state, formAction, pending] = useActionState(runScan, initialState);

  return (
    <>
      <form action={formAction} className={`${styles.card} ${styles.form}`}>
        <label htmlFor="token" className={styles.label}>
          HubSpot service key
        </label>
        <div className={styles.row}>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste your service key"
            className={styles.input}
          />
          <button type="submit" className={styles.button} disabled={pending}>
            {pending ? "Scanning…" : "Run scan"}
          </button>
        </div>
        <p className={styles.note}>
          {pending
            ? "Scanning… this can take a minute on portals with many custom properties."
            : "Used for this scan only. Not stored, not logged."}
        </p>
      </form>

      {state.status === "error" && (
        <p role="alert" className={styles.error}>
          {state.message}
        </p>
      )}

      {state.status === "done" && <Report report={state.report} />}
    </>
  );
}
