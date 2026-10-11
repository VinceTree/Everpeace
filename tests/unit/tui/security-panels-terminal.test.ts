import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import * as pty from "node-pty";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 80));
test("real inline terminal confirms, cancels and resizes security panels without model requests", { timeout: 60_000 }, async () => {
  for (const [panel, cancel] of [["doctor", true], ["doctor", false], ["web", true], ["web", false], ["cost", true], ["cost", false]] as const) {
    let output = "", ended = false;
    const terminal = pty.spawn(process.execPath, ["--import", "tsx", path.resolve("tests/fixtures/security-panels-terminal.tsx"), panel], { name: "xterm-256color", cols: 90, rows: 35, cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: "0" } });
    const endedPromise = new Promise<void>((resolve) => terminal.onExit(() => { ended = true; resolve(); }));
    terminal.onData((text) => { output += text; });
    async function waitFor(text: string) { const deadline = Date.now() + 8000; while (!output.includes(text) && !ended && Date.now() < deadline) await tick(); assert.ok(output.includes(text), `${panel}: expected ${text}`); }
    try {
      await waitFor("Fixture session history"); terminal.resize(48, 25); await tick(); terminal.resize(110, 40); await tick();
      if (cancel) terminal.write("\u001b");
      else if (panel === "doctor") { terminal.write("\u001b[B"); await tick(); terminal.write("\r"); }
      else if (panel === "web") { terminal.write("\r"); await waitFor("Save html"); terminal.write("\r"); }
      else { terminal.write("\u001b[B"); await tick(); terminal.write("\r"); for (const value of ["USD", "2", "1", "4", "10"]) { await tick(); terminal.write(value); await tick(); terminal.write("\r"); } await waitFor("Save prices"); terminal.write("\u001b[B"); await tick(); terminal.write("\r"); }
      await waitFor("SESSION_RESTORED");
      assert.match(output, cancel ? /requests=0 configured=0/u : panel === "doctor" ? /requests=1 configured=0/u : /requests=0 configured=1/u);
      assert.equal(output.includes("\u001b[?1049h"), false);
    } finally {
      if (!ended) terminal.kill();
      await Promise.race([endedPromise, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("Owned terminal did not close")), 5000))]);
    }
  }
});
