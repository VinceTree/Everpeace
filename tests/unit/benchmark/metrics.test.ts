import assert from "node:assert/strict";
import { test } from "node:test";
import { createBenchmarkMetricsCollector } from "../../../src/benchmark/metrics.js";

test("benchmark metrics collect loop reliability signals without changing loop events", () => {
  let clock = 100;
  const collector = createBenchmarkMetricsCollector(() => clock);
  collector.onPhase("sampling");
  collector.onEvent({ type: "sampling_started" });
  collector.onEvent({ type: "response_received", response: { output: [], output_text: "" } });
  collector.onEvent({ type: "response_rejected", reason: "incomplete" });
  collector.onEvent({ type: "response_rejected", reason: "invalid_tool_call" });
  collector.onEvent({ type: "tool_batch_started", calls: [] });
  collector.onEvent({ type: "tool_started", call: { type: "function_call", call_id: "a", name: "read_file", arguments: "{}" } });
  collector.onEvent({
    type: "tool_finished",
    call: { type: "function_call", call_id: "a", name: "read_file", arguments: "{}" },
    output: JSON.stringify({ status: "error", error: "missing" }),
  });
  collector.onEvent({ type: "retrying", attempt: 1, delayMs: 1, category: "server" });
  collector.onEvent({ type: "stream_recovery_started" });
  collector.onEvent({ type: "stream_recovery_finished", success: true });
  collector.onEvent({ type: "compaction_completed", automatic: true, usage: null });
  collector.onEvent({ type: "steering_applied", count: 1 });
  collector.onPhase("cancelled");
  clock = 175;

  assert.deepEqual(collector.snapshot(), {
    durationMs: 75,
    phases: ["sampling", "cancelled"],
    samplingAttempts: 1,
    responses: 1,
    responseRejections: 2,
    incompleteResponses: 1,
    invalidToolCalls: 1,
    toolCalls: 1,
    toolResults: 1,
    unclosedToolCalls: 0,
    toolFailures: 1,
    toolBatches: 1,
    toolResultOrder: ["a"],
    firstToolStartDelayMs: 0,
    retries: 1,
    streamRecoveries: 1,
    successfulStreamRecoveries: 1,
    compactions: 1,
    cancellations: 1,
    steeringApplications: 1,
  });

});
