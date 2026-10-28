// Production-build check for the dev simulator. Starts the built app with
// ENABLE_SIMULATOR=true and confirms the simulator is still unavailable and
// none of its code reached the browser bundles. Plain Node, so it works the
// same in PowerShell and bash. Run with: npm run check:simulator-prod
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
// Strings that exist only in the simulator's code.
const SIMULATOR_ONLY = ["acmegrinding.example", "Simulated property.", "ten_secondly_rolling limit"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("server didn't start");
}

async function main() {
  if (!existsSync(".next/BUILD_ID")) throw new Error("No production build. Run npm run build first.");

  const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    env: { ...process.env, NODE_ENV: "production", ENABLE_SIMULATOR: "true" },
    stdio: "ignore",
  });
  const results: [string, boolean][] = [];
  try {
    await waitForServer();

    const page = await (await fetch(BASE)).text();
    results.push(["page has no simulated-scan button", !page.includes("Run simulated 250K scan")]);

    const response = await fetch(`${BASE}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "simulated" }),
    });
    const body = await response.text();
    results.push(["simulated scan refused with 403", response.status === 403 && /disabled/.test(body)]);

    const browserCode = files(".next/static")
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const marker of SIMULATOR_ONLY) {
      results.push([`browser bundles don't contain "${marker}"`, !browserCode.includes(marker)]);
    }
  } finally {
    server.kill();
  }

  for (const [name, passed] of results) console.log(`${passed ? "PASS" : "FAIL"}  ${name}`);
  if (results.some(([, passed]) => !passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
