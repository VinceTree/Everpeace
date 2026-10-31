import type { RequestAttemptLedgerSnapshot } from "../agent/request-attempt-ledger.js";
import type { BenchmarkRunResult, BenchmarkTokenUsage } from "./types.js";

export function benchmarkRequestAccounting(snapshot: RequestAttemptLedgerSnapshot): NonNullable<BenchmarkRunResult["requestAccounting"]> {
  const reasons: Record<string, number> = {};
  const sent = snapshot.attempts.filter(attempt => attempt.status !== "rejected");
  for (const attempt of sent) if (attempt.usage === null) {
    const reason = `${attempt.purpose}:${attempt.unknownReason ?? "unclassified"}`;
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { requests: sent.length, unknownRequests: sent.filter(attempt => attempt.usage === null).length, rejectedRequests: snapshot.attempts.length - sent.length, reasons };
}

export function benchmarkLedgerUsage(snapshot: RequestAttemptLedgerSnapshot): BenchmarkTokenUsage {
  const samples = snapshot.attempts.filter(attempt => attempt.status !== "rejected").map(attempt => attempt.usage);
  const cached = samples.filter(sample => sample?.cached_input_tokens !== undefined);
  return {
    inputTokens: snapshot.inputTokens, outputTokens: snapshot.outputTokens, reasoningTokens: snapshot.reasoningTokens, complete: snapshot.complete,
    ...(cached.length ? { cachedInputTokens: cached.reduce((sum, sample) => sum + sample!.cached_input_tokens!, 0), cacheObservedInputTokens: cached.reduce((sum, sample) => sum + (sample!.cache_observed_input_tokens ?? sample!.input_tokens), 0) } : {}),
  };
}
