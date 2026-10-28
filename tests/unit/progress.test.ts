import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProgress, type ProgressEvent } from "@/lib/progress";

// A progress tracker with a hand-driven clock and call counts.
function setup(minIntervalMs = 250) {
  const events: ProgressEvent[] = [];
  const state = { calls: 0, retries: 0, time: 0 };
  const progress = createProgress({
    emit: (e) => events.push(e),
    counts: () => ({ calls: state.calls, retries: state.retries }),
    simulated: false,
    minIntervalMs,
    now: () => state.time,
  });
  return { progress, events, state };
}

describe("progress", () => {
  it("doesn't jump to 99% when setup finishes before the checks are planned", () => {
    // The first scale test: 7 setup calls, then ~430 check calls planned.
    const { progress, events, state } = setup(0);
    progress.plan(7);
    state.calls = 7;
    progress.tick();
    progress.beginChecks(400);
    assert.ok(events.at(-1)!.percent <= 5, `after setup: ${events.at(-1)!.percent}%`);
    state.calls = 7 + 200;
    progress.tick();
    const half = events.at(-1)!.percent;
    assert.ok(half >= 45 && half <= 55, `halfway through checks: ${half}%`);
  });

  it("fills the bar after setup with calls done ÷ calls planned", () => {
    const { progress, events, state } = setup(0);
    progress.beginChecks(200);
    state.calls = 50;
    progress.tick();
    // 5% for setup, then a quarter of the remaining 94: 5 + 23.
    assert.equal(events.at(-1)!.percent, 28);
    assert.equal(events.at(-1)!.apiCalls, 50);
  });

  it("never goes backwards when the plan grows", () => {
    const { progress, events, state } = setup(0);
    progress.beginChecks(100);
    state.calls = 60;
    progress.tick();
    progress.plan(100); // a search turned out to need more pages
    state.calls = 61;
    progress.tick();
    assert.deepEqual(
      events.map((e) => e.percent),
      [61, 61],
    );
  });

  it("doesn't count retries as progress", () => {
    const { progress, events, state } = setup(0);
    progress.beginChecks(10);
    state.calls = 5;
    state.retries = 3;
    progress.tick();
    // 2 of 10 planned calls done: 5 + 18.
    assert.equal(events.at(-1)!.percent, 23);
    assert.equal(events.at(-1)!.retries, 3);
  });

  it("stays below 100 until the scan finishes", () => {
    const { progress, events, state } = setup(0);
    progress.beginChecks(10);
    state.calls = 12;
    progress.tick();
    assert.equal(events.at(-1)!.percent, 99);
    progress.finish();
    assert.equal(events.at(-1)!.percent, 100);
    assert.equal(events.at(-1)!.phase, "Done");
  });

  it("sends routine updates at most every 250ms, but phase changes and waits at once", () => {
    const { progress, events, state } = setup();
    progress.plan(100);
    progress.phase("Reading portal setup");
    state.time = 100;
    progress.tick(); // too soon
    progress.detail("1 of 3"); // too soon
    state.time = 300;
    progress.tick();
    state.time = 310;
    progress.phase("Checking contact properties");
    progress.waiting(4000, 2, 5);
    assert.deepEqual(
      events.map((e) => [e.phase, e.detail]),
      [
        ["Reading portal setup", undefined],
        ["Reading portal setup", "1 of 3"],
        ["Checking contact properties", undefined],
        ["Checking contact properties", "HubSpot rate limit: retrying in 4s (2 of 5)"],
      ],
    );
    assert.equal(events.at(-1)!.waitingMs, 4000);
  });

  it("marks simulated scans on every event", () => {
    const events: ProgressEvent[] = [];
    const progress = createProgress({ emit: (e) => events.push(e), counts: () => ({ calls: 0, retries: 0 }), simulated: true });
    progress.phase("Reading portal setup");
    progress.finish();
    assert.ok(events.every((e) => e.simulated));
  });
});
