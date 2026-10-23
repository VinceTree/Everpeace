import type { BenchmarkHarnessAdapter, BenchmarkRunResult, BenchmarkSkippedRun, BenchmarkTask } from "./types.js";
import type { BenchmarkArtifactSink } from "./types.js";
import { runBenchmarkSuite } from "./runner.js";

export interface BenchmarkCampaignPlanItem {
  index: number;
  harness: string;
  taskId: string;
  repetition: number;
  pairId?: string;
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
  stopCode?: BenchmarkSkippedRun["reason"];
}

export interface BenchmarkCampaignOptions {
  campaignId: string;
  seed: number;
  repetitions: number;
  /** null explicitly disables the corresponding budget; usage is still measured. */
  taskTokenBudget: number | null;
  campaignTokenBudget: number | null;
  ordering?: "random" | "paired";
  liveApi: true;
  signal?: AbortSignal;
  artifactSink?: BenchmarkArtifactSink;
  /** Persist each settled run before another run may start. */
  onResult?(result: BenchmarkRunResult): Promise<void>;
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
  ordering: "random" | "paired" = "random",
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
  if (ordering === "paired") {
    if (harnesses.length !== 2) throw new Error("Paired campaigns require exactly two harnesses");
    const pairs = Array.from({ length: values.length / 2 }, (_, index) => values.slice(index * 2, index * 2 + 2));
    for (let index = pairs.length - 1; index > 0; index--) { const swap = Math.floor(next() * (index + 1)); [pairs[index], pairs[swap]] = [pairs[swap]!, pairs[index]!]; }
    return pairs.flatMap((pair, index) => (index % 2 ? [...pair].reverse() : pair).map(value => ({ ...value, pairId: `${value.taskId}:${value.repetition}` }))).map((value, index) => ({ index, ...value }));
  }
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
  if (options.taskTokenBudget !== null) positiveInteger(options.taskTokenBudget, "taskTokenBudget");
  if (options.campaignTokenBudget !== null) positiveInteger(options.campaignTokenBudget, "campaignTokenBudget");
  if (options.ordering === "paired" && (options.taskTokenBudget === null) !== (options.campaignTokenBudget === null)) throw new Error("Paired budgets must both be numeric or both explicitly null");
  const plan = createBenchmarkCampaignPlan(tasks, harnesses, options.repetitions, options.seed, options.ordering);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const harnessByName = new Map(harnesses.map((adapter) => [adapter.name, adapter]));
  const results: BenchmarkRunResult[] = [];
  let tokens = 0;
  let stopReason: string | undefined;
  let stopCode: BenchmarkSkippedRun["reason"] | undefined;
  for (const item of plan) {
    if (options.signal?.aborted) { stopReason = "Campaign was cancelled"; stopCode = "cancelled"; break; }
    const remaining = options.campaignTokenBudget === null ? null : options.campaignTokenBudget - tokens;
    const pairedBudget = options.ordering === "paired" && options.taskTokenBudget !== null;
    const required = pairedBudget ? options.taskTokenBudget! * (item.index % 2 === 0 ? 2 : 1) : 1;
    if (remaining !== null && remaining < required) { stopReason = "Campaign token budget cannot fund the next complete run or pair"; stopCode = "budget_exhausted"; break; }
    const task = taskById.get(item.taskId)!;
    const adapter = harnessByName.get(item.harness)!;
    const runBudget = pairedBudget ? options.taskTokenBudget : remaining === null ? options.taskTokenBudget : options.taskTokenBudget === null ? remaining : Math.min(remaining, options.taskTokenBudget);
    let suite;
    try { suite = await runBenchmarkSuite([task], adapter, {
      liveApi: true,
      totalTokenBudget: runBudget,
      taskTokenBudget: runBudget,
      campaignId: `${options.campaignId}-${item.index}`,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.artifactSink ? { artifactSink: options.artifactSink } : {}),
      prepareRun: (value) => options.prepareRun(value, item.harness, item.repetition),
    }); } catch {
      stopCode = "runtime_error";
      stopReason = "Campaign runner failed; retain settled records and pending runs";
      break;
    }
    const result = suite.results[0];
    if (!result) throw new Error(`Campaign item ${item.index} produced no result`);
    const repeated = { ...result, repetition: item.repetition, effectiveTokenBudget: runBudget, ...(item.pairId ? { pairId: item.pairId } : {}) };
    results.push(repeated);
    tokens += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
    try { await options.onResult?.(repeated); } catch {
      stopCode = "storage_failed"; stopReason = "Campaign result storage failed"; break;
    }
    if (result.storageFailed) { stopCode = "storage_failed"; stopReason = "Campaign artifact storage failed"; break; }
    if (result.cleanupFailed) {
      stopCode = "cleanup_failed";
      stopReason = "Campaign stopped because process cleanup failed";
      break;
    }
    if (result.preparationError) continue;
    if (result.isolationFailed) { stopReason = "Campaign stopped because native isolation failed"; stopCode = "isolation_failed"; break; }
    if (result.usage === undefined || result.usage.complete !== true) {
      stopCode = "usage_unknown";
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
      reason: stopCode ?? "runtime_error",
    }));
  return {
    campaignId: options.campaignId,
    seed: options.seed,
    planned: plan,
    results,
    skipped,
    tokenUsage: tokens,
    statisticsComplete: !stopCode && !options.signal?.aborted && results.length === plan.length && results.every((result) => result.usage?.complete === true && !result.preparationError && !result.cleanupFailed && !result.isolationFailed && !result.storageFailed),
    ...(stopReason ? { stopReason } : {}),
    ...(stopCode ? { stopCode } : {}),
  };
}
