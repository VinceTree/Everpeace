// TypeScript adaptation of OpenAI Codex's sampling/follow-up control flow.
// Upstream revision and differences: docs/architecture/AGENT_LOOP.md.
// Copyright 2025 OpenAI. Licensed under Apache-2.0; see third_party/codex/LICENSE.
import { setTimeout as delay } from "node:timers/promises";
import { PersistenceError } from "../storage/persistence-error.js";
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

export type LoopPhase = "sampling" | "tools" | "completed" | "stopped" | "cancelled" | "failed";

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
  | { type: "step_limit_reached"; maxSteps: number }
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

export type LoopStopReason = "budget_limited" | "usage_limited";
export class LoopStoppedError extends Error {
  constructor(readonly reason: LoopStopReason) {
    super(`Agent turn stopped: ${reason}`);
    this.name = "LoopStoppedError";
  }
}
export interface AgentLoopResult { stopReason?: LoopStopReason }

export function integerBudget(name: string, value: number | undefined, fallback: number, minimum = 0): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum) throw new RangeError(`${name} must be a finite integer >= ${minimum}`);
  return result;
}

export interface AgentLoopOptions {
  sample(): Promise<LoopResponse>;
  record(items: readonly Record<string, unknown>[]): Promise<void>;
  dispatch(call: ToolCall): Promise<string | { output: string; stop?: boolean }>;
  assistant(text: string): void;
  signal?: AbortSignal;
  onPhase?(phase: LoopPhase): void;
  onEvent?(event: LoopEvent): void;
  prepareStep?(): Promise<void>;
  hasPendingSteering?(): boolean;
  applySteering?(): Promise<number>;
  checkStop?(): Promise<LoopStopReason | undefined>;
  maxParallelTools?: number;
  maxRetries?: number;
  maxSteps?: number;
  retryDelayMs?: number;
  retryBudgets?: {
    sampling?: number;
    streamRecovery?: number;
    compaction?: number;
  };
  toolCapabilities?(call: ToolCall): ToolCapabilities | undefined;
  canRunInParallel?(call: ToolCall): boolean;
}

