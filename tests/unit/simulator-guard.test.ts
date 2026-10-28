import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulatorEnabled } from "@/lib/simulator/guard";

describe("simulator guard", () => {
  it("is on only for a development build with ENABLE_SIMULATOR=true", () => {
    assert.equal(simulatorEnabled({ NODE_ENV: "development", ENABLE_SIMULATOR: "true" }), true);
    assert.equal(simulatorEnabled({ NODE_ENV: "production", ENABLE_SIMULATOR: "true" }), false);
    assert.equal(simulatorEnabled({ NODE_ENV: "test", ENABLE_SIMULATOR: "true" }), false);
    assert.equal(simulatorEnabled({ NODE_ENV: "development" }), false);
    assert.equal(simulatorEnabled({ NODE_ENV: "development", ENABLE_SIMULATOR: "1" }), false);
    assert.equal(simulatorEnabled({}), false);
  });

  it("makes the real route refuse a simulated scan in production, even with the flag", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { NODE_ENV: env.NODE_ENV, ENABLE_SIMULATOR: env.ENABLE_SIMULATOR };
    env.NODE_ENV = "production";
    env.ENABLE_SIMULATOR = "true";
    try {
      const { POST } = await import("@/app/api/scan/route");
      const response = await POST(
        new Request("http://localhost/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "simulated" }),
        }),
      );
      assert.equal(response.status, 403);
      assert.match(await response.text(), /simulated portal is disabled/);
    } finally {
      env.NODE_ENV = saved.NODE_ENV;
      env.ENABLE_SIMULATOR = saved.ENABLE_SIMULATOR;
    }
  });
});
