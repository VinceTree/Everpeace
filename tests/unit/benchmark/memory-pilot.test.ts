import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EvaluationMemoryRuntime } from "../../../src/benchmark/memory-pilot.js";
import { LearnedMemoryStore } from "../../../src/memory/learned-memory.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { RequestExecutor } from "../../../src/agent/request-executor.js";

test("Memory pilot defers capture until external acceptance and includes extraction in the task ledger", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ep-memory-pilot-"));
  const store = new LearnedMemoryStore({ directory });
  const ledger = new RequestAttemptLedger({ tokenBudget: 100 }); const executor = new RequestExecutor(ledger);
  let calls = 0;
  const runtime = new EvaluationMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create() { calls++; return { id: "extract", status: "completed", output: [], output_text: JSON.stringify({ entries: [{ lesson: "Preserve siblings when merging", applyWhen: "Partial object updates", scope: "project" }] }), usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } }; } } },
    runRequest: (run, scope) => scope.executor.execute("memory", () => executor.execute("memory", () => run(scope.signal))),
  });
  const turn = { workspacePath: directory, sessionId: "test-session", userInput: "Fix merge behavior", transcript: "Used a tool and independently checked the repair", assistantText: "Done", toolCallCount: 1 };
  try {
    await runtime.beginTask(); await runtime.beginTurn(); await runtime.finishTurn(turn, "verified"); await runtime.endTask();
    assert.equal(calls, 0); assert.equal((await store.loadJobs()).length, 0);
    await runtime.settleAccepted(false, AbortSignal.timeout(5000));
    assert.equal(calls, 0); assert.equal((await store.read("project", directory)).length, 0);
    await runtime.beginTask(); await runtime.beginTurn(); await runtime.finishTurn(turn, "verified"); await runtime.endTask();
    await runtime.settleAccepted(true, AbortSignal.timeout(5000));
    assert.equal(calls, 1); assert.equal(ledger.snapshot().inputTokens, 4); assert.equal(ledger.snapshot().outputTokens, 2);
    assert.equal(ledger.snapshot().attempts[0]?.purpose, "memory"); assert.equal(ledger.snapshot().complete, true);
    assert.equal((await store.read("project", directory)).length, 1);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});
