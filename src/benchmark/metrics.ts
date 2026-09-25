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
  let responses = 0;
  let toolCalls = 0;
  let toolFailures = 0;
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
        case "response_received":
          responses += 1;
          break;
        case "tool_started":
          toolCalls += 1;
          break;
        case "tool_finished":
          if (isFailureOutput(event.output)) toolFailures += 1;
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
        responses,
        toolCalls,
        toolFailures,
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
