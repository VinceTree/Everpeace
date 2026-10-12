import type { BenchmarkCampaignResult } from "./campaign.js";
import type { BenchmarkRunResult } from "./types.js";

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function tokens(run: BenchmarkRunResult): number | null {
  const usage = run.usage;
  return usage?.complete === true && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0
    ? usage.inputTokens + usage.outputTokens : null;
}
function summarize(runs: readonly BenchmarkRunResult[], planned: number) {
  const successful = runs.filter((run) => run.status === "passed");
  const known = runs.map(tokens);
  const totalKnownTokens = known.reduce<number>((sum, n) => sum + (n ?? 0), 0);
  return {
    planned, executed: runs.length, passed: successful.length, successRate: planned ? successful.length / planned : null,
    firstPassSuccesses: successful.filter((run) => run.firstVerificationSuiteStatus === "passed" && run.diagnosticRounds === 0).length,
    firstPassEvidenceComplete: runs.every((run) => run.firstVerificationSuiteStatus !== undefined && run.diagnosticRounds !== undefined),
    manualInterventions: runs.reduce((sum, run) => sum + run.manualInterventions, 0),
    unsafeActions: runs.reduce((sum, run) => sum + run.unsafeActions, 0),
    usageComplete: known.every((n) => n !== null), totalKnownTokens,
    tokensPerSuccessfulTaskIncludingFailures: successful.length && known.every((n) => n !== null) ? totalKnownTokens / successful.length : null,
    successfulTasks: successful.map((run) => {
      const composition = run.metrics.requestComposition;
      const share = (bytes: number) => composition && composition.requestBytes > 0 ? bytes / composition.requestBytes : null;
      return { taskId: run.taskId, repetition: run.repetition ?? 1, tokens: tokens(run), durationMs: run.durationMs, requestAttempts: run.requestAttempts ?? null, codingRequests: composition?.count ?? null, toolBatchSizes: run.metrics.toolBatchSizes ?? null, repeatedFailures: run.metrics.repeatedToolFailures ?? null, toolWait: run.metrics.timings.tool_wait ?? null, requestComposition: composition ? { ...composition, instructionsShare: share(composition.instructionsBytes), toolsShare: share(composition.toolsBytes), toolResultsShare: share(composition.toolResultsBytes), measurement: "UTF-8 JSON bytes; not token usage" } : null, cacheObservedInputTokens: run.usage?.cacheObservedInputTokens ?? null, cachedInputTokens: run.usage?.cachedInputTokens ?? null, reasoningTokens: run.usage?.reasoningTokens ?? null };
    }),
  };
}

/** Quality is gated on the frozen planned denominator, including failed/skipped runs. */
export function compareAgentStrategies(campaign: BenchmarkCampaignResult, baseline: string, candidate: string) {
  const planned = (name: string) => campaign.planned.filter((run) => run.harness === name);
  const runs = (name: string) => campaign.results.filter((run) => run.adapter === name);
  const a = runs(baseline), b = runs(candidate), pa = planned(baseline), pb = planned(candidate);
  const key = (run: { taskId: string; repetition?: number }) => `${run.taskId}:${run.repetition ?? 1}`;
  const baselineKeys = pa.map(key).sort();
  const candidateKeys = pb.map(key).sort();
  const balanced = baseline !== candidate && pa.length > 0 && JSON.stringify(baselineKeys) === JSON.stringify(candidateKeys)
    && new Set(baselineKeys).size === baselineKeys.length;
  const matchesPlan = (actual: BenchmarkRunResult[], expected: typeof pa) => actual.length === expected.length && new Set(actual.map(key)).size === actual.length && actual.every((run) => expected.some((item) => key(item) === key(run)));
  const complete = balanced && campaign.statisticsComplete && !campaign.stopReason && campaign.skipped.length === 0 && matchesPlan(a, pa) && matchesPlan(b, pb);
  const sa = summarize(a, pa.length), sb = summarize(b, pb.length);
  const perTask = [...new Set(pa.map((item) => item.taskId))].map((taskId) => ({ taskId, baselinePassed: a.filter((run) => run.taskId === taskId && run.status === "passed").length, candidatePassed: b.filter((run) => run.taskId === taskId && run.status === "passed").length }));
  const safetyPassed = [...a, ...b].every((run) => run.unsafeActions === 0 && !run.cleanupFailed && !(run.status === "passed" && (run.workflowOutcome !== "verified" || run.verification?.passed !== true)));
  const qualityPassed = complete && safetyPassed && sb.passed >= sa.passed && sb.manualInterventions <= sa.manualInterventions && perTask.every((task) => task.candidatePassed >= task.baselinePassed);
  const common = a.filter((run) => run.status === "passed").flatMap((run) => {
    const other = b.find((item) => key(item) === key(run) && item.status === "passed");
    const ta = tokens(run), tb = other ? tokens(other) : null;
    return other && ta !== null && tb !== null ? [{ taskId: run.taskId, repetition: run.repetition ?? 1, baselineTokens: ta, candidateTokens: tb, baselineDurationMs: run.durationMs, candidateDurationMs: other.durationMs }] : [];
  });
  const ma = median(common.map((run) => run.baselineTokens)), mb = median(common.map((run) => run.candidateTokens));
  const reduction = ma !== null && ma > 0 && mb !== null ? 1 - mb / ma : null;
  const usageComplete = sa.usageComplete && sb.usageComplete;
  const observedSavings = qualityPassed && usageComplete && ma !== null && ma > 0 && mb !== null && mb <= ma * 0.9;
  return { baseline: sa, candidate: sb, complete, safetyPassed, qualityPassed, usageComplete, perTask, commonSuccessfulPairs: common, commonBaselineTokenMedian: ma, commonCandidateTokenMedian: mb, tokenMedianReduction: reduction, observedSavings, eligibleForDefault: observedSavings, interpretation: observedSavings ? "Observed token savings on this endpoint and task sample; no general superiority claim." : "Insufficient evidence to enable candidate optimizations by default." };
}
