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
      errorModificationRate: runs.length > 0 && runs.every(run => run.editClassification?.state === "clean" || run.editClassification?.state === "erroneous") ? runs.filter(run => run.editClassification?.state === "erroneous").length / runs.length : null,
      unknownEditClassifications: runs.filter(run => !run.editClassification || run.editClassification.state === "unknown").length,
      wallMsPerSuccessfulTaskIncludingFailures: runs.some(run => run.status === "passed") ? runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.filter(run => run.status === "passed").length : null,
      successRate95PercentInterval: successInterval(runs.filter(run => run.status === "passed").length, campaign.planned.filter(run => run.harness === adapter).length),
    };
  };
  const a = measurements(baseline), b = measurements(candidate);
  const enough = comparison.perTask.length >= 12 && comparison.perTask.every((task) => campaign.planned.filter((run) => run.harness === baseline && run.taskId === task.taskId).length >= 5);
  const ta = comparison.baseline.tokensPerSuccessfulTaskIncludingFailures, tb = comparison.candidate.tokensPerSuccessfulTaskIncludingFailures;
  const wa = a.wallMsPerSuccessfulTaskIncludingFailures, wb = b.wallMsPerSuccessfulTaskIncludingFailures;
  const tokenRatio = ta !== null && ta > 0 && tb !== null ? tb / ta : null;
  const wallRatio = wa !== null && wa > 0 && wb !== null ? wb / wa : null;
  const qualityPassed = comparison.qualityPassed && a.errorModificationRate !== null && b.errorModificationRate !== null && b.errorModificationRate <= a.errorModificationRate;
  const efficiencyPassed = tokenRatio !== null && wallRatio !== null && tokenRatio <= 1 && wallRatio <= 1 && (tokenRatio <= 0.9 || wallRatio <= 0.9);
  const teamExecuted = experiment !== "team" || campaign.results.filter(run => run.adapter === candidate).every(run => (run.teamMetrics?.members ?? 0) >= 2);
  const eligibleForDefault = realModelRuns && enough && comparison.complete && comparison.usageComplete && qualityPassed && efficiencyPassed && teamExecuted;
  const categories = [...new Set(campaign.results.flatMap(run => run.tags ?? []))].map(tag => {
    const ids = new Set(campaign.results.filter(run => run.tags?.includes(tag)).map(run => run.taskId));
    const subset={ ...campaign, planned: campaign.planned.filter(run => ids.has(run.taskId)), results: campaign.results.filter(run => ids.has(run.taskId)), skipped: campaign.skipped.filter(run => ids.has(run.taskId)) };
    const result=compareAgentStrategies(subset,baseline,candidate),aRuns=subset.results.filter(run=>run.adapter===baseline),bRuns=subset.results.filter(run=>run.adapter===candidate);
    const cost=(runs:typeof aRuns)=>{const passed=runs.filter(run=>run.status==='passed').length;return passed?runs.reduce((sum,run)=>sum+run.durationMs,0)/passed:null;};
    const timeA=cost(aRuns),timeB=cost(bRuns),tokensA=result.baseline.tokensPerSuccessfulTaskIncludingFailures,tokensB=result.candidate.tokensPerSuccessfulTaskIncludingFailures;
    const tokens=tokensA!==null&&tokensA>0&&tokensB!==null?tokensB/tokensA:null,time=timeA!==null&&timeA>0&&timeB!==null?timeB/timeA:null;
    const editRate=(runs:typeof aRuns)=>runs.length&&runs.every(run=>run.editClassification?.state==='clean'||run.editClassification?.state==='erroneous')?runs.filter(run=>run.editClassification?.state==='erroneous').length/runs.length:null;
    const errorA=editRate(aRuns),errorB=editRate(bRuns);
    const repetitions=ids.size>=2&&[...ids].every(id=>subset.planned.filter(run=>run.harness===baseline&&run.taskId===id).length>=5);
    const quality=result.qualityPassed&&errorA!==null&&errorB!==null&&errorB<=errorA;
    const efficiency=tokens!==null&&time!==null&&tokens<=1&&time<=1&&(tokens<=0.9||time<=0.9);
    const team=experiment!=='team'||bRuns.every(run=>(run.teamMetrics?.members??0)>=2);
    return {tag,tasks:ids.size,comparison:result,tokenRatio:tokens,wallRatio:time,errorModificationRate:{baseline:errorA,candidate:errorB},eligibleForRecommendation:realModelRuns&&repetitions&&result.complete&&result.usageComplete&&quality&&efficiency&&team};
  });
  return { schema: 2, experiment, realModelRuns, comparison, measurements: { baseline: a, candidate: b }, sufficientRepetitions: enough, qualityPassed, efficiencyPassed, tokenRatio, wallRatio, teamExecuted, categories,
    eligibleForDefault,
    interpretation: !realModelRuns ? "Offline accounting/scorer proof only; no model benefit measured." : eligibleForDefault ? "Observed benefit on this frozen model and task sample. Configuration remains explicit; no general superiority claim." : "Quality, completeness, repetition or efficiency gate not met; retain the baseline." };
}

function successInterval(passed: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.96, p = passed / total, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
