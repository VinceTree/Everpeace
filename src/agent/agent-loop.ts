// TypeScript adaptation of OpenAI Codex's sampling/follow-up control flow.
// Upstream revision and differences: docs/architecture/AGENT_LOOP.md.
// Copyright 2025 OpenAI. Licensed under Apache-2.0; see third_party/codex/LICENSE.
import { setTimeout as delay } from "node:timers/promises";
import { PersistenceError } from "../storage/persistence-error.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { boundModelToolOutput, type PreparedToolOutput } from "./context-limits.js";
import type { TokenUsageSample } from "../status/model-status.js";
const MAX_PENDING_PARALLEL_TOOL_BYTES = 4 * 1024 * 1024;
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
  | { type: "cost_estimated"; estimate: import("../status/cost.js").CostEstimate }
  | { type: "sampling_started" }
  | { type: "reasoning_started" }
  | { type: "reasoning_finished" }
  | { type: "model_progress"; milestone: "first_event" | "first_text" }
  | { type: "response_received"; response: LoopResponse }
  | { type: "response_rejected"; reason: "incomplete" | "invalid_tool_call" }
  | { type: "request_composition"; instructionsBytes: number; toolsBytes: number; toolResultsBytes: number; requestBytes: number }
  | { type: "tool_failure_repeated" }
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
  | { type: "compaction_completed"; automatic: boolean; usage: TokenUsageSample | null }
  | { type: "timing_recorded"; operation: "prepare_context" | "request_snapshot" | "sampling" | "retry_delay" | "tool_wait" | "tool_execution" | "compaction" | "persistence" | "workspace_snapshot" | "verification" | "artifact_persistence" | "sandbox_startup" | "rendering"; durationMs: number };

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

export type LoopStopReason = "budget_limited" | "usage_limited" | "step_limit" | "deadline_exceeded";
export class LoopStoppedError extends Error {
  constructor(readonly reason: LoopStopReason) {
    super(`Agent turn stopped: ${reason}`);
    this.name = "LoopStoppedError";
  }
}
export interface AgentLoopResult {
  stopReason?: LoopStopReason;
  steps?: number;
  durationMs?: number;
}

export function integerBudget(name: string, value: number | undefined, fallback: number, minimum = 0): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum) throw new RangeError(`${name} must be a finite integer >= ${minimum}`);
  return result;
}

export interface AgentLoopOptions {
  sample(signal?: AbortSignal): Promise<LoopResponse>;
  record(items: readonly Record<string, unknown>[]): Promise<void>;
  dispatch(call: ToolCall, signal?: AbortSignal): Promise<string | { output: string; stop?: boolean }>;
  assistant(text: string): void | Promise<void>;
  signal?: AbortSignal;
  onPhase?(phase: LoopPhase): void;
  onEvent?(event: LoopEvent): void;
  /** Await public tool delivery at execution/commit boundaries, independently of SSE telemetry. */
  onToolEvent?(event: Extract<LoopEvent, { type: "tool_started" | "tool_finished" }>): void | Promise<void>;
  prepareStep?(signal?: AbortSignal): Promise<void>;
  hasPendingSteering?(): boolean;
  applySteering?(): Promise<number>;
  checkStop?(): Promise<LoopStopReason | undefined>;
  maxParallelTools?: number;
  maxTurnDurationMs?: number;
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
  boundToolOutput?(output: string): string;
  feedbackToolOutput?(call: ToolCall, output: string): string;
  /** Prepare bounded results without publishing retained output references. */
  prepareToolOutput?(output: string, call: ToolCall): PreparedToolOutput;
  /** Commit retained bytes and their reference in model call order. */
  recordToolResult?(item: Record<string, unknown>, prepared: PreparedToolOutput): Promise<void>;
}

