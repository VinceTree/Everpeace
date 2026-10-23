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

test("a native isolation failure stops the stage and leaves later runs in its denominator", async () => {
  let runs = 0;
  const adapter: BenchmarkHarnessAdapter = { name: "team", async run() { runs++; return { isolationFailed: true, usage: { inputTokens: 1, outputTokens: 1, complete: true } }; } };
  const result = await runBenchmarkCampaign(tasks, [adapter], { campaignId: "isolation", seed: 1, repetitions: 1, liveApi: true, taskTokenBudget: 100, campaignTokenBudget: 1000, async prepareRun(task) { return task; } });
  assert.equal(runs, 1); assert.equal(result.results[0]?.status, "failed"); assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, "isolation_failed"); assert.equal(result.statisticsComplete, false);
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

test("unlimited campaigns stop globally after unknown usage", async () => {
  let calls = 0;
  const result = await runBenchmarkCampaign(tasks, [{ name: "unlimited", async run() { calls++; return { usage: { inputTokens: 10, outputTokens: 2, complete: false } }; } }], { campaignId: "unknown-null", seed: 1, repetitions: 1, liveApi: true, taskTokenBudget: null, campaignTokenBudget: null, prepareRun: async task => task });
  assert.equal(calls, 1); assert.equal(result.tokenUsage, 12); assert.equal(result.stopCode, "usage_unknown");
  assert.equal(result.skipped[0]?.reason, "usage_unknown");
});

test("paired admission reserves equal full arm budgets and retains unfinished pairs", async () => {
  const budgets: number[] = [];
  const arms = ["a", "b"].map(name => ({ name, async run(_task: BenchmarkTask, context: import("../../../src/benchmark/types.js").BenchmarkHarnessContext) { budgets.push(context.tokenBudgetRemaining!); return { usage: { inputTokens: 120, outputTokens: 0, complete: true } }; } }));
  const options = { campaignId: "paired", seed: 1, repetitions: 1, ordering: "paired" as const, liveApi: true as const, taskTokenBudget: 100, prepareRun: async (task: BenchmarkTask) => task };
  const insufficient = await runBenchmarkCampaign(tasks.slice(0, 1), arms, { ...options, campaignTokenBudget: 199 });
  assert.equal(insufficient.results.length, 0); assert.equal(insufficient.skipped.length, 2);
  const overrun = await runBenchmarkCampaign(tasks.slice(0, 1), arms, { ...options, campaignTokenBudget: 200 });
  assert.deepEqual(budgets, [100]); assert.equal(overrun.results[0]?.effectiveTokenBudget, 100);
  assert.equal(overrun.results[0]?.pairId, "one:1"); assert.equal(overrun.tokenUsage, 120); assert.equal(overrun.stopCode, "budget_exhausted");
});

test("result persistence failure stops admission and preserves settled usage", async () => {
  let calls = 0;
  const result = await runBenchmarkCampaign(tasks, [{ name: "a", async run() { calls++; return { usage: { inputTokens: 1, outputTokens: 2, complete: true } }; } }], { campaignId: "storage", seed: 1, repetitions: 1, liveApi: true, taskTokenBudget: 100, campaignTokenBudget: 1000, prepareRun: async task => task, async onResult() { throw Error("disk failure"); } });
  assert.equal(calls, 1); assert.equal(result.results.length, 1); assert.equal(result.tokenUsage, 3);
  assert.equal(result.stopCode, "storage_failed"); assert.equal(result.statisticsComplete, false);
});
