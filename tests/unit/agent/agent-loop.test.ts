import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySamplingError, runAgentLoop, type AgentLoopOptions, type LoopPhase } from "../../../src/agent/agent-loop.js";
import { prepareToolOutput } from "../../../src/agent/context-limits.js";

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

test("throwing tool errors are sanitized before ordered durable persistence", async () => {
  let samples = 0;
  const committed: string[] = [];
  const f = fixture({
    async sample() { return ++samples === 1 ? { output: [call("failure")], output_text: "" } : { output: [], output_text: "done" }; },
    async dispatch() { throw new Error("api_key=secret-credential\n  diagnostic"); },
    prepareToolOutput: (output, tool) => prepareToolOutput(output, tool.name),
    async recordToolResult(item, prepared) {
      assert.equal(item.output, prepared.output);
      committed.push(String(item.output));
    },
  });
  await runAgentLoop(f.options);
  assert.equal(committed.length, 1);
  assert.doesNotMatch(committed[0]!, /secret-credential/u);
  assert.match(committed[0]!, /secret redacted/u);
  assert.match(JSON.parse(committed[0]!).error, /\n  diagnostic/u);
  assert.ok(!f.records.some((item) => item.type === "function_call_output"));
});

test("parallel output preparation failure stops the batch without publishing a result", async () => {
  let samples = 0;
  let committed = 0;
  const f = fixture({
    async sample() { samples++; return { output: [call("first"), call("second")], output_text: "" }; },
    toolCapabilities: () => ({ readOnly: true, idempotent: true, parallelSafe: true, resourceKeys: [] }),
    prepareToolOutput(output, tool) {
      if (tool.call_id === "first") throw new RangeError("invalid output metadata");
      return prepareToolOutput(output, tool.name);
    },
    async recordToolResult() { committed++; },
  });
  await assert.rejects(runAgentLoop(f.options), /invalid output metadata/u);
  assert.equal(samples, 1);
  assert.equal(committed, 0);
  assert.ok(!f.records.some((item) => item.type === "function_call_output"));
});

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

test("sampling retry honors bounded Retry-After guidance", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const f = fixture({
    retryDelayMs: 10_000,
    onEvent(event) { if (event.type === "retrying") delays.push(event.delayMs); },
    async sample() {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "0.001" } });
      return { output: [], output_text: "done" };
    },
  });
  await runAgentLoop(f.options);
  assert.deepEqual(delays, [1]);
});

test("follow-up step budget stops successful infinite tool loops", async () => {
  let samples = 0;
  const events: string[] = [];
  const f = fixture({
    maxSteps: 2,
    onEvent(event) { if (event.type === "step_limit_reached") events.push(`${event.type}:${event.maxSteps}`); },
    async sample() {
      samples += 1;
      return { output: [call(`call-${samples}`)], output_text: "working" };
    },
    async dispatch() { return "ok"; },
  });
  const result = await runAgentLoop(f.options);
  assert.equal(result.stopReason, "step_limit");
  assert.equal(result.steps, 2);
  assert.equal(samples, 2);
  assert.deepEqual(events, ["step_limit_reached:2"]);
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
    hasPendingSteering: () => steer,
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

test("parallel read pool refills when a later call finishes before the first", async () => {
  let sample = 0;
  const events: string[] = [];
  const f = fixture({
    maxParallelTools: 2,
    async sample() {
      sample += 1;
      return sample === 1
        ? { output: ["a", "b", "c", "d"].map((id) => ({ ...call(id), name: "read_file" })), output_text: "" }
        : { output: [], output_text: "done" };
    },
    canRunInParallel: () => true,
    async dispatch(tool) {
      events.push(`start:${tool.call_id}`);
      await new Promise((resolve) => setTimeout(resolve, tool.call_id === "a" ? 40 : 2));
      events.push(`finish:${tool.call_id}`);
      return tool.call_id;
    },
  });
  await runAgentLoop(f.options);
  assert.ok(events.indexOf("start:c") < events.indexOf("finish:a"));
  assert.deepEqual(
    f.records.filter((item) => item.type === "function_call_output").map((item) => item.call_id),
    ["a", "b", "c", "d"],
  );
});

test("parallel read pool durably records contiguous outputs before the segment finishes", async () => {
  let sample = 0;
  let persisted = 0;
  let persistedBeforeLastStart = -1;
  const ids = Array.from({ length: 12 }, (_value, index) => String(index));
  const f = fixture({
    maxParallelTools: 4,
    async sample() {
      sample += 1;
      return sample === 1
        ? { output: ids.map((id) => ({ ...call(id), name: "read_file" })), output_text: "" }
        : { output: [], output_text: "done" };
    },
    canRunInParallel: () => true,
  });
  f.options.record = async (items) => {
    f.records.push(...items);
    persisted += items.filter((item) => item.type === "function_call_output").length;
  };
  f.options.dispatch = async (tool) => {
    if (tool.call_id === ids.at(-1)) persistedBeforeLastStart = persisted;
    await new Promise((resolve) => setTimeout(resolve, 1));
    return `${tool.call_id}:${"x".repeat(64 * 1024)}`;
  };

  await runAgentLoop(f.options);
  assert.ok(persistedBeforeLastStart > 0);
  assert.deepEqual(
    f.records.filter((item) => item.type === "function_call_output").map((item) => item.call_id),
    ids,
  );
});

test("parallel persistence failure cancels and awaits unfinished reads", async () => {
  let sample = 0;
  let slowCancelled = false;
  const f = fixture({
    maxParallelTools: 2,
    async sample() {
      sample += 1;
      return sample === 1
        ? { output: ["a", "b"].map((id) => ({ ...call(id), name: "read_file" })), output_text: "" }
        : { output: [], output_text: "done" };
    },
    canRunInParallel: () => true,
  });
  f.options.record = async (items) => {
    if (items.some((item) => item.type === "function_call_output")) throw new Error("durable store failed");
    f.records.push(...items);
  };
  f.options.dispatch = async (tool, signal) => {
    if (tool.call_id === "a") return "ready";
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => { slowCancelled = true; resolve(); }, { once: true }));
    return "cancelled";
  };

  await assert.rejects(runAgentLoop(f.options), /durable store failed/u);
  assert.equal(slowCancelled, true);
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

test("capability resource conflicts serialize calls within the bounded pool", async () => {
  const batches: string[][] = [];
  let active = 0;
  let peak = 0;
  let samples = 0;
  const f = fixture({
    async sample() {
      samples += 1;
      return samples === 1
        ? { output: [call("a"), call("b"), call("c")], output_text: "" }
        : { output: [], output_text: "done" };
    },
    toolCapabilities() {
      return { readOnly: true, idempotent: true, parallelSafe: true, resourceKeys: ["same"] };
    },
    onEvent(event) {
      if (event.type === "tool_batch_started") batches.push(event.calls.map((item) => item.call_id));
    },
    async dispatch(tool) {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return tool.call_id;
    },
  });
  await runAgentLoop(f.options);
  assert.deepEqual(batches, [["a", "b", "c"]]);
  assert.equal(peak, 1);
});
