import { applyUsageSample, createEmptySessionUsage, type SessionUsage } from "../status/model-status.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { RequestAttemptLedger } from "./request-attempt-ledger.js";
import { RequestExecutor, type RequestAccountingScope } from "./request-executor.js";

type AuxiliaryPurpose = "title" | "skill" | "memory" | "doctor";
interface RequestScope extends RequestAccountingScope {
  recorded: number;
}

/** Keep operation admission separate from the lifetime auxiliary usage display. */
export class AuxiliaryRequestExecutor {
  constructor(readonly performance?: () => import("../performance/task-report.js").TaskPerformance | undefined) {}
  #usage = createEmptySessionUsage();
  readonly #scopes = new WeakMap<AbortSignal | RequestAttemptLedger, RequestScope>();
  #cleanupFailure: ResourceCleanupError | undefined;
  #disposed = false;
  #disposal: Promise<void> | undefined;
  readonly #controllers = new Set<AbortController>();
  readonly #pending = new Set<Promise<unknown>>();

  getUsage(): SessionUsage { return { ...this.#usage }; }

  async execute<T extends { usage?: unknown; status?: unknown }>(
    purpose: AuxiliaryPurpose,
    run: (signal: AbortSignal) => Promise<T>,
    scopeSignal?: AbortSignal,
    signal = scopeSignal,
    accounting?: RequestAccountingScope,
    cost?: import("../status/cost.js").RequestCostContext,
  ): Promise<T> {
    if (this.#cleanupFailure) throw this.#cleanupFailure;
    if (this.#disposed) throw new Error("Auxiliary requests have been disposed");
    signal?.throwIfAborted();
    const scopeKey = accounting?.ledger ?? scopeSignal;
    let scope = scopeKey ? this.#scopes.get(scopeKey) : undefined;
    if (scope && accounting && scope.executor !== accounting.executor) throw new Error("Request accounting scope changed executors");
    if (!scope) {
      const ledger = accounting?.ledger ?? new RequestAttemptLedger();
      // A dynamic observer remains owned by the executor that admitted the operation.
      scope = { ledger, executor: accounting?.executor ?? new RequestExecutor(ledger, undefined, this.performance?.()), recorded: ledger.snapshot().attempts.length };
      if (scopeKey) this.#scopes.set(scopeKey, scope);
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const operation = (async () => {
      // Register ownership before a provider callback can run or reenter.
      await Promise.resolve();
      if (this.#cleanupFailure) throw this.#cleanupFailure;
      ownedSignal.throwIfAborted();
      try {
        const result = await scope.executor.execute(purpose, () => run(ownedSignal), undefined, cost);
        ownedSignal.throwIfAborted();
        return result;
      }
      catch (error) {
        if (error instanceof ResourceCleanupError) this.#cleanupFailure ??= error;
        throw error;
      } finally {
        const attempts = scope.ledger.snapshot().attempts;
        for (const attempt of attempts.slice(scope.recorded)) {
          if (attempt.status !== "rejected") this.#usage = applyUsageSample(this.#usage, attempt.usage);
        }
        scope.recorded = attempts.length;
      }
    })();
    this.#pending.add(operation);
    try { return await operation; }
    finally {
      this.#controllers.delete(controller);
      this.#pending.delete(operation);
    }
  }

  dispose(): Promise<void> {
    return this.#disposal ??= (async () => {
      this.#disposed = true;
      const reason = new Error("Auxiliary requests have been disposed");
      for (const controller of this.#controllers) controller.abort(reason);
      await Promise.allSettled(this.#pending);
      if (this.#cleanupFailure) throw this.#cleanupFailure;
    })();
  }
}
