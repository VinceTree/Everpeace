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

export type SamplingErrorCategory =
  | "connection"
  | "timeout"
  | "rate_limit"
  | "server"
  | "stream_incomplete"
  | "context_limit"
  | "permanent";

export type LoopEvent =
  | { type: "sampling_started" }
  | { type: "response_received"; response: LoopResponse }
  | { type: "response_rejected"; reason: "incomplete" | "invalid_tool_call" }
  | { type: "tool_started"; call: ToolCall }
  | { type: "tool_finished"; call: ToolCall; output: string }
  | { type: "steering_applied"; count: number }
  | { type: "retrying"; attempt: number; delayMs: number; category?: SamplingErrorCategory }
  | { type: "tool_batch_started"; calls: ToolCall[] }
  | { type: "tool_batch_finished"; calls: ToolCall[]; outputs: string[] }
  | { type: "stream_recovery_started" }
  | { type: "stream_recovery_finished"; success?: boolean }
  | { type: "compaction_started"; automatic: boolean }
  | { type: "compaction_completed"; automatic: boolean; usage: TokenUsageSample | null };

export class LoopSteeredError extends Error {
  constructor() {
    super("Sampling was interrupted by new user guidance");
    this.name = "LoopSteeredError";
  }
}
export interface ToolCapabilities {
  readOnly: boolean;
  idempotent: boolean;
  parallelSafe: boolean;
  resourceKeys: readonly string[];
}

export type ToolCapabilityResolver = (call: ToolCall) => ToolCapabilities | undefined;

export interface AgentLoopOptions {
  sample(): Promise<LoopResponse>;
  record(items: readonly Record<string, unknown>[]): Promise<void>;
  dispatch(call: ToolCall): Promise<string | { output: string; stop?: boolean }>;
  assistant(text: string): void;
  signal?: AbortSignal;
  onPhase?(phase: LoopPhase): void;
  onEvent?(event: LoopEvent): void;
  prepareStep?(): Promise<void>;
  applySteering?(): Promise<number>;
  maxRetries?: number;
  retryDelayMs?: number;
  retryBudgets?: {
    sampling?: number;
    streamRecovery?: number;
    compaction?: number;
  };
  toolCapabilities?(call: ToolCall): ToolCapabilities | undefined;
  canRunInParallel?(call: ToolCall): boolean;
}

function canRunInParallel(options: AgentLoopOptions, call: ToolCall): boolean {
  const capabilities = options.toolCapabilities?.(call);
  if (capabilities) return capabilities.readOnly && capabilities.idempotent && capabilities.parallelSafe;
  return options.canRunInParallel?.(call) === true;
}

function resourcesCanShare(options: AgentLoopOptions, batch: readonly ToolCall[], candidate: ToolCall): boolean {
  const resolver = options.toolCapabilities;
  if (!resolver) return true;
  const candidateCapabilities = resolver(candidate);
  if (!candidateCapabilities) return true;
  for (const existing of batch) {
    const existingCapabilities = resolver(existing);
    if (!existingCapabilities) continue;
    const shared = existingCapabilities.resourceKeys.some((key) => candidateCapabilities.resourceKeys.includes(key));
    if (shared) return false;
  }
  return true;
}

export function classifySamplingError(error: unknown): SamplingErrorCategory {
  if (!error || typeof error !== "object") return "permanent";
  const { status, name, retryable: explicitlyRetryable } = error as {
    status?: unknown;
    name?: unknown;
    retryable?: unknown;
  };
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toLowerCase() : "";
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (name === "ContextCompactionError" || code.includes("context") || /context.{0,20}(?:length|window)|too many input tokens/.test(text)) return "context_limit";
  if (name === "ResponseStreamIncompleteError" || code.includes("stream") && /incomplete|eof|ended|closed/.test(text)) return "stream_incomplete";
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError" || status === 408 || /timed? ?out|timeout/.test(text)) return "timeout";
  if (status === 429 || code.includes("rate_limit") || /rate limit|too many requests/.test(text)) return "rate_limit";
  if (name === "APIConnectionError" || /connection|socket|econn|network|fetch failed/.test(text)) return "connection";
  if (status === 409 || (typeof status === "number" && status >= 500 && status <= 599) || code.includes("server_error")) return "server";
  if (explicitlyRetryable === true) return "connection";
  return "permanent";
}

function retryable(category: SamplingErrorCategory): boolean {
  return category !== "permanent" && category !== "context_limit";
}

