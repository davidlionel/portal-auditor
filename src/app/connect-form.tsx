"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ProgressEvent } from "@/lib/progress";
import type { ScanReport } from "@/lib/scan";
import type { ScanStreamEvent } from "@/lib/scan-stream";
import { ProgressCard } from "./progress-card";
import { Report } from "./report";
import styles from "./page.module.css";

type ScanState =
  | { status: "idle" }
  | { status: "running"; simulated: boolean; startedAt: number; progress?: ProgressEvent }
  | { status: "done"; report: ScanReport }
  | { status: "error"; message: string }
  | { status: "cancelled" };

// Both flags are decided on the server. `liveScan` shows the key field;
// `simulatorAvailable` shows the dev-only simulated scan, whose code never
// reaches the browser: the button only asks the server to run it. `children`
// go at the bottom of the form card, under the key field.
export function ConnectForm({
  liveScan,
  simulatorAvailable,
  children,
}: {
  liveScan: boolean;
  simulatorAvailable: boolean;
  children?: ReactNode;
}) {
  const [state, setState] = useState<ScanState>({ status: "idle" });
  // Set when a scan starts; reading the clock during render breaks prerendering.
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const running = state.status === "running";

  // Ticks the elapsed time while a scan runs.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  async function scan(body: { token: string } | { mode: "simulated" }) {
    const controller = new AbortController();
    abortRef.current = controller;
    const simulated = "mode" in body;
    setNow(Date.now());
    setState({ status: "running", simulated, startedAt: Date.now() });

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.body) throw new Error("no body");

      // NDJSON: progress lines, then one "done" or "error" line.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const text of lines) {
          if (!text.trim()) continue;
          const event = JSON.parse(text) as ScanStreamEvent;
          if (event.type === "progress") {
            setState((s) => (s.status === "running" ? { ...s, progress: event } : s));
          } else if (event.type === "done") {
            finished = true;
            setState({ status: "done", report: event.report });
          } else {
            finished = true;
            setState({ status: "error", message: event.message });
          }
        }
      }
      if (!finished) setState({ status: "error", message: "The scan stopped unexpectedly. Try again." });
    } catch {
      setState(
        controller.signal.aborted
          ? { status: "cancelled" }
          : { status: "error", message: "Couldn't reach the scanner. Check your connection and try again." },
      );
    } finally {
      abortRef.current = null;
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("token") as HTMLInputElement;
    const token = input.value;
    // Don't leave the key sitting in the page once it's sent.
    input.value = "";
    void scan({ token });
  }

  return (
    <>
      <form onSubmit={onSubmit} className={`${styles.card} ${styles.form}`}>
        {liveScan && (
          <>
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
              <button type="submit" className={styles.button} disabled={running}>
                {running ? "Scanning…" : "Run scan"}
              </button>
            </div>
            <p className={styles.note}>Used for this scan only. Not stored, not logged.</p>
          </>
        )}
        {simulatorAvailable && (
          <div className={styles.simulatorRow}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={running}
              onClick={() => void scan({ mode: "simulated" })}
            >
              Run simulated 250K scan
            </button>
            <span className={styles.note}>Dev only: fake portal, no HubSpot calls.</span>
          </div>
        )}
        {children}
      </form>

      {state.status === "running" && (
        <ProgressCard
          progress={state.progress}
          simulated={state.simulated}
          elapsedMs={now - state.startedAt}
          onCancel={() => abortRef.current?.abort()}
        />
      )}

      {state.status === "error" && (
        <p role="alert" className={styles.error}>
          {state.message}
        </p>
      )}

      {state.status === "cancelled" && (
        <p role="status" className={styles.card}>
          Scan cancelled. No report was produced.
        </p>
      )}

      {state.status === "done" && <Report report={state.report} />}
    </>
  );
}
