import { createHash } from "node:crypto";
import type { BenchmarkCampaignResult } from "./campaign.js";
export interface PublicBenchmarkReport {
  schema: 1; campaignId: string; evidence: "complete" | "insufficient"; planned: number | null;
  outcomes: { passed: number; failed: number; timedOut: number; error: number; cancelled: number; skipped: number };
  unknownUsage: number; realModelRuns: number;
  requests?: { sent: number | null; unknown: number | null; rejected: number | null };
  records: Array<{ taskId: string; runId: string; adapter: string; repetition: number; outcome: string; usage: "known" | "unknown" | "not_requested"; preparationOutcome?: string; model?: string; endpointId?: string; manualInterventions: number; codeDigest?: string; buildDigest?: string; evaluationDigest?: string; sourceType?: string }>;
  skipped: BenchmarkCampaignResult["skipped"]; notes: string[];
}
export function publicBenchmarkReport(campaign: BenchmarkCampaignResult, provenance: { codeDigest?: string; buildDigest?: string; evaluationDigest?: string; byAdapter?: Record<string, { codeDigest: string; buildDigest: string }>; realModelRuns: boolean; sourceTypes?: Record<string, string> }): PublicBenchmarkReport {
  const plannedIds = new Set(campaign.planned.map((item) => `${item.harness}\0${item.taskId}\0${item.repetition}`));
  if (plannedIds.size !== campaign.planned.length) throw new Error("Duplicate planned run identity");
  const seen = new Set<string>(); const outcomes = { passed: 0, failed: 0, timedOut: 0, error: 0, cancelled: 0, skipped: campaign.skipped.length };
  const records = campaign.results.map((result) => {
    const repetition = result.repetition ?? 1; const identity = `${result.adapter}\0${result.taskId}\0${repetition}`;
    if (!plannedIds.has(identity) || seen.has(identity)) throw new Error("Result lacks a unique planned run"); seen.add(identity);
    const outcome = result.terminalOutcome === "plan_cancelled" || /cancel|abort/iu.test(result.stopReason ?? "") || result.verification?.cancelled ? "cancelled" : result.status === "timed_out" ? "timedOut" : result.status;
    outcomes[outcome]++;
    const endpointId = result.capabilities?.baseUrl ? createHash("sha256").update(result.capabilities.baseUrl).digest("hex") : undefined;
    const artifactIdentity = provenance.byAdapter?.[result.adapter] ?? provenance;
    return { taskId: result.taskId, runId: `${campaign.campaignId}:${result.adapter}:${result.taskId}:${repetition}`, adapter: result.adapter, repetition, outcome, usage: result.preparationError ? "not_requested" as const : result.usage?.complete ? "known" as const : "unknown" as const, ...(result.capabilities?.model ? { model: result.capabilities.model } : {}), ...(endpointId ? { endpointId } : {}), manualInterventions: result.manualInterventions, ...(result.preparationOutcome ? { preparationOutcome: result.preparationOutcome } : {}), ...(artifactIdentity.codeDigest ? { codeDigest: artifactIdentity.codeDigest } : {}), ...(artifactIdentity.buildDigest ? { buildDigest: artifactIdentity.buildDigest } : {}), ...(provenance.evaluationDigest ? { evaluationDigest: provenance.evaluationDigest } : {}), ...(provenance.sourceTypes?.[result.taskId] ? { sourceType: provenance.sourceTypes[result.taskId] } : {}) };
  });
  for (const skip of campaign.skipped) {
    const identity = `${skip.adapter ?? ""}\0${skip.taskId}\0${skip.repetition}`;
    if (!plannedIds.has(identity) || seen.has(identity)) throw new Error("Skipped run overlaps or lacks a planned run"); seen.add(identity);
  }
  if (seen.size !== plannedIds.size) throw new Error("Unaccounted planned runs; denominator cannot be reduced");
  const completeProvenance = records.every((record) => record.codeDigest && record.buildDigest && record.evaluationDigest && record.model && record.endpointId);
  const sentRuns = campaign.results.filter(run => !run.preparationError);
  const counts = sentRuns.map(run => run.requestAccounting?.requests ?? run.requestAttempts);
  const sum = (values: Array<number | undefined>) => values.every(value => value !== undefined) ? values.reduce<number>((total, value) => total + value!, 0) : null;
  return { schema: 1, campaignId: campaign.campaignId, evidence: campaign.statisticsComplete && completeProvenance && !campaign.stopCode && !campaign.stopReason ? "complete" : "insufficient", planned: campaign.planned.length, outcomes, unknownUsage: records.filter((record) => record.usage === "unknown").length, realModelRuns: provenance.realModelRuns ? sentRuns.filter(run => (run.requestAccounting?.requests ?? run.requestAttempts ?? 0) > 0).length : 0, requests: { sent: sum(counts), unknown: sum(sentRuns.map(run => run.requestAccounting?.unknownRequests)), rejected: sum(sentRuns.map(run => run.requestAccounting?.rejectedRequests)) }, records, skipped: campaign.skipped, notes: ["Unknown Usage counts runs; request counts are separate and may be unavailable for historical evidence.", "Real model runs count runs with observed sent requests, including failures; preparation failures are excluded.", "Token admission budgets do not cap in-flight billing. Missing usage and prices prevent complete cost estimates.", "Synthetic fixtures are not evidence of real-world repository performance."] };
}
export function benchmarkMarkdown(report: PublicBenchmarkReport): string {
  const counts = report.outcomes;
  return ["# Benchmark evidence", "", `Success / planned: ${counts.passed} / ${report.planned ?? "unknown"}. Evidence: ${report.evidence}.`, "", `Failed ${counts.failed}; timed out ${counts.timedOut}; error ${counts.error}; cancelled ${counts.cancelled}; skipped ${counts.skipped}.`, "", `Unknown Usage: ${report.unknownUsage} recorded runs. Real model runs: ${report.realModelRuns}.`, "", "| Task | Run | Outcome | Usage | Model |", "| --- | --- | --- | --- | --- |", ...report.records.map((record) => `| ${record.taskId} | ${record.runId} | ${record.outcome} | ${record.usage} | ${record.model ?? "unavailable"} |`), "", ...report.notes.map((note) => `- ${note}`), ""].join("\n");
}
