import { normalizeTokenUsageSample } from "../status/model-status.js";
import { RequestAttemptLedger, type RequestAttemptStatus, type RequestPurpose } from "./request-attempt-ledger.js";

/** Shared provider-attempt boundary for admission, cancellation-safe settlement, and usage accounting. */
export class RequestExecutor {
  readonly #ledger: RequestAttemptLedger;

  constructor(ledger: RequestAttemptLedger) {
    this.#ledger = ledger;
  }

  async execute<T extends { usage?: unknown; status?: unknown }>(purpose: RequestPurpose, run: () => Promise<T>): Promise<T> {
    let attempt: number;
    try {
      attempt = this.#ledger.begin(purpose);
    } catch (error) {
      this.#ledger.recordRejected(purpose);
      throw error;
    }
    let settled = false;
    try {
      const result = await run();
      const status: RequestAttemptStatus = typeof result.status === "string" && result.status !== "completed"
        ? "failed"
        : "completed";
      this.#ledger.settle(attempt, status, normalizeTokenUsageSample(result.usage));
      settled = true;
      return result;
    } catch (error) {
      if (!settled) {
        const record = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : undefined;
        const cancelled = record?.name === "AbortError" || record?.code === "ABORT_ERR";
        this.#ledger.settle(attempt, cancelled ? "cancelled" : "failed", null);
      }
      throw error;
    }
  }
}
