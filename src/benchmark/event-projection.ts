import type { LoopEvent } from "../agent/agent-loop.js";

/** Worker telemetry contains only metrics, never request/response or tool bodies. */
export function projectBenchmarkEvent(event: LoopEvent): LoopEvent | undefined {
  switch (event.type) {
    case "request_composition": case "timing_recorded": case "tool_failure_repeated":
    case "sampling_started": case "model_progress": case "response_rejected":
    case "retrying": case "stream_recovery_started": case "stream_recovery_finished":
    case "steering_applied": return event;
    case "compaction_completed": return { type: event.type, automatic: event.automatic, usage: null };
    case "response_received": return { type: event.type, response: { output_text: "", output: event.response.output.filter((item) => item.type === "function_call").map(() => ({ type: "function_call" })) } };
    case "tool_started": return { type: event.type, call: { type: "function_call", call_id: event.call.call_id, name: "tool", arguments: "" } };
    case "tool_finished": {
      let failure = false;
      try {
        const result = JSON.parse(event.output) as Record<string, unknown>;
        failure = ["error", "denied", "rejected", "cancelled"].includes(String(result.status)) || !!result.error || typeof result.exit_code === "number" && result.exit_code !== 0;
      } catch { /* Non-JSON output is not inferred to be a failure. */ }
      return { type: event.type, call: { type: "function_call", call_id: event.call.call_id, name: "tool", arguments: "" }, output: JSON.stringify({ status: failure ? "error" : "ok" }) };
    }
    case "tool_batch_started": return { type: event.type, calls: [] };
    default: return undefined;
  }
}
