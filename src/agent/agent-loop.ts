// TypeScript adaptation of OpenAI Codex's sampling/follow-up control flow.
// Upstream revision and differences: docs/architecture/AGENT_LOOP.md.
// Copyright 2025 OpenAI. Licensed under Apache-2.0; see third_party/codex/LICENSE.
import { setTimeout as delay } from "node:timers/promises";
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

export interface AgentLoopOptions {
  sample(): Promise<LoopResponse>;
  record(items: readonly Record<string, unknown>[]): Promise<void>;
  dispatch(call: ToolCall): Promise<string>;
  assistant(text: string): void;
  signal?: AbortSignal;
  onPhase?(phase: LoopPhase): void;
  maxRetries?: number;
  retryDelayMs?: number;
}

function retryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, name } = error as { status?: unknown; name?: unknown };
  return status === 408 || status === 409 || status === 429 ||
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
      await delay(Math.min(10_000, (options.retryDelayMs ?? 250) * 2 ** attempt), undefined,
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
      const response = await sample(options);
      signal?.throwIfAborted();
      if (response.status && response.status !== "completed") {
        throw new Error(`Model response did not complete: ${response.status}`);
      }
      const calls = response.output.filter((item) => item.type === "function_call");
      const ids = new Set<string>();
      for (const call of calls) {
        if (typeof call.call_id !== "string" || !call.call_id || ids.has(call.call_id)) {
          throw new Error("Tool call has a missing or duplicate call_id");
        }
        ids.add(call.call_id);
      }
      // Never execute a side effect until its request is durably recorded.
      await options.record(response.output);
      if (response.output_text.trim()) options.assistant(response.output_text.trim());
      if (calls.length) options.onPhase?.("tools");
      for (const call of calls) {
        let output: string;
        try {
          signal?.throwIfAborted();
          output = typeof call.name === "string" && typeof call.arguments === "string"
            ? await options.dispatch(call as ToolCall)
            : JSON.stringify({ status: "error", error: "Invalid tool call fields" });
        } catch (error) {
          output = JSON.stringify(signal?.aborted
            ? { status: "cancelled" }
            : { status: "error", error: error instanceof Error ? error.message : String(error) });
        }
        // Checkpoint each result; a later interrupted tool cannot erase it.
        await options.record([{ type: "function_call_output", call_id: call.call_id, output }]);
      }
      signal?.throwIfAborted();
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
