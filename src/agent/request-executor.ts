import { normalizeTokenUsageSample } from "../status/model-status.js";
import { randomUUID } from "node:crypto";
import type { TaskPerformance } from "../performance/task-report.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { ModelStreamCleanupError, ModelStreamCancelledError } from "./response-errors.js";
import { RequestAttemptLedger, type RequestAttemptStatus, type RequestPurpose } from "./request-attempt-ledger.js";
import { recordRequestCost, type RequestCostContext, type ModelPrice } from "../status/cost.js";
import { PersistenceError } from "../storage/persistence-error.js";

export interface RequestAccountingScope {
  readonly ledger: RequestAttemptLedger;
  readonly executor: RequestExecutor;
}

/** Shared provider-attempt boundary for admission, cancellation-safe settlement, and usage accounting. */
export class RequestExecutor {
  readonly #ledger: RequestAttemptLedger;
  #cleanupFailure: ResourceCleanupError | undefined;
  #persistenceFailure: PersistenceError | undefined;
  readonly #namespace = randomUUID();

  constructor(ledger: RequestAttemptLedger, readonly cost?: RequestCostContext, readonly trace?: TaskPerformance | readonly TaskPerformance[]) {
    this.#ledger = ledger;
  }

  #trace(traces: readonly { trace: TaskPerformance; generation: number }[], id: string, purpose: RequestPurpose, status: RequestAttemptStatus, usage: import("../status/model-status.js").TokenUsageSample | null, ms: number): void {
    for (const { trace, generation } of traces) if (trace.generation === generation) trace.settle(id, purpose, status, usage, ms);
  }

  async #flush(): Promise<void> {
    try { await this.#ledger.flush(); }
    catch (error) {
      if (error instanceof ResourceCleanupError) throw error;
      this.#persistenceFailure ??= error instanceof PersistenceError ? error : new PersistenceError("Request ledger persistence failed", error);
      throw this.#persistenceFailure;
    }
  }

  async execute<T extends { usage?: unknown; status?: unknown }>(purpose: RequestPurpose, run: () => Promise<T>, admission?: { reservation: number; signal?: AbortSignal }, cost = this.cost): Promise<T> {
    const traces = (this.trace ? Array.isArray(this.trace) ? this.trace : [this.trace] : []).filter((trace) => trace.active).map((trace) => ({ trace, generation: trace.generation }));
    let attempt: number;
    let pricing: ModelPrice | null = null;
    try {
      if (this.#cleanupFailure) throw this.#cleanupFailure;
      if (this.#persistenceFailure) throw this.#persistenceFailure;
      cost = cost?.forRequest?.() ?? cost;
      pricing = await cost?.price() ?? null;
      await this.#ledger.admit(purpose, admission?.reservation ?? 0, admission?.signal);
      attempt = this.#ledger.begin(purpose);
    } catch (error) {
      this.#ledger.recordRejected(purpose);
      throw error;
    }
    let settled = false;
    let started = false;
    let startedAt = performance.now();
    try {
      await this.#flush();
      admission?.signal?.throwIfAborted();
      started = true;
      startedAt = performance.now();
      const result = await run();
      const status: RequestAttemptStatus = typeof result.status === "string" && result.status !== "completed"
        ? "failed"
        : "completed";
      // Retain only protocol identifiers, never response text, headers or error messages.
      // A usage stop occurs before normal response persistence in the coding runner.
      const record = result as Record<string, unknown>;
      const rawCode = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>).code : undefined;
      const knownCodes = ["server_error", "rate_limit_exceeded", "timeout", "connection_error", "invalid_request_error", "authentication_error", "insufficient_quota", "context_length_exceeded", "content_filter"];
      const errorCode = typeof rawCode === "string" ? knownCodes.includes(rawCode) ? rawCode : "unrecognized" : undefined;
      const responseId = typeof record.id === "string" && /^resp_[a-zA-Z0-9_-]{1,120}$/u.test(record.id) ? record.id : undefined;
      const responseStatus = typeof result.status === "string" && ["completed", "failed", "incomplete", "cancelled", "queued", "in_progress"].includes(result.status) ? result.status : undefined;
      const response = { ...(responseId ? { id: responseId } : {}), ...(responseStatus ? { status: responseStatus } : {}), ...(errorCode ? { errorCode } : {}) };
      this.#ledger.settle(attempt, status, normalizeTokenUsageSample(result.usage), result.usage == null ? "missing_usage" : "invalid_usage", Object.keys(response).length ? response : undefined);
      settled = true;
      this.#trace(traces, `${this.#namespace}:${attempt}`, purpose, status, normalizeTokenUsageSample(result.usage), performance.now() - startedAt);
      await this.#flush();
      if (cost) await recordRequestCost(cost, attempt, purpose, status, normalizeTokenUsageSample(result.usage), pricing);
      return result;
    } catch (error) {
      if (error instanceof ResourceCleanupError) this.#cleanupFailure ??= error;
      if (error instanceof PersistenceError) this.#persistenceFailure ??= error;
      if (!settled) {
        const record = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : undefined;
        const cancelled = record?.name === "AbortError" || record?.code === "ABORT_ERR";
        const status = started ? cancelled ? "cancelled" : "failed" : "rejected";
        const usage = !started ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 } : error instanceof ModelStreamCleanupError || error instanceof ModelStreamCancelledError ? error.usage : null;
        this.#ledger.settle(attempt, status, usage, error instanceof ModelStreamCleanupError || error instanceof ModelStreamCancelledError ? "stream_ended_without_usage" : "transport_failure");
        this.#trace(traces, `${this.#namespace}:${attempt}`, purpose, status, usage, performance.now() - startedAt);
        await this.#flush();
        if (started && cost) await recordRequestCost(cost, attempt, purpose, status, usage, pricing);
      }
      throw error;
    }
  }
}
