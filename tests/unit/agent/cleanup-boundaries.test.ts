import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import type { BashResult } from "../../../src/tools/bash.js";
import { ProcessCleanupError } from "../../../src/tools/process-completion.js";
import type { TeamAgentBridge } from "../../../src/team/types.js";

test("a team cleanup failure still waits for root background workers and blocks Agent reuse", async () => {
  const workspacePath = await fs.mkdtemp(join(tmpdir(), "everpeace-cleanup-owners-"));
  const failure = new ProcessCleanupError("team ownership unresolved");
  const teamController = new AbortController();
  let workerSignal: AbortSignal | undefined;
  let release!: (result: BashResult) => void;
  const worker = new Promise<BashResult>(resolve => { release = resolve; });
  let requests = 0, finished = false;
  const team: TeamAgentBridge = {
    async begin() {}, setRootInput() {},
    signal(signal) { return signal ? AbortSignal.any([signal, teamController.signal]) : teamController.signal; },
    async dispatch() { throw new Error("Unexpected team tool"); }, async beforeVerification() {}, async end() {},
    async cancel(reason) { teamController.abort(reason); throw failure; }, invalidate() {}, snapshot() { return undefined; },
  };
  const agent = new ReactAgent({ workspacePath, model: "offline", team,
    client: { responses: { async create() {
      requests++;
      return { id: `response-${requests}`, output_text: "done", output: requests === 1 ? [{ type: "function_call", name: "start_background", call_id: "worker", arguments: '{"command":"fixture worker"}' }] : [] };
    } } },
    io: { async confirmBash() { return true; }, async runBash() { throw new Error("Unexpected foreground command"); },
      runBackgroundBash(_command, signal) { workerSignal = signal; return worker; }, writeAssistant() {},
    },
  });
  const stopped: BashResult = { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true };
  try {
    await agent.runTurn("start a background worker");
    assert.ok(workerSignal);
    const closing = agent.cancelBackgroundJobs(new Error("task cancelled"));
    void closing.then(() => { finished = true; }, () => { finished = true; });
    const rejected = assert.rejects(closing, error => error === failure);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(workerSignal.aborted, true);
    assert.equal(finished, false, "a different owner's failure cannot release the root worker early");
    release(stopped);
    await rejected;
    assert.equal(finished, true);
    await assert.rejects(agent.runTurn("retry"), error => error === failure);
    assert.equal(requests, 2);
  } finally {
    release(stopped);
    await agent.dispose().catch(error => { assert.ok(error instanceof ProcessCleanupError); });
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
