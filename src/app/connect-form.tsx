"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ProgressEvent } from "@/lib/progress";
import type { ScanReport } from "@/lib/scan";
import type { FullScanEstimate } from "@/lib/scan-estimate";
import type { ScanStreamEvent } from "@/lib/scan-stream";
import { ProgressCard } from "./progress-card";
import { Report } from "./report";
import styles from "./page.module.css";

type ScanState =
  | { status: "idle" }
  | { status: "estimating" }
  | { status: "confirm"; estimate: FullScanEstimate }
  | { status: "running"; simulated: boolean; full: boolean; startedAt: number; progress?: ProgressEvent }
  | { status: "done"; report: ScanReport }
  | { status: "error"; message: string }
  | { status: "cancelled" };

type ScanBody = { token: string } | { mode: "simulated" };

// Whether the screen wake lock is holding: null before a full scan asks.
type WakeLockState = "held" | "unavailable" | null;

const fmt = (n: number) => n.toLocaleString("en-US");

// Both flags are decided on the server. `liveScan` shows the key field;
// `simulatorAvailable` shows the dev-only simulated scan, whose code never
// reaches the browser: the button only asks the server to run it.
// `fullScanAvailable` shows the full duplicate scan option, which needs a
// host that lets a request run for half an hour. `children` go at the
// bottom of the form card, under the key field; `after` sits just below the
// card, above any progress or report.
export function ConnectForm({
  liveScan,
  simulatorAvailable,
  fullScanAvailable = false,
  children,
  after,
}: {
  liveScan: boolean;
  simulatorAvailable: boolean;
  fullScanAvailable?: boolean;
  children?: ReactNode;
  after?: ReactNode;
}) {
  const [state, setState] = useState<ScanState>({ status: "idle" });
  const [full, setFull] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [wakeLock, setWakeLock] = useState<WakeLockState>(null);
  // Set when a scan starts; reading the clock during render breaks prerendering.
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // The key (or simulator request) between the estimate and the start of a
  // full scan, in memory only; cleared as soon as the scan starts or the
  // user goes back.
  const pendingRef = useRef<ScanBody | null>(null);
  const lockRef = useRef<WakeLockSentinel | null>(null);
  const running = state.status === "running";
  const busy = running || state.status === "estimating";
  const fullRunning = running && state.full;

  // Ticks the elapsed time while a scan runs.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // During a full scan, asks the browser to keep the screen (and so the
  // computer) awake. The browser drops the lock when the tab is hidden, so
  // it's asked again when the tab is shown. Without support, the page says
  // to keep the computer awake.
  useEffect(() => {
    if (!fullRunning) return;
    let active = true;
    async function hold() {
      if (!("wakeLock" in navigator)) return setWakeLock("unavailable");
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (!active) return void lock.release();
        lockRef.current = lock;
        setWakeLock("held");
      } catch {
        setWakeLock("unavailable");
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void hold();
    };
    void hold();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
      void lockRef.current?.release().catch(() => {});
      lockRef.current = null;
      setWakeLock(null);
    };
  }, [fullRunning]);

  async function scan(body: ScanBody, fullDuplicates = false) {
    const controller = new AbortController();
    abortRef.current = controller;
    const simulated = "mode" in body;
    setNow(Date.now());
    setState({ status: "running", simulated, full: fullDuplicates, startedAt: Date.now() });

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...(fullDuplicates && { fullDuplicates: true }) }),
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

  // Before a full scan: what it would cost for this portal.
  async function estimate(body: ScanBody) {
    pendingRef.current = body;
    setNotice(null);
    setState({ status: "estimating" });
    try {
      const response = await fetch("/api/scan/estimate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, fullDuplicates: true }),
      });
      const event = (await response.json()) as { type: "estimate"; estimate: FullScanEstimate } | { type: "error"; message: string };
      if (event.type === "error") {
        pendingRef.current = null;
        return setState({ status: "error", message: event.message });
      }
      if (!event.estimate.needed) {
        // The normal scan already reads every record.
        pendingRef.current = null;
        setNotice(
          `This portal has ${fmt(event.estimate.contacts)} contacts and ${fmt(event.estimate.companies)} companies, so the normal scan already checks every one for duplicates.`,
        );
        return void scan(body);
      }
      setState({ status: "confirm", estimate: event.estimate });
    } catch {
      pendingRef.current = null;
      setState({ status: "error", message: "Couldn't reach the scanner. Check your connection and try again." });
    }
  }

  function start(body: ScanBody) {
    setNotice(null);
    if (full && fullScanAvailable) void estimate(body);
    else void scan(body);
  }

  function startFull() {
    const body = pendingRef.current;
    pendingRef.current = null;
    if (body) void scan(body, true);
  }

  function back() {
    pendingRef.current = null;
    setState({ status: "idle" });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("token") as HTMLInputElement;
    const token = input.value;
    // Don't leave the key sitting in the page once it's sent.
    input.value = "";
    start({ token });
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
              <button type="submit" className={styles.button} disabled={busy}>
                {running ? "Scanning…" : state.status === "estimating" ? "Checking…" : "Run scan"}
              </button>
            </div>
            <p className={styles.note}>Used for this scan only. Not stored, not logged.</p>
          </>
        )}
        {fullScanAvailable && (liveScan || simulatorAvailable) && (
          <div>
            <label className={styles.checkRow}>
              <input type="checkbox" checked={full} disabled={busy} onChange={(e) => setFull(e.target.checked)} />
              Full duplicate scan (slower)
            </label>
            <p className={styles.note}>
              Checks every contact and company for duplicates, not only the newest 10,000. On a large portal it
              can take half an hour or more; you&apos;ll see an estimate before it starts.
            </p>
          </div>
        )}
        {simulatorAvailable && (
          <div className={styles.simulatorRow}>
            <button type="button" className={styles.secondaryButton} disabled={busy} onClick={() => start({ mode: "simulated" })}>
              Run simulated 250K scan
            </button>
            <span className={styles.note}>Dev only: fake portal, no HubSpot calls.</span>
          </div>
        )}
        {children}
      </form>

      {after}

      {state.status === "confirm" && <EstimateCard estimate={state.estimate} onStart={startFull} onBack={back} />}

      {notice && (
        <p role="status" className={styles.note}>
          {notice}
        </p>
      )}

      {state.status === "running" && (
        <ProgressCard
          progress={state.progress}
          simulated={state.simulated}
          elapsedMs={now - state.startedAt}
          full={state.full}
          wakeLock={wakeLock}
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

function EstimateCard({ estimate: e, onStart, onBack }: { estimate: FullScanEstimate; onStart: () => void; onBack: () => void }) {
  const share = e.dailyLimit ? ` (${((e.calls / e.dailyLimit) * 100).toFixed(1)}% of the portal's daily allowance of ${fmt(e.dailyLimit)})` : "";
  return (
    <section className={styles.card} aria-label="Full duplicate scan estimate">
      <h2>Full duplicate scan</h2>
      <p>
        This portal has {fmt(e.contacts)} contacts and {fmt(e.companies)} companies. A full duplicate scan makes about{" "}
        {fmt(e.calls)} API calls{share} and takes about {e.minutes} {e.minutes === 1 ? "minute" : "minutes"}.
      </p>
      {e.daily === "warn" && (
        <p className={styles.note}>
          That&apos;s more than half of what&apos;s left of today&apos;s allowance ({fmt(e.dailyRemaining!)} calls), which other
          apps on this portal share.
        </p>
      )}
      {e.daily === "block" ? (
        <p role="alert" className={styles.error}>
          That&apos;s more than the {fmt(e.dailyRemaining!)} calls left in today&apos;s allowance. Run it after midnight in the
          portal&apos;s time zone, or run the normal scan.
        </p>
      ) : (
        <p className={styles.note}>Keep this tab open and your computer awake while it runs. Cancel stops it at any time.</p>
      )}
      <div className={styles.row}>
        {e.daily !== "block" && (
          <button type="button" className={styles.button} onClick={onStart}>
            Start full scan
          </button>
        )}
        <button type="button" className={styles.secondaryButton} onClick={onBack}>
          Back
        </button>
      </div>
    </section>
  );
}
