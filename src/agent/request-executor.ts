import { normalizeTokenUsageSample } from "../status/model-status.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { ModelStreamCleanupError } from "./response-errors.js";
import { RequestAttemptLedger, type RequestAttemptStatus, type RequestPurpose } from "./request-attempt-ledger.js";

export interface RequestAccountingScope {
  readonly ledger: RequestAttemptLedger;
  readonly executor: RequestExecutor;
}

/** Shared provider-attempt boundary for admission, cancellation-safe settlement, and usage accounting. */
export class RequestExecutor {
  readonly #ledger: RequestAttemptLedger;
  #cleanupFailure: ResourceCleanupError | undefined;

  constructor(ledger: RequestAttemptLedger) {
    this.#ledger = ledger;
  }

  async execute<T extends { usage?: unknown; status?: unknown }>(purpose: RequestPurpose, run: () => Promise<T>, admission?: { reservation: number; signal?: AbortSignal }): Promise<T> {
    let attempt: number;
    try {
      if (this.#cleanupFailure) throw this.#cleanupFailure;
      await this.#ledger.admit(purpose, admission?.reservation ?? 0, admission?.signal);
      attempt = this.#ledger.begin(purpose);
    } catch (error) {
      this.#ledger.recordRejected(purpose);
      throw error;
    }
    let settled = false;
    let started = false;
    try {
      await this.#ledger.flush();
      started = true;
      const result = await run();
      const status: RequestAttemptStatus = typeof result.status === "string" && result.status !== "completed"
        ? "failed"
        : "completed";
      this.#ledger.settle(attempt, status, normalizeTokenUsageSample(result.usage));
      settled = true;
      await this.#ledger.flush();
      return result;
    } catch (error) {
      if (error instanceof ResourceCleanupError) this.#cleanupFailure ??= error;
      if (!settled) {
        const record = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : undefined;
        const cancelled = record?.name === "AbortError" || record?.code === "ABORT_ERR";
        this.#ledger.settle(attempt, started ? cancelled ? "cancelled" : "failed" : "rejected", !started ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 } : error instanceof ModelStreamCleanupError ? error.usage : null);
        await this.#ledger.flush();
      }
      throw error;
    }
  }
}
