import type { TokenUsageSample } from "../status/model-status.js";

export type RequestPurpose = "coding" | "summary" | "title" | "skill" | "memory" | "doctor" | "benchmark";
export type RequestAttemptStatus = "completed" | "failed" | "cancelled" | "rejected";

export class RequestUsageIncompleteError extends Error {
  constructor() {
    super("Request usage is incomplete; no further model requests may start");
    this.name = "RequestUsageIncompleteError";
  }
}

export interface RequestAttemptRecord {
  id: number;
  purpose: RequestPurpose;
  status: RequestAttemptStatus;
  usage: TokenUsageSample | null;
  agentId?: string;
  modelId?: string;
}

export interface RequestAttemptLedgerSnapshot {
  attempts: readonly RequestAttemptRecord[];
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  complete: boolean;
  tokenBudget?: number;
  remainingTokens?: number;
  exceededBy?: number;
}

/** Accounts at the provider-attempt boundary and keeps unknown usage sticky. */
export class RequestAttemptLedger {
  readonly #tokenBudget: number | undefined;
  readonly #open = new Map<number, RequestPurpose>();
  readonly #attempts: RequestAttemptRecord[] = [];
  #nextId = 1;
  #inputTokens = 0;
  #outputTokens = 0;
  #reasoningTokens = 0;
  #complete = true;
  readonly #imported = new Set<string>();

  constructor(options: { tokenBudget?: number } = {}) {
    if (options.tokenBudget !== undefined && (!Number.isSafeInteger(options.tokenBudget) || options.tokenBudget <= 0)) {
      throw new RangeError("tokenBudget must be a positive integer");
    }
    this.#tokenBudget = options.tokenBudget;
  }

  /** Team scopes override these boundaries; ordinary tasks retain their contract. */
  async admit(_purpose: RequestPurpose, _reservation: number, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); }
  async flush(): Promise<void> {}
  get usageComplete(): boolean { return this.#complete; }
  get openRequests(): number { return this.#open.size; }

  /** Start a new host task while retaining the configured budget contract. */
  reset(): void {
    if (this.#open.size > 0) throw new Error("Cannot reset request accounting while attempts are active");
    this.#attempts.length = 0;
    this.#nextId = 1;
    this.#inputTokens = 0;
    this.#outputTokens = 0;
    this.#reasoningTokens = 0;
    this.#complete = true;
    this.#imported.clear();
  }

  /** Evaluation rollup of an independently owned team ledger, after all its requests have settled. No admission or replay. */
  importSettledAttempts(namespace: string, attempts: readonly RequestAttemptRecord[]): void {
    for (const attempt of attempts) {
      const key = `${namespace}:${attempt.id}`;
      if (this.#imported.has(key)) continue;
      this.#imported.add(key);
      const usage = attempt.usage;
      if (usage === null) this.#complete = false;
      else {
        this.#inputTokens += usage.input_tokens;
        this.#outputTokens += usage.output_tokens;
        this.#reasoningTokens += usage.reasoning_tokens ?? 0;
      }
      this.#attempts.push({ ...attempt, id: this.#nextId++, usage: usage ? { ...usage } : null });
    }
  }

  begin(purpose: RequestPurpose): number {
    if (!this.#complete) throw new RequestUsageIncompleteError();
    if (this.remainingTokens !== undefined && this.remainingTokens <= 0) {
      throw new Error("The request token budget is exhausted");
    }
    const id = this.#nextId++;
    this.#open.set(id, purpose);
    return id;
  }

  recordRejected(purpose: RequestPurpose): void {
    this.#attempts.push({
      id: this.#nextId++,
      purpose,
      status: "rejected",
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });
  }

  settle(id: number, status: RequestAttemptStatus, usage: TokenUsageSample | null): void {
    const purpose = this.#open.get(id);
    if (!purpose) throw new Error(`Unknown or already settled request attempt: ${id}`);
    this.#open.delete(id);
    if (usage === null) {
      this.#complete = false;
    } else {
      this.#inputTokens += usage.input_tokens;
      this.#outputTokens += usage.output_tokens;
      this.#reasoningTokens += usage.reasoning_tokens ?? 0;
    }
    this.#attempts.push({ id, purpose, status, usage });
  }

  get remainingTokens(): number | undefined {
    return this.#tokenBudget === undefined
      ? undefined
      : this.#tokenBudget - this.#inputTokens - this.#outputTokens;
  }

  snapshot(): RequestAttemptLedgerSnapshot {
    const remainingTokens = this.remainingTokens;
    return {
      attempts: this.#attempts.map((attempt) => ({ ...attempt, usage: attempt.usage ? { ...attempt.usage } : null })),
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      reasoningTokens: this.#reasoningTokens,
      complete: this.#complete && this.#open.size === 0,
      ...(this.#tokenBudget === undefined ? {} : { tokenBudget: this.#tokenBudget }),
      ...(remainingTokens === undefined ? {} : { remainingTokens }),
      ...(remainingTokens !== undefined && remainingTokens < 0 ? { exceededBy: -remainingTokens } : {}),
    };
  }
}
