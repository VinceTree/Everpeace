import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskPerformance, isTaskPerformanceReport, formatTaskPerformance } from "../../../src/performance/task-report.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { RequestExecutor } from "../../../src/agent/request-executor.js";
import { AuxiliaryRequestExecutor } from "../../../src/agent/auxiliary-request-executor.js";

test("performance counts settled attempts once, including failures, without double reasoning", async () => {
  let clock = 0;
  const trace = new TaskPerformance(() => clock); trace.begin();
  const executor = new RequestExecutor(new RequestAttemptLedger(), undefined, trace);
  await executor.execute("coding", async () => ({ usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17, reasoning_tokens: 5 } }));
  await assert.rejects(executor.execute("summary", async () => { throw new Error("synthetic failure"); }));
  clock = 400;
  const report = trace.finish()!;
  assert.equal(report.wallMs, 400); assert.equal(report.usage.coding?.outputTokens, 7);
  assert.equal(report.usage.summary?.unknown, 1); assert.equal(report.meteringComplete, false);
  assert.equal(isTaskPerformanceReport(report), true);
  assert.equal(isTaskPerformanceReport({ ...report, rawArguments: "secret" }), false);
  assert.equal(formatTaskPerformance().includes("unavailable"), true);
});
test("repeated reads respect observed content versions and persist no argument signatures", () => {
  const trace = new TaskPerformance(); trace.begin();
  const event = { type: "tool_finished" as const, call: { type: "function_call" as const, name: "read_file", call_id: "test", arguments: '{"path":"private-client-file"}' }, output: "customer data" };
  trace.observe(event, "v1"); trace.observe(event, "v1"); trace.observe(event, "v2");
  trace.timing("verification", 200); trace.timing("sandbox_startup", 20); trace.timing("secret-label", 4);
  const report = trace.finish()!;
  assert.equal(report.counters.repeatedReads, 1); assert.equal(report.counters.repeatedCalls, 1);
  assert.doesNotMatch(JSON.stringify(report), /private-client|customer|secret-label/u);
  trace.begin(); assert.equal(trace.snapshot()?.counters.repeatedReads, undefined);
});
test("late requests cannot migrate to another task; auxiliary attempts join the owning task", async () => {
  const trace = new TaskPerformance(); trace.begin();
  const executor = new RequestExecutor(new RequestAttemptLedger(), undefined, trace);
  let release!: () => void; let admitted!: () => void;
  const ready = new Promise<void>((resolve) => { admitted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pending = executor.execute("coding", async () => { admitted(); await gate; return { usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } }; });
  await ready; trace.finish(); trace.begin(); release(); await pending;
  assert.deepEqual(trace.snapshot()!.usage, {});
  const auxiliary = new AuxiliaryRequestExecutor(() => trace);
  await auxiliary.execute("title", async () => ({ usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
  assert.equal(trace.finish()!.usage.title?.requests, 1); await auxiliary.dispose();
});
