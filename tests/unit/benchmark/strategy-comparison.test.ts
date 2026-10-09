import assert from "node:assert/strict";
import { test } from "node:test";
import { compareAgentStrategies } from "../../../src/benchmark/strategy-comparison.js";
import { projectBenchmarkEvent } from "../../../src/benchmark/event-projection.js";
import { createBenchmarkMetricsCollector } from "../../../src/benchmark/metrics.js";
import type { BenchmarkCampaignResult } from "../../../src/benchmark/campaign.js";
import type { BenchmarkRunResult } from "../../../src/benchmark/types.js";

function fixture(): BenchmarkCampaignResult {
  const metrics = createBenchmarkMetricsCollector().snapshot();
  const run = (adapter: string, amount: number): BenchmarkRunResult => ({ adapter, taskId: "fix", repetition: 1, status: "passed", startedAt: "2026-10-09T00:00:00Z", durationMs: 100, attempts: 1, metrics, manualInterventions: 0, unsafeActions: 0, workflowOutcome: "verified", verification: { attempted: true, passed: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, durationMs: 10 }, usage: { inputTokens: amount, outputTokens: 0, complete: true } });
  return { campaignId: "test", seed: 1, statisticsComplete: true, tokenUsage: 185, planned: [{ index: 0, taskId: "fix", repetition: 1, harness: "A" }, { index: 1, taskId: "fix", repetition: 1, harness: "B" }], skipped: [], results: [run("A", 100), run("B", 85)] };
}

test("comparison gates savings on verified quality, matched planned denominator and complete usage", () => {
  const campaign = fixture();
  const result = compareAgentStrategies(campaign, "A", "B");
  assert.equal(result.qualityPassed, true);
  assert.equal(result.observedSavings, true);
  assert.equal(result.candidate.tokensPerSuccessfulTaskIncludingFailures, 85);
  assert.equal(result.candidate.successfulTasks[0]!.cachedInputTokens, null);
  campaign.results[1]!.usage!.inputTokens = 90;
  assert.equal(compareAgentStrategies(campaign, "A", "B").observedSavings, true, "Exactly 10% reduction meets the threshold");
  campaign.results[1]!.usage!.complete = false;
  assert.equal(compareAgentStrategies(campaign, "A", "B").observedSavings, false);
  campaign.results[1]!.usage!.complete = true;
  campaign.results[1]!.workflowOutcome = "unverified";
  assert.equal(compareAgentStrategies(campaign, "A", "B").qualityPassed, false);
});

test("failed, skipped, duplicate or manually assisted runs cannot manufacture an efficiency win", () => {
  const failed = fixture(); failed.results[1]!.status = "failed";
  assert.equal(compareAgentStrategies(failed, "A", "B").qualityPassed, false);
  const skipped = fixture(); skipped.results = skipped.results.slice(0, 1); skipped.statisticsComplete = false;
  assert.equal(compareAgentStrategies(skipped, "A", "B").candidate.successRate, 0);
  assert.equal(compareAgentStrategies(skipped, "A", "B").eligibleForDefault, false);
  const duplicate = fixture(); duplicate.results = [...duplicate.results, duplicate.results[1]!];
  assert.equal(compareAgentStrategies(duplicate, "A", "B").complete, false);
  const assisted = fixture(); assisted.results[1]!.manualInterventions = 1;
  assert.equal(compareAgentStrategies(assisted, "A", "B").qualityPassed, false);
  const small = fixture(); small.results[1]!.usage!.inputTokens = 95;
  assert.equal(compareAgentStrategies(small, "A", "B").eligibleForDefault, false);
});

test("worker telemetry strips tool arguments, output and reasoning; metrics retain composition and batches", () => {
  const sensitive = "sk-never-emit-this-value";
  const call = { type: "function_call" as const, call_id: "one", name: "read_file", arguments: sensitive };
  const projected = projectBenchmarkEvent({ type: "tool_finished", call, output: JSON.stringify({ status: "error", error: sensitive }) });
  assert.ok(!JSON.stringify(projected).includes(sensitive));
  const response = projectBenchmarkEvent({ type: "response_received", response: { output_text: sensitive, output: [{ type: "reasoning", content: sensitive }, call] } });
  assert.ok(!JSON.stringify(response).includes(sensitive));
  const metrics = createBenchmarkMetricsCollector();
  metrics.onEvent(response!);
  metrics.onEvent({ type: "request_composition", instructionsBytes: 10, toolsBytes: 20, toolResultsBytes: 30, requestBytes: 100 });
  metrics.onEvent({ type: "tool_failure_repeated" });
  assert.deepEqual(metrics.snapshot().toolBatchSizes, [1]);
  assert.equal(metrics.snapshot().repeatedToolFailures, 1);
  assert.equal(metrics.snapshot().requestComposition!.count, 1);
});
