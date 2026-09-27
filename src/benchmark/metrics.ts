import type { LoopEvent, LoopPhase } from "../agent/agent-loop.js";
import type { BenchmarkMetricsSnapshot } from "./types.js";

const isFailureOutput = (output: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(output);
    return typeof parsed === "object"
      && parsed !== null
      && "status" in parsed
      && (parsed.status === "error" || parsed.status === "cancelled");
  } catch {
    return false;
  }
};

export interface BenchmarkMetricsCollector {
  onPhase(phase: LoopPhase): void;
  onEvent(event: LoopEvent): void;
  snapshot(now?: number): BenchmarkMetricsSnapshot;
}

export function createBenchmarkMetricsCollector(now: () => number = Date.now): BenchmarkMetricsCollector {
  const startedAt = now();
  const phases: LoopPhase[] = [];
  const startedTools = new Set<string>();
  const finishedTools = new Set<string>();
  const toolResultOrder: string[] = [];
  let samplingAttempts = 0;
  let responses = 0;
  let responseRejections = 0;
  let incompleteResponses = 0;
  let invalidToolCalls = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let toolFailures = 0;
  let toolBatches = 0;
  let firstToolStartDelayMs: number | null = null;
  let retries = 0;
  let streamRecoveries = 0;
  let successfulStreamRecoveries = 0;
  let compactions = 0;
  let cancellations = 0;
  let steeringApplications = 0;

  return {
    onPhase(phase) {
      phases.push(phase);
      if (phase === "cancelled") cancellations += 1;
    },
    onEvent(event) {
      switch (event.type) {
        case "sampling_started":
          samplingAttempts += 1;
          break;
        case "response_received":
          responses += 1;
          break;
        case "response_rejected":
          responseRejections += 1;
          if (event.reason === "incomplete") incompleteResponses += 1;
          if (event.reason === "invalid_tool_call") invalidToolCalls += 1;
          break;
        case "tool_started": {
          toolCalls += 1;
          startedTools.add(event.call.call_id);
          if (firstToolStartDelayMs === null) firstToolStartDelayMs = Math.max(0, now() - startedAt);
          break;
        }
        case "tool_finished":
          toolResults += 1;
          finishedTools.add(event.call.call_id);
          toolResultOrder.push(event.call.call_id);
          if (isFailureOutput(event.output)) toolFailures += 1;
          break;
        case "tool_batch_started":
          toolBatches += 1;
          break;
        case "retrying":
          retries += 1;
          break;
        case "stream_recovery_started":
          streamRecoveries += 1;
          break;
        case "stream_recovery_finished":
          if (event.success === true) successfulStreamRecoveries += 1;
          break;
        case "compaction_completed":
          compactions += 1;
          break;
        case "steering_applied":
          steeringApplications += 1;
          break;
        default:
          break;
      }
    },
    snapshot(end = now()) {
      return {
        durationMs: Math.max(0, end - startedAt),
        phases: [...phases],
        samplingAttempts,
        responses,
        responseRejections,
        incompleteResponses,
        invalidToolCalls,
        toolCalls,
        toolResults,
        unclosedToolCalls: [...startedTools].filter((callId) => !finishedTools.has(callId)).length,
        toolFailures,
        toolBatches,
        toolResultOrder: [...toolResultOrder],
        firstToolStartDelayMs,
        retries,
        streamRecoveries,
        successfulStreamRecoveries,
        compactions,
        cancellations,
        steeringApplications,
      };
    },
  };
}
