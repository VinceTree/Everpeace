import { normalizeTokenUsageSample } from "../status/model-status.js";
import { randomUUID } from "node:crypto";
import type { TaskPerformance } from "../performance/task-report.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { ModelStreamCleanupError } from "./response-errors.js";
import { RequestAttemptLedger, type RequestAttemptStatus, type RequestPurpose } from "./request-attempt-ledger.js";
import { recordRequestCost, type RequestCostContext, type ModelPrice } from "../status/cost.js";

export interface RequestAccountingScope {
  readonly ledger: RequestAttemptLedger;
  readonly executor: RequestExecutor;
}

/** Shared provider-attempt boundary for admission, cancellation-safe settlement, and usage accounting. */
export class RequestExecutor {
  readonly #ledger: RequestAttemptLedger;
  #cleanupFailure: ResourceCleanupError | undefined;
  readonly #namespace = randomUUID();

  constructor(ledger: RequestAttemptLedger, readonly cost?: RequestCostContext, readonly trace?: TaskPerformance | readonly TaskPerformance[]) {
    this.#ledger = ledger;
  }

  #trace(traces: readonly { trace: TaskPerformance; generation: number }[], id: string, purpose: RequestPurpose, status: RequestAttemptStatus, usage: import("../status/model-status.js").TokenUsageSample | null, ms: number): void {
    for (const { trace, generation } of traces) if (trace.generation === generation) trace.settle(id, purpose, status, usage, ms);
  }

  async execute<T extends { usage?: unknown; status?: unknown }>(purpose: RequestPurpose, run: () => Promise<T>, admission?: { reservation: number; signal?: AbortSignal }, cost = this.cost): Promise<T> {
    const traces = (this.trace ? Array.isArray(this.trace) ? this.trace : [this.trace] : []).filter((trace) => trace.active).map((trace) => ({ trace, generation: trace.generation }));
    let attempt: number;
    let pricing: ModelPrice | null = null;
    try {
      if (this.#cleanupFailure) throw this.#cleanupFailure;
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
      await this.#ledger.flush();
      started = true;
      startedAt = performance.now();
      const result = await run();
      const status: RequestAttemptStatus = typeof result.status === "string" && result.status !== "completed"
        ? "failed"
        : "completed";
      this.#ledger.settle(attempt, status, normalizeTokenUsageSample(result.usage));
      settled = true;
      this.#trace(traces, `${this.#namespace}:${attempt}`, purpose, status, normalizeTokenUsageSample(result.usage), performance.now() - startedAt);
      await this.#ledger.flush();
      if (cost) await recordRequestCost(cost, attempt, purpose, status, normalizeTokenUsageSample(result.usage), pricing);
      return result;
    } catch (error) {
      if (error instanceof ResourceCleanupError) this.#cleanupFailure ??= error;
      if (!settled) {
        const record = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : undefined;
        const cancelled = record?.name === "AbortError" || record?.code === "ABORT_ERR";
        const status = started ? cancelled ? "cancelled" : "failed" : "rejected";
        const usage = !started ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 } : error instanceof ModelStreamCleanupError ? error.usage : null;
        this.#ledger.settle(attempt, status, usage);
        this.#trace(traces, `${this.#namespace}:${attempt}`, purpose, status, usage, performance.now() - startedAt);
        await this.#ledger.flush();
        if (started && cost) await recordRequestCost(cost, attempt, purpose, status, usage, pricing);
      }
      throw error;
    }
  }
}