async function sample(
  options: AgentLoopOptions,
  budget: { remaining: number; total: number },
): Promise<LoopResponse> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await options.sample();
    } catch (error) {
      options.signal?.throwIfAborted();
      const category = classifySamplingError(error);
      if (budget.remaining <= 0 || !retryable(category)) throw error;
      budget.remaining -= 1;
      const delayMs = Math.min(10_000, (options.retryDelayMs ?? 250) * 2 ** attempt);
      options.onEvent?.({ type: "retrying", attempt: budget.total - budget.remaining, delayMs, category });
      await delay(delayMs, undefined,
        options.signal ? { signal: options.signal } : {});
    }
  }
}

/** Keep transport, tool permissions, and durable history outside turn control. */
export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const { signal } = options;
  const samplingBudget = {
    remaining: Math.max(0, options.retryBudgets?.sampling ?? options.maxRetries ?? 2),
    total: Math.max(0, options.retryBudgets?.sampling ?? options.maxRetries ?? 2),
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      await options.prepareStep?.();
      options.onPhase?.("sampling");
      options.onEvent?.({ type: "sampling_started" });
      let response: LoopResponse;
      try {
        response = await sample(options, samplingBudget);
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
        options.onEvent?.({ type: "response_rejected", reason: "incomplete" });
        throw new Error(`Model response did not complete: ${response.status}`);
      }
      const calls = response.output.filter((item) => item.type === "function_call");
      const ids = new Set<string>();
      for (let callIndex = 0; callIndex < calls.length; callIndex++) {
        const call = calls[callIndex]! as Partial<ToolCall>;
        if (typeof call.call_id !== "string" || !call.call_id || typeof call.name !== "string" || !call.name || typeof call.arguments !== "string") {
          options.onEvent?.({ type: "response_rejected", reason: "invalid_tool_call" });
          throw new Error("Tool call has invalid fields");
        }
        if (ids.has(call.call_id)) {
          options.onEvent?.({ type: "response_rejected", reason: "invalid_tool_call" });
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
        const call = calls[callIndex]! as ToolCall;
        const parallel = canRunInParallel(options, call);
        if (parallel) {
          const batch: ToolCall[] = [];
          for (let index = callIndex; index < calls.length; index++) {
            const candidate = calls[index] as ToolCall;
            if (!canRunInParallel(options, candidate) || !resourcesCanShare(options, batch, candidate)) break;
            batch.push(candidate);
          }
          options.onEvent?.({ type: "tool_batch_started", calls: batch });
          const results = await Promise.all(batch.map(async (batchCall) => {
            options.onEvent?.({ type: "tool_started", call: batchCall });
            let output: string;
            let stop = false;
            try {
              signal?.throwIfAborted();
              const result = typeof batchCall.name === "string" && typeof batchCall.arguments === "string"
                ? await options.dispatch(batchCall)
                : JSON.stringify({ status: "error", error: "Invalid tool call fields" });
              output = typeof result === "string" ? result : result.output;
              stop = typeof result === "object" && result.stop === true;
            } catch (error) {
              output = JSON.stringify(signal?.aborted
                ? { status: "cancelled" }
                : { status: "error", error: error instanceof Error ? error.message : String(error) });
            }
            return { call: batchCall, output, stop };
          }));
          for (const result of results) {
            await options.record([{ type: "function_call_output", call_id: result.call.call_id, output: result.output }]);
            options.onEvent?.({ type: "tool_finished", call: result.call, output: result.output });
            stopAfterTools ||= result.stop;
          }
          options.onEvent?.({ type: "tool_batch_finished", calls: batch, outputs: results.map((result) => result.output) });
          callIndex += batch.length - 1;
          if (stopAfterTools) {
            for (const skipped of calls.slice(callIndex + 1)) {
              await options.record([{ type: "function_call_output", call_id: skipped.call_id, output: JSON.stringify({ status: "skipped" }) }]);
            }
            break;
          }
          const batchSteeringCount = await options.applySteering?.() ?? 0;
          if (batchSteeringCount > 0) {
            for (const skipped of calls.slice(callIndex + 1)) {
              await options.record([{ type: "function_call_output", call_id: skipped.call_id, output: JSON.stringify({ status: "steered" }) }]);
            }
            options.onEvent?.({ type: "steering_applied", count: batchSteeringCount });
            break;
          }
          continue;
        }
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
