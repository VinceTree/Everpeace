// TypeScript adaptation of OpenAI Codex's sampling/follow-up control flow.
// Upstream revision and differences: docs/architecture/AGENT_LOOP.md.
// Copyright 2025 OpenAI. Licensed under Apache-2.0; see third_party/codex/LICENSE.
import { setTimeout as delay } from "node:timers/promises";
import type { TokenUsageSample } from "../status/model-status.js";
export interface LoopResponse {
  output: Array<Record<string, unknown>>;
  output_text: string;
  end_turn?: boolean;
  status?: string;
}

export interface ToolCall extends Record<string, unknown> {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export type LoopPhase = "sampling" | "tools" | "completed" | "cancelled" | "failed";

export type LoopEvent =
  | { type: "sampling_started" }
  | { type: "response_received"; response: LoopResponse }
  | { type: "tool_started"; call: ToolCall }
  | { type: "tool_finished"; call: ToolCall; output: string }
  | { type: "steering_applied"; count: number }
  | { type: "retrying"; attempt: number; delayMs: number }
  | { type: "compaction_started"; automatic: boolean }
  | { type: "compaction_completed"; automatic: boolean; usage: TokenUsageSample | null };

export class LoopSteeredError extends Error {
  constructor() {
    super("Sampling was interrupted by new user guidance");
    this.name = "LoopSteeredError";
  }
}

export interface AgentLoopOptions {
  sample(): Promise<LoopResponse>;
  record(items: readonly Record<string, unknown>[]): Promise<void>;
  dispatch(call: ToolCall): Promise<string | { output: string; stop?: boolean }>;
  assistant(text: string): void;
  signal?: AbortSignal;
  onPhase?(phase: LoopPhase): void;
  onEvent?(event: LoopEvent): void;
  applySteering?(): Promise<number>;
  maxRetries?: number;
  retryDelayMs?: number;
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, name, retryable: explicitlyRetryable } = error as {
    status?: unknown;
    name?: unknown;
    retryable?: unknown;
  };
  if (name === "ContextCompactionError") return false;
  return explicitlyRetryable === true || status === 408 || status === 409 || status === 429 ||
    (typeof status === "number" && status >= 500 && status <= 599) ||
    name === "APIConnectionError" || name === "APIConnectionTimeoutError";
}

async function sample(options: AgentLoopOptions): Promise<LoopResponse> {
  const maxRetries = options.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await options.sample();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (attempt >= maxRetries || !retryable(error)) throw error;
      const delayMs = Math.min(10_000, (options.retryDelayMs ?? 250) * 2 ** attempt);
      options.onEvent?.({ type: "retrying", attempt: attempt + 1, delayMs });
      await delay(delayMs, undefined,
        options.signal ? { signal: options.signal } : {});
    }
  }
}

/** Keep transport, tool permissions, and durable history outside turn control. */
export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const { signal } = options;
  try {
    while (true) {
      signal?.throwIfAborted();
      options.onPhase?.("sampling");
      options.onEvent?.({ type: "sampling_started" });
      let response: LoopResponse;
      try {
        response = await sample(options);
      } catch (error) {
        if (error instanceof LoopSteeredError) {
          const count = await options.applySteering?.() ?? 0;
          if (count > 0) options.onEvent?.({ type: "steering_applied", count });
          continue;
        }
        throw error;
      }
      signal?.throwIfAborted();
      if (response.status && response.status !== "completed") {
        throw new Error(`Model response did not complete: ${response.status}`);
      }
      const calls = response.output.filter((item) => item.type === "function_call");
      const ids = new Set<string>();
      for (let callIndex = 0; callIndex < calls.length; callIndex++) {
        const call = calls[callIndex]!;
        if (typeof call.call_id !== "string" || !call.call_id || ids.has(call.call_id)) {
          throw new Error("Tool call has a missing or duplicate call_id");
        }
        ids.add(call.call_id);
      }
      // Never execute a side effect until its request is durably recorded.
      await options.record(response.output);
      options.onEvent?.({ type: "response_received", response });
      const responseSteeringCount = await options.applySteering?.() ?? 0;
      if (responseSteeringCount > 0) {
        for (const call of calls) {
          await options.record([{ type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ status: "steered" }) }]);
        }
        options.onEvent?.({ type: "steering_applied", count: responseSteeringCount });
        continue;
      }
      if (response.output_text.trim()) options.assistant(response.output_text.trim());
      if (calls.length) options.onPhase?.("tools");
      let stopAfterTools = false;
      for (let callIndex = 0; callIndex < calls.length; callIndex++) {
        const call = calls[callIndex]!;
        options.onEvent?.({ type: "tool_started", call: call as ToolCall });
        let output: string;
        try {
          signal?.throwIfAborted();
          const result = typeof call.name === "string" && typeof call.arguments === "string"
            ? await options.dispatch(call as ToolCall)
            : JSON.stringify({ status: "error", error: "Invalid tool call fields" });
          output = typeof result === "string" ? result : result.output;
          stopAfterTools = typeof result === "object" && result.stop === true;
        } catch (error) {
          output = JSON.stringify(signal?.aborted
            ? { status: "cancelled" }
            : { status: "error", error: error instanceof Error ? error.message : String(error) });
        }
        // Checkpoint each result; a later interrupted tool cannot erase it.
        await options.record([{ type: "function_call_output", call_id: call.call_id, output }]);
        options.onEvent?.({ type: "tool_finished", call: call as ToolCall, output });
        if (stopAfterTools) {
          for (const skipped of calls.slice(callIndex + 1)) {
            await options.record([{ type: "function_call_output", call_id: skipped.call_id, output: JSON.stringify({ status: "skipped" }) }]);
          }
          break;
        }
        const steeringCount = await options.applySteering?.() ?? 0;
        if (steeringCount > 0) {
          for (const skipped of calls.slice(callIndex + 1)) {
            await options.record([{ type: "function_call_output", call_id: skipped.call_id, output: JSON.stringify({ status: "steered" }) }]);
          }
          options.onEvent?.({ type: "steering_applied", count: steeringCount });
          break;
        }
      }
      signal?.throwIfAborted();
      if (stopAfterTools) {
        options.onPhase?.("completed");
        return;
      }
      const needsFollowUp = calls.length > 0 || response.end_turn === false;
      if (!needsFollowUp) {
        options.onPhase?.("completed");
        return;
      }
    }
  } catch (error) {
    options.onPhase?.(signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}
