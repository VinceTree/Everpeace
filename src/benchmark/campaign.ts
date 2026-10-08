import type { BenchmarkHarnessAdapter, BenchmarkRunResult, BenchmarkSkippedRun, BenchmarkTask } from "./types.js";
import type { BenchmarkArtifactSink } from "./types.js";
import { runBenchmarkSuite } from "./runner.js";

export interface BenchmarkCampaignPlanItem {
  index: number;
  harness: string;
  taskId: string;
  repetition: number;
}

export interface BenchmarkCampaignResult {
  campaignId: string;
  seed: number;
  planned: readonly BenchmarkCampaignPlanItem[];
  results: readonly BenchmarkRunResult[];
  skipped: readonly BenchmarkSkippedRun[];
  tokenUsage: number;
  statisticsComplete: boolean;
  stopReason?: string;
}

export interface BenchmarkCampaignOptions {
  campaignId: string;
  seed: number;
  repetitions: number;
  taskTokenBudget: number;
  campaignTokenBudget: number;
  liveApi: true;
  signal?: AbortSignal;
  artifactSink?: BenchmarkArtifactSink;
  prepareRun(task: BenchmarkTask, harness: string, repetition: number): Promise<BenchmarkTask>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function random(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/** Create and record one randomized Cartesian run plan before any model request is admitted. */
export function createBenchmarkCampaignPlan(
  tasks: readonly BenchmarkTask[],
  harnesses: readonly BenchmarkHarnessAdapter[],
  repetitions: number,
  seed: number,
): BenchmarkCampaignPlanItem[] {
  positiveInteger(repetitions, "repetitions");
  if (!Number.isSafeInteger(seed)) throw new Error("seed must be an integer");
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("Campaign task IDs must be unique");
  if (new Set(harnesses.map((adapter) => adapter.name)).size !== harnesses.length) throw new Error("Campaign harness names must be unique");
  const values: Omit<BenchmarkCampaignPlanItem, "index">[] = [];
  for (const task of tasks) for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const adapter of harnesses) values.push({ harness: adapter.name, taskId: task.id, repetition });
  }
  const next = random(seed);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [values[index], values[swap]] = [values[swap]!, values[index]!];
  }
  return values.map((value, index) => ({ index, ...value }));
}

/** Run a pre-recorded campaign and stop globally after unknown usage, cancellation, or budget exhaustion. */
export async function runBenchmarkCampaign(
  tasks: readonly BenchmarkTask[],
  harnesses: readonly BenchmarkHarnessAdapter[],
  options: BenchmarkCampaignOptions,
): Promise<BenchmarkCampaignResult> {
  positiveInteger(options.taskTokenBudget, "taskTokenBudget");
  positiveInteger(options.campaignTokenBudget, "campaignTokenBudget");
  const plan = createBenchmarkCampaignPlan(tasks, harnesses, options.repetitions, options.seed);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const harnessByName = new Map(harnesses.map((adapter) => [adapter.name, adapter]));
  const results: BenchmarkRunResult[] = [];
  let tokens = 0;
  let stopReason: string | undefined;
  for (const item of plan) {
    if (options.signal?.aborted) { stopReason = "Campaign was cancelled"; break; }
    const remaining = options.campaignTokenBudget - tokens;
    if (remaining <= 0) { stopReason = "Campaign token budget was exhausted"; break; }
    const task = taskById.get(item.taskId)!;
    const adapter = harnessByName.get(item.harness)!;
    const runBudget = Math.min(remaining, options.taskTokenBudget);
    const suite = await runBenchmarkSuite([task], adapter, {
      liveApi: true,
      totalTokenBudget: runBudget,
      taskTokenBudget: runBudget,
      campaignId: `${options.campaignId}-${item.index}`,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.artifactSink ? { artifactSink: options.artifactSink } : {}),
      prepareRun: (value) => options.prepareRun(value, item.harness, item.repetition),
    });
    const result = suite.results[0];
    if (!result) throw new Error(`Campaign item ${item.index} produced no result`);
    const repeated = { ...result, repetition: item.repetition };
    results.push(repeated);
    if (result.cleanupFailed) {
      tokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      stopReason = "Campaign stopped because process cleanup failed";
      break;
    }
    if (result.preparationError) continue;
    tokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
    if (result.usage === undefined || result.usage.complete !== true) {
      stopReason = "Campaign stopped because a model request had unknown usage";
      break;
    }
  }
  const completed = new Set(results.map((result) => `${result.adapter}\0${result.taskId}\0${result.repetition ?? 1}`));
  const skipped = plan
    .filter((item) => !completed.has(`${item.harness}\0${item.taskId}\0${item.repetition}`))
    .map((item): BenchmarkSkippedRun => ({
      adapter: item.harness,
      taskId: item.taskId,
      repetition: item.repetition,
      reason: stopReason?.includes("cleanup") ? "cleanup_failed"
        : stopReason?.includes("unknown") ? "usage_unknown"
        : stopReason?.includes("cancel") ? "cancelled"
          : "budget_exhausted",
    }));
  return {
    campaignId: options.campaignId,
    seed: options.seed,
    planned: plan,
    results,
    skipped,
    tokenUsage: tokens,
    statisticsComplete: results.length === plan.length && results.every((result) => result.usage?.complete === true && !result.cleanupFailed),
    ...(stopReason ? { stopReason } : {}),
  };
}
