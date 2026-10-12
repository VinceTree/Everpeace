import { RequestAttemptLedger, RequestUsageIncompleteError, type RequestPurpose, type RequestAttemptStatus, type RequestAttemptLedgerSnapshot } from "../agent/request-attempt-ledger.js";
import type { TokenUsageSample } from "../status/model-status.js";

export class TeamLimitError extends Error {
  constructor(readonly reason: "budget_limited" | "step_limit" | "deadline_exceeded") { super(`Team limit reached: ${reason}`); this.name = "TeamLimitError"; }
}
/** One owner, with non-resettable member views and durable admission/settlement. */
export class TeamLedger extends RequestAttemptLedger {
  readonly #reservations = new Map<string, number>();
  readonly #owners = new Map<number, { agentId: string; modelId: string }>();
  readonly #waiters = new Set<() => void>();
  readonly #pending = new Set<string>();
  readonly #active = new Map<number, { purpose: RequestPurpose; agentId: string; modelId: string }>();
  #open = 0;
  #remainingAttempts: number;
  #failure: unknown;
  #persist: () => Promise<void> = async () => {};
  #chain = Promise.resolve();
  readonly #historical: RequestAttemptLedgerSnapshot | undefined;
  #tokenLimit: number | undefined;
  #consumed = 0;
  constructor(readonly settings: { tokenBudget?: number; maxAttempts: number; deadline: number; onStop(reason: unknown): void; historical?: RequestAttemptLedgerSnapshot }) {
    super(settings.tokenBudget === undefined ? {} : { tokenBudget: settings.tokenBudget });
    this.#historical = settings.historical; this.#tokenLimit = settings.tokenBudget;
    this.#remainingAttempts = settings.maxAttempts - (settings.historical?.attempts.filter((entry) => entry.status !== "rejected").length ?? 0);
    if (settings.historical && !settings.historical.complete) this.#failure = new RequestUsageIncompleteError();
  }
  setPersistence(persist: () => Promise<void>): void { this.#persist = persist; }
  override reset(): void { /* Only construction starts a new root task. */ }
  override get usageComplete(): boolean { return super.usageComplete && this.#historical?.complete !== false; }
  get openRequests(): number { return this.#open; }
  get inFlight() { return [...this.#active.entries()].map(([id, entry]) => ({ id: id + this.offset, ...entry })); }
  private get offset(): number { return Math.max(0, ...(this.#historical?.attempts.map((entry) => entry.id) ?? [])); }
  override get remainingTokens(): number | undefined {
    return this.#tokenLimit === undefined ? undefined : this.#tokenLimit - this.#consumed - (this.#historical?.inputTokens ?? 0) - (this.#historical?.outputTokens ?? 0);
  }
  restrictTokens(limit: number): void { this.#tokenLimit = Math.min(this.#tokenLimit ?? Infinity, Math.max(0, limit)); this.wake(); }
  override settle(id: number, status: RequestAttemptStatus, usage: TokenUsageSample | null): void { super.settle(id, status, usage); this.#consumed += usage ? usage.input_tokens + usage.output_tokens : 0; }
  override snapshot(): RequestAttemptLedgerSnapshot {
    const current = super.snapshot();
    const old = this.#historical;
    return { ...current, ...(this.#tokenLimit === undefined ? {} : { tokenBudget: this.#tokenLimit, remainingTokens: this.remainingTokens! }), attempts: [...(old?.attempts ?? []), ...current.attempts.map((entry) => ({ ...entry, ...this.#owners.get(entry.id), id: entry.id + this.offset }))].sort((a, b) => a.id - b.id), inputTokens: current.inputTokens + (old?.inputTokens ?? 0), outputTokens: current.outputTokens + (old?.outputTokens ?? 0), reasoningTokens: current.reasoningTokens + (old?.reasoningTokens ?? 0), complete: this.usageComplete && this.#open === 0 };
  }
  scope(agentId: string, modelId: string): RequestAttemptLedger {
    // oxlint-disable-next-line typescript/no-this-alias -- The ledger facade has its own this; delegation must retain the owning runtime.
    const owner = this;
    return new class extends RequestAttemptLedger {
      override reset(): void {}
      override admit(purpose: RequestPurpose, reservation: number, signal?: AbortSignal): Promise<void> { return owner.acquire(agentId, purpose, reservation, signal); }
      override begin(purpose: RequestPurpose): number {
        const id = owner.begin(purpose);
        owner.#owners.set(id, { agentId, modelId }); owner.#open++; owner.#pending.delete(agentId); owner.#remainingAttempts--;
        owner.#active.set(id, { purpose, agentId, modelId });
        return id;
      }
      override settle(id: number, status: RequestAttemptStatus, usage: TokenUsageSample | null): void {
        owner.settle(id, status, usage); owner.#open--; owner.#active.delete(id); owner.#reservations.delete(agentId);
        if (usage === null) owner.stop(new RequestUsageIncompleteError());
        owner.wake();
      }
      override recordRejected(purpose: RequestPurpose): void { owner.#reservations.delete(agentId); owner.#pending.delete(agentId); owner.recordRejected(purpose); owner.wake(); }
      override snapshot(): RequestAttemptLedgerSnapshot { return { ...owner.snapshot(), complete: owner.usageComplete }; }
      override get remainingTokens(): number | undefined { return owner.remainingTokens; }
      override get usageComplete(): boolean { return owner.usageComplete; }
      override flush(): Promise<void> { return owner.flush(); }
    }();
  }
  stop(reason: unknown): void { this.#failure ??= reason; this.settings.onStop(reason); this.wake(); }
  // oxlint-disable-next-line unicorn/no-useless-spread -- Wake callbacks can mutate the waiter set; iterate its snapshot.
  wake(): void { for (const wake of [...this.#waiters]) wake(); }
  async acquire(agentId: string, _purpose: RequestPurpose, reservation: number, signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      if (this.#failure) throw this.#failure;
      if (!Number.isSafeInteger(reservation) || reservation < 0 || this.#pending.has(agentId) || [...this.#active.values()].some((entry) => entry.agentId === agentId)) throw new Error("Invalid or overlapping member request admission");
      if (Date.now() >= this.settings.deadline) { const error = new TeamLimitError("deadline_exceeded"); this.stop(error); throw error; }
      if (this.#remainingAttempts - this.#pending.size <= 0) { const error = new TeamLimitError("step_limit"); this.stop(error); throw error; }
      const remaining = this.remainingTokens;
      const reserved = [...this.#reservations.values()].reduce((sum, value) => sum + value, 0);
      if (remaining === undefined || remaining - reserved >= reservation) { this.#reservations.set(agentId, reservation); this.#pending.add(agentId); return; }
      if (this.#open === 0 && this.#reservations.size === 0) { const error = new TeamLimitError("budget_limited"); this.stop(error); throw error; }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { this.#waiters.delete(wake); signal?.removeEventListener("abort", abort); clearTimeout(timer); };
        const wake = () => { finish(); resolve(); };
        const abort = () => { finish(); reject(signal?.reason); };
        const timer = setTimeout(wake, Math.max(1, this.settings.deadline - Date.now()));
        this.#waiters.add(wake); signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
  override flush(): Promise<void> {
    this.#chain = this.#chain.then(this.#persist).catch((error: unknown) => { this.stop(error); throw error; });
    return this.#chain;
  }
}