export function classifySamplingError(error: unknown): SamplingErrorCategory {
  if (error instanceof PersistenceError || error instanceof LoopSteeredError || error instanceof LoopStoppedError) return "permanent";
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
    const stopReason = await options.checkStop?.();
    if (stopReason) throw new LoopStoppedError(stopReason);
    try {
      return await options.sample();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof PersistenceError) throw error;
      const stopReason = await options.checkStop?.();
      if (stopReason) throw new LoopStoppedError(stopReason);
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
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { signal } = options;
  const retries = integerBudget("sampling retry budget", options.retryBudgets?.sampling ?? options.maxRetries, 2);
  integerBudget("maxRetries", options.maxRetries, 2);
  integerBudget("stream recovery budget", options.retryBudgets?.streamRecovery, 1);
  integerBudget("compaction budget", options.retryBudgets?.compaction, 1);
  const maxSteps = integerBudget("maxSteps", options.maxSteps, 32, 1);
  const maxParallelTools = integerBudget("maxParallelTools", options.maxParallelTools, 4, 1);
  const samplingBudget = { remaining: retries, total: retries };
  const closeCalls = async (calls: readonly ToolCall[], status: string, reason?: string) => {
    for (const call of calls) {
      await options.record([{ type: "function_call_output", call_id: call.call_id,
        output: JSON.stringify({ status, ...(reason ? { reason } : {}) }) }]);
    }
  };
  const steer = async (remaining: readonly ToolCall[] = []): Promise<boolean> => {
    if (!options.hasPendingSteering?.()) return false;
    await closeCalls(remaining, "steered");
    const count = await options.applySteering?.() ?? 0;
    if (count) options.onEvent?.({ type: "steering_applied", count });
    return count > 0;
  };
  const stop = async (remaining: readonly ToolCall[] = []): Promise<AgentLoopResult | undefined> => {
    const reason = await options.checkStop?.();
    if (!reason) return undefined;
    await closeCalls(remaining, "skipped", reason);
    await steer();
    options.onPhase?.("stopped");
    return { stopReason: reason };
  };
  try {
    let steps = 0;
    while (true) {
      signal?.throwIfAborted();
      const stopped = await stop();
      if (stopped) return stopped;
      await steer();
      if (steps >= maxSteps) {
        options.onEvent?.({ type: "step_limit_reached", maxSteps });
        throw new Error(`Agent turn exceeded the maximum of ${maxSteps} sampling steps`);
      }
      steps += 1;
      await options.prepareStep?.();
      signal?.throwIfAborted();
      const preparedStop = await stop();
      if (preparedStop) return preparedStop;
      // Guidance arriving during preparation must reach the next request snapshot.
      if (await steer()) continue;
      options.onPhase?.("sampling");
      let response: LoopResponse;
      try {
        response = await sample(options, samplingBudget);
      } catch (error) {
        if (error instanceof LoopStoppedError) {
          await steer();
          options.onPhase?.("stopped");
          return { stopReason: error.reason };
        }
        if (error instanceof LoopSteeredError) {
          await steer();
          continue;
        }
        throw error;
      }
      signal?.throwIfAborted();
      if (response.status && response.status !== "completed") {
        options.onEvent?.({ type: "response_rejected", reason: "incomplete" });
        throw new Error(`Model response did not complete: ${response.status}`);
      }
      const calls = response.output.filter((item) => item.type === "function_call") as ToolCall[];
      const ids = new Set<string>();
      for (const call of calls) {
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
      // Resolve capability metadata once, before asynchronous dispatch begins.
      const capabilities = calls.map((call) => {
        const value = options.toolCapabilities?.(call);
        return value ? { ...value, resourceKeys: [...value.resourceKeys] } : undefined;
      });
      const parallel = calls.map((call, index) => {
        const capability = capabilities[index];
        return capability
          ? capability.readOnly && capability.idempotent && capability.parallelSafe
          : options.canRunInParallel?.(call) === true;
      });
      await options.record(response.output);
      options.onEvent?.({ type: "response_received", response });
      if (signal?.aborted) {
        await closeCalls(calls, "cancelled");
        signal.throwIfAborted();
      }
      const responseStop = await stop(calls);
      if (responseStop) return responseStop;
      if (await steer(calls)) continue;
      if (response.output_text.trim()) options.assistant(response.output_text.trim());
      if (calls.length) options.onPhase?.("tools");
      let stopAfterTools = false;
      for (let index = 0; index < calls.length;) {
        if (signal?.aborted) {
          await closeCalls(calls.slice(index), "cancelled");
          signal.throwIfAborted();
        }
        const toolStop = await stop(calls.slice(index));
        if (toolStop) return toolStop;
        if (await steer(calls.slice(index))) break;
        const start = index;
        const batch = [calls[index]!];
        const resourceKeys = new Set(capabilities[index]?.resourceKeys ?? []);
        if (parallel[index]) {
          while (index + batch.length < calls.length && batch.length < maxParallelTools) {
            const next = index + batch.length;
            const keys = capabilities[next]?.resourceKeys ?? [];
            if (!parallel[next] || keys.some((key) => resourceKeys.has(key))) break;
            batch.push(calls[next]!);
            keys.forEach((key) => resourceKeys.add(key));
          }
          options.onEvent?.({ type: "tool_batch_started", calls: batch });
        }
        // Await every started operation even when one reports a fatal failure.
        const results = await Promise.all(batch.map(async (call) => {
          let output: string;
          let stop = false;
          try {
            signal?.throwIfAborted();
            options.onEvent?.({ type: "tool_started", call });
            const result = await options.dispatch(call);
            output = typeof result === "string" ? result : result.output;
            stop = typeof result === "object" && result.stop === true;
          } catch (error) {
            if (error instanceof PersistenceError) return { call, fatal: error };
            output = JSON.stringify(signal?.aborted ? { status: "cancelled" }
              : { status: "error", error: error instanceof Error ? error.message : String(error) });
          }
          return { call, output, stop };
        }));
        for (const result of results) {
          if (result.fatal) throw result.fatal;
          await options.record([{ type: "function_call_output", call_id: result.call.call_id, output: result.output }]);
          options.onEvent?.({ type: "tool_finished", call: result.call, output: result.output! });
          stopAfterTools ||= result.stop === true;
        }
        if (parallel[start]) options.onEvent?.({ type: "tool_batch_finished", calls: batch, outputs: results.map((result) => result.output!) });
        index += batch.length;
        if (signal?.aborted) {
          await closeCalls(calls.slice(index), "cancelled");
          signal.throwIfAborted();
        }
        const batchStop = await stop(calls.slice(index));
        if (batchStop) return batchStop;
        if (stopAfterTools) {
          await closeCalls(calls.slice(index), "skipped");
          await steer();
          break;
        }
        if (await steer(calls.slice(index))) break;
      }
      signal?.throwIfAborted();
      const finalStop = await stop();
      if (finalStop) return finalStop;
      if (stopAfterTools) {
        options.onPhase?.("completed");
        return {};
      }
      if (await steer()) continue;
      if (calls.length === 0 && response.end_turn !== false) {
        options.onPhase?.("completed");
        return {};
      }
    }
  } catch (error) {
    options.onPhase?.(signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}
