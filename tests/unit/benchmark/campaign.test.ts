import { ProcessCleanupError } from "../../../src/tools/process-completion.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBenchmarkCampaignPlan, runBenchmarkCampaign } from "../../../src/benchmark/campaign.js";
import type { BenchmarkHarnessAdapter, BenchmarkTask } from "../../../src/benchmark/types.js";

const tasks: BenchmarkTask[] = [
  { id: "one", prompt: "one", workspacePath: process.cwd() },
  { id: "two", prompt: "two", workspacePath: process.cwd() },
];
const harnesses: BenchmarkHarnessAdapter[] = [
  { name: "current", async run() { return { usage: { inputTokens: 1, outputTokens: 1, complete: true } }; } },
  { name: "optimized", async run() { return { usage: { inputTokens: 1, outputTokens: 1, complete: true } }; } },
  { name: "dsh", async run() { return { usage: { inputTokens: 1, outputTokens: 1, complete: true } }; } },
];

test("campaign plans are reproducible and interleave every harness", () => {
  const first = createBenchmarkCampaignPlan(tasks, harnesses, 3, 42);
  const second = createBenchmarkCampaignPlan(tasks, harnesses, 3, 42);
  assert.deepEqual(first, second);
  assert.equal(first.length, 18);
  assert.deepEqual(new Set(first.map((item) => item.harness)), new Set(["current", "optimized", "dsh"]));
  assert.notDeepEqual(first.map((item) => item.harness), [...first].sort((left, right) => left.harness.localeCompare(right.harness)).map((item) => item.harness));
});

test("comparison schedules contain nine smoke and ninety formal runs", () => {
  const tenTasks = Array.from({ length: 10 }, (_, index): BenchmarkTask => ({ id: `task-${index}`, prompt: "fix", workspacePath: process.cwd() }));
  assert.equal(createBenchmarkCampaignPlan(tenTasks.slice(0, 3), harnesses, 1, 7).length, 9);
  assert.equal(createBenchmarkCampaignPlan(tenTasks, harnesses, 3, 7).length, 90);
});

test("campaign stops all harnesses after an unknown request attempt", async () => {
  let requests = 0;
  const adapter: BenchmarkHarnessAdapter = {
    name: "unknown",
    async run(_task, context) {
      requests += 1;
      context.requestAttemptLedger?.begin("coding");
      return {};
    },
  };
  const result = await runBenchmarkCampaign(tasks, [adapter], {
    campaignId: "test",
    seed: 1,
    repetitions: 1,
    liveApi: true,
    taskTokenBudget: 100,
    campaignTokenBudget: 1_000,
    async prepareRun(task) { return task; },
  });
  assert.equal(requests, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.statisticsComplete, false);
  assert.match(result.stopReason ?? "", /unknown usage/u);
});


test("preparation cleanup failure stops the entire campaign before another harness", async () => {
  let preparations = 0;
  const result = await runBenchmarkCampaign(tasks, harnesses, {
    campaignId: "cleanup-failure", seed: 1, repetitions: 1, liveApi: true,
    taskTokenBudget: 100, campaignTokenBudget: 1_000,
    async prepareRun() {
      preparations++;
      throw new ProcessCleanupError(new Error("termination refused"));
    },
  });
  assert.equal(preparations, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.cleanupFailed, true);
  assert.match(result.results[0]?.preparationError ?? "", /termination refused/u);
  assert.equal(result.skipped.length, 5);
  assert.ok(result.skipped.every((item) => item.reason === "cleanup_failed"));
  assert.equal(result.statisticsComplete, false);
});
