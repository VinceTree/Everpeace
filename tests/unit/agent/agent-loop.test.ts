import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentLoop, type AgentLoopOptions, type LoopPhase } from "../../../src/agent/agent-loop.js";

const call = (id: string) => ({ type: "function_call", call_id: id, name: "test", arguments: "{}" });
function fixture(overrides: Partial<AgentLoopOptions> = {}) {
  const records: Record<string, unknown>[] = [];
  const phases: LoopPhase[] = [];
  const options: AgentLoopOptions = {
    async sample() { return { output: [], output_text: "done" }; },
    async record(items) { records.push(...items); },
    async dispatch() { return "ok"; },
    assistant() {},
    onPhase(phase) { phases.push(phase); },
    retryDelayMs: 1,
    ...overrides,
  };
  return { options, records, phases };
}

test("Codex follow-up flow checkpoints tools and honors explicit end_turn=false", async () => {
  let samples = 0;
  const f = fixture({ async sample() {
    samples++;
    if (samples === 1) return { output: [call("a"), call("b")], output_text: "working" };
    if (samples === 2) return { output: [], output_text: "more", end_turn: false };
    return { output: [], output_text: "done" };
  }, async dispatch(item) {
    assert.ok(f.records.some((entry) => entry.call_id === item.call_id));
    if (item.call_id === "b") assert.ok(f.records.some((entry) => entry.type === "function_call_output" && entry.call_id === "a"));
    return "ok";
  } });
  await runAgentLoop(f.options);
  assert.equal(samples, 3);
  assert.deepEqual(f.phases, ["sampling", "tools", "sampling", "sampling", "completed"]);
});

test("sampling retry never repeats already executed tools", async () => {
  let samples = 0;
  let executions = 0;
  const f = fixture({ async sample() {
    samples++;
    if (samples === 1) return { output: [call("a")], output_text: "" };
    if (samples === 2) throw Object.assign(new Error("temporary"), { status: 503 });
    return { output: [], output_text: "done" };
  }, async dispatch() { executions++; return "ok"; } });
  await runAgentLoop(f.options);
  assert.equal(samples, 3);
  assert.equal(executions, 1);
});

test("nonretryable errors and exhausted retries fail instead of spinning", async () => {
  for (const status of [400, 401, 403, 503]) {
    let attempts = 0;
    const f = fixture({ async sample() { attempts++; throw Object.assign(new Error("failure"), { status }); } });
    await assert.rejects(runAgentLoop(f.options), /failure/);
    assert.equal(attempts, status === 503 ? 3 : 1);
    assert.equal(f.phases.at(-1), "failed");
  }
});

test("abort interrupts sampling backoff without another request", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const f = fixture({ signal: controller.signal, retryDelayMs: 60_000, async sample() {
    attempts++;
    setTimeout(() => controller.abort(), 5);
    throw Object.assign(new Error("temporary"), { status: 503 });
  } });
  await assert.rejects(runAgentLoop(f.options), /abort/i);
  assert.equal(attempts, 1);
  assert.equal(f.phases.at(-1), "cancelled");
});

test("failed persistence prevents tool side effects and incomplete responses are not executed", async () => {
  let executed = false;
  const f = fixture({ async sample() { return { output: [call("a")], output_text: "" }; },
    async record() { throw new Error("disk full"); }, async dispatch() { executed = true; return "ok"; } });
  await assert.rejects(runAgentLoop(f.options), /disk full/);
  assert.equal(executed, false);
  const incomplete = fixture({ async sample() { return { output: [call("a")], output_text: "", status: "incomplete" }; },
    async dispatch() { executed = true; return "ok"; } });
  await assert.rejects(runAgentLoop(incomplete.options), /incomplete/);
  assert.equal(executed, false);
});

test("steering checkpoints skip unstarted tools and preserve every function output", async () => {
  let samples = 0;
  let steer = false;
  const f = fixture({
    async sample() {
      samples++;
      if (samples === 1) return { output: [call("a"), call("b")], output_text: "" };
      return { output: [], output_text: "corrected" };
    },
    async dispatch(item) {
      if (item.call_id === "a") steer = true;
      return "ok";
    },
    async applySteering() {
      if (!steer) return 0;
      steer = false;
      return 1;
    },
  });
  await runAgentLoop(f.options);
  assert.deepEqual(
    f.records.filter((item) => item.type === "function_call_output").map((item) => item.call_id),
    ["a", "b"],
  );
  assert.match(String(f.records.find((item) => item.type === "function_call_output" && item.call_id === "b")?.output), /steered/);
});
