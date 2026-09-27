import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySamplingError, runAgentLoop, type AgentLoopOptions, type LoopPhase } from "../../../src/agent/agent-loop.js";

const call = (id: string) => ({ type: "function_call", call_id: id, name: "test", arguments: "{}" });

test("sampling errors expose stable recovery categories", () => {
  assert.equal(classifySamplingError(Object.assign(new Error("socket closed"), { name: "APIConnectionError" })), "connection");
  assert.equal(classifySamplingError(Object.assign(new Error("request timeout"), { status: 408 })), "timeout");
  assert.equal(classifySamplingError(Object.assign(new Error("rate limited"), { status: 429 })), "rate_limit");
  assert.equal(classifySamplingError(Object.assign(new Error("upstream"), { status: 503 })), "server");
  assert.equal(classifySamplingError(Object.assign(new Error("Responses stream ended before response.completed"), { name: "ResponseStreamIncompleteError" })), "stream_incomplete");
  assert.equal(classifySamplingError(Object.assign(new Error("maximum context length exceeded"), { status: 400 })), "context_limit");
  assert.equal(classifySamplingError(Object.assign(new Error("bad request"), { status: 400 })), "permanent");
});
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

test("sampling retry budget is shared across follow-up requests in one turn", async () => {
  let samples = 0;
  const f = fixture({
    async sample() {
      samples += 1;
      if (samples === 1) return { output: [call("a")], output_text: "" };
      throw Object.assign(new Error("temporary"), { status: 503 });
    },
    maxRetries: 2,
    async dispatch() { return "ok"; },
  });
  await assert.rejects(runAgentLoop(f.options), /temporary/);
  assert.equal(samples, 4);
});

test("prepares one immutable step across sampling retries and refreshes after follow-up tools", async () => {
  let samples = 0;
  let steps = 0;
  const f = fixture({
    async prepareStep() { steps++; },
    async sample() {
      samples++;
      if (samples === 1) return { output: [call("a")], output_text: "" };
      if (samples === 2) throw Object.assign(new Error("temporary"), { status: 503 });
      return { output: [], output_text: "done" };
    },
    async dispatch() { return "ok"; },
    retryDelayMs: 1,
  });
  await runAgentLoop(f.options);
  assert.equal(samples, 3);
  assert.equal(steps, 2);
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

test("incomplete and duplicate tool responses emit rejection diagnostics without execution", async () => {
  const events: string[] = [];
  let executions = 0;
  const incomplete = fixture({
    async sample() { return { output: [call("incomplete")], output_text: "", status: "incomplete" }; },
    async dispatch() { executions += 1; return "unexpected"; },
    onEvent(event) {
      if (event.type === "response_rejected") events.push(event.reason);
    },
  });
  await assert.rejects(runAgentLoop(incomplete.options), /incomplete/);
  const duplicate = fixture({
    async sample() { return { output: [call("same"), call("same")], output_text: "" }; },
    async dispatch() { executions += 1; return "unexpected"; },
    onEvent(event) {
      if (event.type === "response_rejected") events.push(event.reason);
    },
  });
  await assert.rejects(runAgentLoop(duplicate.options), /missing or duplicate/);
  assert.equal(executions, 0);
  assert.deepEqual(events, ["incomplete", "invalid_tool_call"]);
});

test("invalid function call fields are rejected before any tool runs", async () => {
  let executions = 0;
  const f = fixture({
    async sample() {
      return { output: [{ type: "function_call", call_id: "a", name: "bash" }], output_text: "" };
    },
    async dispatch() { executions += 1; return "unexpected"; },
  });
  await assert.rejects(runAgentLoop(f.options), /invalid fields/);
  assert.equal(executions, 0);
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

test("a tool can end the current loop after its durable output is recorded", async () => {
  let samples = 0;
  const f = fixture({
    async sample() {
      samples += 1;
      return { output: [call("a"), call("b")], output_text: "" };
    },
    async dispatch(item) {
      return item.call_id === "a" ? { output: "approved", stop: true } : "unexpected";
    },
  });
  await runAgentLoop(f.options);
  assert.equal(samples, 1);
  assert.match(String(f.records.find((item) => item.call_id === "a" && item.type === "function_call_output")?.output), /approved/);
  assert.match(String(f.records.find((item) => item.call_id === "b" && item.type === "function_call_output")?.output), /skipped/);
});

test("explicitly marked read-only tools run concurrently but persist outputs in model order", async () => {
  let sample = 0;
  const f = fixture({
    async sample() {
      sample += 1;
      return sample === 1
        ? { output: [
            { ...call("a"), name: "read_file" },
            { ...call("b"), name: "list_directory" },
          ], output_text: "" }
        : { output: [], output_text: "done" };
    },
    canRunInParallel: (tool) => tool.name === "read_file" || tool.name === "list_directory",
  });
  let active = 0;
  let peak = 0;
  f.options.dispatch = async (tool) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, tool.call_id === "a" ? 20 : 1));
    active -= 1;
    return tool.call_id;
  };
  await runAgentLoop(f.options);
  assert.equal(peak, 2);
  assert.deepEqual(
    f.records.filter((item) => item.type === "function_call_output").map((item) => [item.call_id, item.output]),
    [["a", "a"], ["b", "b"]],
  );
});

test("parallel batches stop at unsafe calls and preserve later serial work", async () => {
  const order: string[] = [];
  let sample = 0;
  const f = fixture({
    async sample() {
      sample += 1;
      return sample === 1
        ? { output: [
            { ...call("a"), name: "read_file" },
            { ...call("b"), name: "bash" },
            { ...call("c"), name: "list_directory" },
          ], output_text: "" }
        : { output: [], output_text: "done" };
    },
    canRunInParallel: (tool) => tool.name === "read_file" || tool.name === "list_directory",
    async dispatch(tool) { order.push(tool.call_id); return tool.call_id; },
  });
  await runAgentLoop(f.options);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("capability resource conflicts split parallel batches", async () => {
  const batches: string[][] = [];
  const f = fixture({
    async sample() {
      return batches.length === 0
        ? { output: [call("a"), call("b"), call("c")], output_text: "" }
        : { output: [], output_text: "done" };
    },
    toolCapabilities() {
      return { readOnly: true, idempotent: true, parallelSafe: true, resourceKeys: ["same"] };
    },
    onEvent(event) {
      if (event.type === "tool_batch_started") batches.push(event.calls.map((item) => item.call_id));
    },
  });
  await runAgentLoop(f.options);
  assert.deepEqual(batches, [["a"], ["b"], ["c"]]);
});
