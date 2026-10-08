import { applyUsageSample, createEmptySessionUsage, type SessionUsage } from "../status/model-status.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { RequestAttemptLedger } from "./request-attempt-ledger.js";
import { RequestExecutor } from "./request-executor.js";

type AuxiliaryPurpose = "title" | "skill" | "memory" | "doctor";
interface RequestScope {
  ledger: RequestAttemptLedger;
  executor: RequestExecutor;
  recorded: number;
}

/** Keep operation admission separate from the lifetime auxiliary usage display. */
export class AuxiliaryRequestExecutor {
  #usage = createEmptySessionUsage();
  readonly #scopes = new WeakMap<AbortSignal, RequestScope>();
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
  ): Promise<T> {
    if (this.#cleanupFailure) throw this.#cleanupFailure;
    if (this.#disposed) throw new Error("Auxiliary requests have been disposed");
    signal?.throwIfAborted();
    let scope = scopeSignal ? this.#scopes.get(scopeSignal) : undefined;
    if (!scope) {
      const ledger = new RequestAttemptLedger();
      scope = { ledger, executor: new RequestExecutor(ledger), recorded: 0 };
      if (scopeSignal) this.#scopes.set(scopeSignal, scope);
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
        const result = await scope.executor.execute(purpose, () => run(ownedSignal));
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
