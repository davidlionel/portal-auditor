import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liveScanEnabled } from "@/lib/live-scan";

describe("live scanning setting", () => {
  it("is on by default when running locally", () => {
    assert.equal(liveScanEnabled({}), true);
    assert.equal(liveScanEnabled({ NODE_ENV: "development" }), true);
    assert.equal(liveScanEnabled({ NODE_ENV: "production" }), true);
  });

  it("is off on Vercel", () => {
    assert.equal(liveScanEnabled({ VERCEL: "1" }), false);
    assert.equal(liveScanEnabled({ VERCEL: "1", NODE_ENV: "production" }), false);
    assert.equal(liveScanEnabled({ VERCEL: "1", ENABLE_LIVE_SCAN: "1" }), false);
    assert.equal(liveScanEnabled({ VERCEL: "1", ENABLE_LIVE_SCAN: "" }), false);
  });

  it("is on on Vercel when ENABLE_LIVE_SCAN=true", () => {
    assert.equal(liveScanEnabled({ VERCEL: "1", ENABLE_LIVE_SCAN: "true" }), true);
  });

  it("is off anywhere with ENABLE_LIVE_SCAN=false", () => {
    assert.equal(liveScanEnabled({ ENABLE_LIVE_SCAN: "false" }), false);
  });

  it("decides the real route's answer to a service key", async () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { VERCEL: env.VERCEL, ENABLE_LIVE_SCAN: env.ENABLE_LIVE_SCAN };
    env.VERCEL = "1";
    delete env.ENABLE_LIVE_SCAN;
    try {
      const { POST } = await import("@/app/api/scan/route");
      const response = await POST(
        new Request("http://localhost/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "pat-na1-00000000-0000-0000-0000-000000000000" }),
        }),
      );
      assert.equal(response.status, 403);
      assert.match(await response.text(), /sample report only/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    }
  });
});
