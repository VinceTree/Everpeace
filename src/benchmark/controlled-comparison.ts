import type { BenchmarkCampaignResult } from "./campaign.js";
import { compareAgentStrategies } from "./strategy-comparison.js";

/** Statistics reuse the recorded campaign denominator; unknown measurements stay unknown. */
export function controlledComparison(campaign: BenchmarkCampaignResult, baseline: string, candidate: string, experiment: "repair" | "team", realModelRuns: boolean) {
  const comparison = compareAgentStrategies(campaign, baseline, candidate);
  const measurements = (adapter: string) => {
    const runs = campaign.results.filter((run) => run.adapter === adapter);
    const sumKnown = (values: Array<number | undefined>) => values.length && values.every((v) => v !== undefined && Number.isFinite(v) && v >= 0) ? values.reduce<number>((n, v) => n + v!, 0) : null;
    return {
      wallMs: sumKnown(runs.map((run) => run.durationMs)),
      requests: sumKnown(runs.map((run) => run.requestAttempts)),
      duplicateReads: sumKnown(runs.map((run) => run.teamMetrics?.duplicateReads)),
      conflicts: sumKnown(runs.map((run) => run.teamMetrics?.conflicts)),
      independentFailures: runs.filter((run) => run.verification?.attempted && !run.verification.passed).length,
      // A failed task is not evidence that an edit was erroneous. This metric
      // needs a task-specific external regression/range classification.
      errorModificationRate: null,
    };
  };
  const a = measurements(baseline), b = measurements(candidate);
  const enough = comparison.perTask.every((task) => campaign.planned.filter((run) => run.harness === baseline && run.taskId === task.taskId).length >= 3);
  return { schema: 1, experiment, realModelRuns, comparison, measurements: { baseline: a, candidate: b }, sufficientRepetitions: enough,
    eligibleForDefault: false,
    interpretation: !realModelRuns ? "Offline accounting/scorer proof only; no model benefit measured." : "Task-specific erroneous-edit classification remains required; do not recommend an automatic policy change from this report." };
}