export function classifySamplingError(error: unknown): SamplingErrorCategory {
  if (error instanceof ResourceCleanupError) return "permanent";
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

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const headers = (error as { headers?: unknown }).headers;
  let value: unknown;
  if (headers && typeof headers === "object" && "get" in headers && typeof (headers as { get?: unknown }).get === "function") {
    value = (headers as { get(name: string): unknown }).get("retry-after");
  } else if (headers && typeof headers === "object") {
    value = (headers as Record<string, unknown>)["retry-after"] ?? (headers as Record<string, unknown>)["Retry-After"];
  }
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.round(seconds * 1_000));
  if (typeof value === "string") {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  }
  return undefined;
}

async function sample(
  options: AgentLoopOptions,
  budget: { remaining: number; total: number },
  signal?: AbortSignal,
): Promise<LoopResponse> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const stopReason = await options.checkStop?.();
    if (stopReason) throw new LoopStoppedError(stopReason);
    try {
      const started = performance.now();
      try {
        return await options.sample(signal);
      } finally {
        options.onEvent?.({ type: "timing_recorded", operation: "sampling", durationMs: performance.now() - started });
      }
    } catch (error) {
      if (error instanceof ResourceCleanupError) throw error;
      signal?.throwIfAborted();
      if (error instanceof PersistenceError) throw error;
      const stopReason = await options.checkStop?.();
      if (stopReason) throw new LoopStoppedError(stopReason);
      const category = classifySamplingError(error);
      if (budget.remaining <= 0 || !retryable(category)) throw error;
      budget.remaining -= 1;
      const exponential = (options.retryDelayMs ?? 250) * 2 ** attempt;
      const jittered = Math.round(exponential * (0.8 + Math.random() * 0.4));
      const delayMs = retryAfterMs(error) ?? Math.min(10_000, jittered);
      options.onEvent?.({ type: "retrying", attempt: budget.total - budget.remaining, delayMs, category });
      const delayStarted = performance.now();
      await delay(delayMs, undefined, signal ? { signal } : {});
      options.onEvent?.({ type: "timing_recorded", operation: "retry_delay", durationMs: performance.now() - delayStarted });
    }
  }
}

/** Keep transport, tool permissions, and durable history outside turn control. */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  if ((options.prepareToolOutput === undefined) !== (options.recordToolResult === undefined)) {
    throw new Error("Prepared tool output requires both preparation and ordered persistence callbacks");
  }
  const startedAt = performance.now();
  const externalSignal = options.signal;
  const retries = integerBudget("sampling retry budget", options.retryBudgets?.sampling ?? options.maxRetries, 2);
  integerBudget("maxRetries", options.maxRetries, 2);
  integerBudget("stream recovery budget", options.retryBudgets?.streamRecovery, 1);
  integerBudget("compaction budget", options.retryBudgets?.compaction, 1);
  const maxSteps = integerBudget("maxSteps", options.maxSteps, 32, 1);
  const maxParallelTools = integerBudget("maxParallelTools", options.maxParallelTools, 4, 1);
  const maxTurnDurationMs = options.maxTurnDurationMs === undefined
    ? undefined
    : integerBudget("maxTurnDurationMs", options.maxTurnDurationMs, options.maxTurnDurationMs, 1);
  const deadlineController = new AbortController();
  const deadlineReason = new Error("Agent turn deadline exceeded");
  deadlineReason.name = "AgentTurnDeadlineError";
  const deadlineTimer = maxTurnDurationMs === undefined ? undefined : setTimeout(() => deadlineController.abort(deadlineReason), maxTurnDurationMs);
  deadlineTimer?.unref?.();
  const signal = maxTurnDurationMs === undefined
    ? externalSignal
    : externalSignal === undefined
      ? deadlineController.signal
      : AbortSignal.any([externalSignal, deadlineController.signal]);
  const samplingBudget = { remaining: retries, total: retries };
  const pendingCalls = new Map<string, ToolCall>();
  const outputFailures = new Set<Error>();
  const deliver = async (run: () => void | Promise<void>): Promise<void> => {
    try { await run(); }
    catch (value) {
      const error = value instanceof Error ? value : new Error(String(value));
      outputFailures.add(error);
      throw error;
    }
  };
  const closeCalls = async (calls: readonly ToolCall[], status: string, reason?: string) => {
    for (const call of calls) {
      await options.record([{ type: "function_call_output", call_id: call.call_id,
        output: JSON.stringify({ status, ...(reason ? { reason } : {}) }) }]);
      pendingCalls.delete(call.call_id);
    }
  };
  const steer = async (remaining: readonly ToolCall[] = []): Promise<boolean> => {
    if (!options.hasPendingSteering?.()) return false;
    await closeCalls(remaining, "steered");
    const count = await options.applySteering?.() ?? 0;
    if (count) options.onEvent?.({ type: "steering_applied", count });
    return count > 0;
  };
  let steps = 0;
  const result = (stopReason?: LoopStopReason): AgentLoopResult => ({
    ...(stopReason ? { stopReason } : {}),
    steps,
    durationMs: performance.now() - startedAt,
  });
  const stop = async (remaining: readonly ToolCall[] = []): Promise<AgentLoopResult | undefined> => {
    const reason = deadlineController.signal.aborted ? "deadline_exceeded" : await options.checkStop?.();
    if (!reason) return undefined;
    await closeCalls(remaining, "skipped", reason);
    await steer();
    options.onPhase?.("stopped");
    return result(reason);
  };
  try {
    while (true) {
      if (externalSignal?.aborted) externalSignal.throwIfAborted();
      const stopped = await stop();
      if (stopped) return stopped;
      await steer();
      if (steps >= maxSteps) {
        options.onEvent?.({ type: "step_limit_reached", maxSteps });
        options.onPhase?.("stopped");
        return result("step_limit");
      }
      steps += 1;
      await options.prepareStep?.(signal);
      if (deadlineController.signal.aborted) {
        options.onPhase?.("stopped");
        return result("deadline_exceeded");
      }
      externalSignal?.throwIfAborted();
      const preparedStop = await stop();
      if (preparedStop) return preparedStop;
      // Guidance arriving during preparation must reach the next request snapshot.
      if (await steer()) continue;
      options.onPhase?.("sampling");
      let response: LoopResponse;
      try {
        response = await sample(options, samplingBudget, signal);
      } catch (error) {
        if (error instanceof LoopStoppedError) {
          await steer();
          options.onPhase?.("stopped");
          return result(error.reason);
        }
        if (deadlineController.signal.aborted && !externalSignal?.aborted) {
          options.onPhase?.("stopped");
          return result("deadline_exceeded");
        }
        if (error instanceof LoopSteeredError) {
          await steer();
          continue;
        }
        throw error;
      }
      const calls = response.output.filter((item) => item.type === "function_call") as ToolCall[];
      if (response.status && response.status !== "completed") {
        options.onEvent?.({ type: "response_rejected", reason: "incomplete" });
        throw new Error(`Model response did not complete: ${response.status}`);
      }
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
      for (const call of calls) pendingCalls.set(call.call_id, call);
      options.onEvent?.({ type: "response_received", response });
      if (externalSignal?.aborted) {
        await closeCalls(calls, "cancelled");
        externalSignal.throwIfAborted();
      }
      const responseStop = await stop(calls);
      if (responseStop) return responseStop;
      if (await steer(calls)) continue;
      if (response.output_text.trim()) await deliver(() => options.assistant(response.output_text.trim()));
      if (calls.length) options.onPhase?.("tools");
      let stopAfterTools = false;
      for (let index = 0; index < calls.length;) {
        if (externalSignal?.aborted) {
          await closeCalls(calls.slice(index), "cancelled");
          externalSignal.throwIfAborted();
        }
        const toolStop = await stop(calls.slice(index));
        if (toolStop) return toolStop;
        if (await steer(calls.slice(index))) break;
        const start = index;
        const segmentEnd = parallel[index]
          ? (() => { let end = index + 1; while (end < calls.length && parallel[end]) end += 1; return end; })()
          : index + 1;
        const segment = calls.slice(index, segmentEnd);
        if (parallel[index]) options.onEvent?.({ type: "tool_batch_started", calls: segment });
        const segmentController = new AbortController();
        const executionSignal = signal
          ? AbortSignal.any([signal, segmentController.signal])
          : segmentController.signal;
        type ToolRun = { call: ToolCall; output?: string; prepared?: PreparedToolOutput; stop?: boolean; fatal?: Error; executionMs: number };
        const execute = async (call: ToolCall): Promise<ToolRun> => {
          let rawOutput: string;
          let stop = false;
          const executionStarted = performance.now();
          try {
            executionSignal.throwIfAborted();
            options.onEvent?.({ type: "tool_started", call });
            if (options.onToolEvent) await deliver(() => options.onToolEvent!({ type: "tool_started", call }));
            executionSignal.throwIfAborted();
            const dispatched = await options.dispatch(call, executionSignal);
            rawOutput = typeof dispatched === "string" ? dispatched : dispatched.output;
            stop = typeof dispatched === "object" && dispatched.stop === true;
          } catch (error) {
            if (error instanceof Error && outputFailures.has(error)) {
              segmentController.abort(error);
              return { call, fatal: error, executionMs: performance.now() - executionStarted };
            }
            if (error instanceof PersistenceError) return { call, fatal: error, executionMs: performance.now() - executionStarted };
            rawOutput = JSON.stringify(executionSignal.aborted ? { status: "cancelled" }
              : { status: "error", error: error instanceof Error ? error.message : String(error) });
          }
          try {
            const prepared = options.prepareToolOutput?.(rawOutput, call);
            const output = prepared?.output ?? options.boundToolOutput?.(rawOutput) ?? boundModelToolOutput(rawOutput);
            return { call, output, ...(prepared ? { prepared } : {}), stop, executionMs: performance.now() - executionStarted };
          } catch (error) {
            return { call, fatal: error instanceof Error ? error : new Error(String(error)), executionMs: performance.now() - executionStarted };
          }
        };
        const results: ToolRun[] = [];
        const persistToolResult = async (item: ToolRun): Promise<void> => {
          if (item.fatal) throw item.fatal;
          if (options.feedbackToolOutput) {
            item.output = options.feedbackToolOutput(item.call, item.output!);
            if (item.prepared) item.prepared = { ...item.prepared, output: item.output };
          }
          const record = { type: "function_call_output", call_id: item.call.call_id, output: item.output! };
          if (item.prepared && options.recordToolResult) await options.recordToolResult(record, item.prepared);
          else await options.record([record]);
          pendingCalls.delete(item.call.call_id);
          options.onEvent?.({ type: "tool_finished", call: item.call, output: item.output! });
          if (options.onToolEvent) await deliver(() => options.onToolEvent!({ type: "tool_finished", call: item.call, output: item.output! }));
          options.onEvent?.({ type: "timing_recorded", operation: "tool_execution", durationMs: item.executionMs });
          stopAfterTools ||= item.stop === true;
        };
        if (!parallel[index]) {
          results.push(await execute(segment[0]!));
        } else {
          const inFlight = new Map<number, Promise<void>>();
          const completed = new Map<number, ToolRun>();
          const activeKeys = new Set<string>();
          let launched = 0;
          let committed = 0;
          let completedBytes = 0;
          let wake: (() => void) | undefined;
          const notify = () => { const callback = wake; wake = undefined; callback?.(); };
          while (committed < segment.length) {
            const ready = completed.get(committed);
            if (ready) {
              completed.delete(committed);
              completedBytes -= Buffer.byteLength(ready.output ?? "") + (ready.prepared?.attachment?.bytes.byteLength ?? 0);
              try {
                await persistToolResult(ready);
              } catch (error) {
                segmentController.abort(error);
                await Promise.allSettled(inFlight.values());
                throw error;
              }
              results.push({ call: ready.call, executionMs: ready.executionMs, ...(ready.stop === undefined ? {} : { stop: ready.stop }) });
              committed += 1;
              continue;
            }
            let gateStop: LoopStopReason | undefined;
            while (
              launched < segment.length
              && inFlight.size < maxParallelTools
              && completed.size < maxParallelTools
              && completedBytes < MAX_PENDING_PARALLEL_TOOL_BYTES
            ) {
              gateStop = await options.checkStop?.();
              if (externalSignal?.aborted || deadlineController.signal.aborted || segmentController.signal.aborted || options.hasPendingSteering?.() || gateStop) break;
              const absolute = start + launched;
              const keys = capabilities[absolute]?.resourceKeys ?? [];
              if (keys.some((key) => activeKeys.has(key))) break;
              keys.forEach((key) => activeKeys.add(key));
              const localIndex = launched++;
              const pending = execute(segment[localIndex]!)
                .then((result) => {
                  completed.set(localIndex, result);
                  completedBytes += Buffer.byteLength(result.output ?? "") + (result.prepared?.attachment?.bytes.byteLength ?? 0);
                })
                .finally(() => {
                  inFlight.delete(localIndex);
                  keys.forEach((key) => activeKeys.delete(key));
                  notify();
                });
              inFlight.set(localIndex, pending);
            }
            if (completed.has(committed)) continue;
            if (inFlight.size === 0) break;
            const waitStarted = performance.now();
            await new Promise<void>((resolve) => { wake = resolve; });
            options.onEvent?.({ type: "timing_recorded", operation: "tool_wait", durationMs: performance.now() - waitStarted });
          }
        }
        if (!parallel[index]) for (const result of results) await persistToolResult(result);
        if (parallel[start]) options.onEvent?.({ type: "tool_batch_finished", calls: segment.slice(0, results.length), outputs: [] });
        index += results.length;
        if (results.length < segment.length) {
          const remaining = calls.slice(index);
          if (deadlineController.signal.aborted) {
            await closeCalls(remaining, "skipped", "deadline_exceeded");
            options.onPhase?.("stopped");
            return result("deadline_exceeded");
          }
          if (await steer(remaining)) break;
          const limited = await stop(remaining);
          if (limited) return limited;
        }
        if (externalSignal?.aborted) {
          await closeCalls(calls.slice(index), "cancelled");
          externalSignal.throwIfAborted();
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
      if (deadlineController.signal.aborted) {
        options.onPhase?.("stopped");
        return result("deadline_exceeded");
      }
      externalSignal?.throwIfAborted();
      const finalStop = await stop();
      if (finalStop) return finalStop;
      if (stopAfterTools) {
        options.onPhase?.("completed");
        return result();
      }
      if (await steer()) continue;
      if (calls.length === 0 && response.end_turn !== false) {
        options.onPhase?.("completed");
        return result();
      }
    }
  } catch (error) {
    // Public output can fail after the response is durable. Close its outstanding
    // tool chain without attempting further delivery or side effects.
    if (error instanceof ResourceCleanupError) {
      await closeCalls([...pendingCalls.values()], "skipped", error.resource === "process" ? "process_cleanup_failed" : "model_stream_cleanup_failed");
    } else if (error instanceof LoopStoppedError) {
      await closeCalls([...pendingCalls.values()], "skipped", error.reason);
      await steer();
      options.onPhase?.("stopped");
      return result(error.reason);
    } else if (error instanceof Error && outputFailures.has(error) && !(error instanceof PersistenceError)) {
      await closeCalls([...pendingCalls.values()], externalSignal?.aborted ? "cancelled" : "skipped", "output_delivery_failed");
    }
    options.onPhase?.(error instanceof ResourceCleanupError || !externalSignal?.aborted ? "failed" : "cancelled");
    throw error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  }
}
