import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvidenceFailure, MemoryRequestGate, writeJson } from "./memory-evidence.js";
import type { MemoryServiceFailure } from "./memory-service-errors.js";

export interface MemoryServicePause {
  sampleKey: string; reason: string; failure?: MemoryServiceFailure;
  startedAt: string; resumeAfter: string; cooldownMs: number; consecutiveFailures: number;
}

/** Shared admission pauses until all owned requests settle; it never resets a ledger. */
export class MemoryServiceAdmission {
  #active = 0; #peak = 0; #failures = 0; #resumeAt = 0; #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #receipt: Promise<void> = Promise.resolve();
  readonly #waiters = new Set<() => void>();
  constructor(readonly options: {
    limit: number; cooldownMs: number; maxCooldownMs: number;
    persist(pause: MemoryServicePause): Promise<void>;
    fatal(error: unknown): void;
    stopReason(): string | undefined;
  }) {}
  get peak(): number { return this.#peak; }
  get active(): number { return this.#active; }
  #wake(): void { for (const wake of this.#waiters) wake(); }
  #check(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#stopped || this.options.stopReason()) throw new EvidenceFailure(this.options.stopReason() ?? "admission_closed");
  }
  async enter(signal: AbortSignal): Promise<() => void> {
    while (true) {
      this.#check(signal); const receipt = this.#receipt; await receipt; this.#check(signal);
      if (receipt !== this.#receipt) continue;
      if (this.#resumeAt && this.#active === 0 && Date.now() >= this.#resumeAt) this.#resumeAt = 0;
      if (!this.#resumeAt && this.#active < this.options.limit) {
        this.#active++; this.#peak = Math.max(this.#peak, this.#active); let released = false;
        return () => { if (released) return; released = true; this.#active--; this.#wake(); };
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => { this.#waiters.delete(wake); signal.removeEventListener("abort", abort); resolve(); };
        const abort = () => { this.#waiters.delete(wake); signal.removeEventListener("abort", abort); reject(signal.reason); };
        this.#waiters.add(wake); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }
  success(): void { this.#failures = 0; }
  pause(sampleKey: string, reason: string, failure?: MemoryServiceFailure): void {
    if (this.#stopped || this.options.stopReason()) return;
    const cooldownMs = Math.min(this.options.maxCooldownMs, Math.max(this.options.cooldownMs * 2 ** Math.min(this.#failures++, 10), (failure?.retryAfterSeconds ?? 0) * 1000));
    this.#resumeAt = Math.max(this.#resumeAt, Date.now() + cooldownMs);
    const pause: MemoryServicePause = { sampleKey, reason, ...(failure ? { failure } : {}), startedAt: new Date().toISOString(), resumeAfter: new Date(this.#resumeAt).toISOString(), cooldownMs, consecutiveFailures: this.#failures };
    this.#receipt = this.#receipt.then(() => this.options.persist(pause)).catch(error => { this.stop(); this.options.fatal(error); });
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#wake(); }, Math.max(0, this.#resumeAt - Date.now()));
    this.#wake();
  }
  stop(): void { this.#stopped = true; if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; this.#wake(); }
  async close(): Promise<void> { this.stop(); await this.#receipt; if (this.#active !== 0) throw new EvidenceFailure("unresolved_requests"); }
}

export function memoryServiceAdmission(root: string, stopReason: () => string | undefined, fatal: (error: unknown) => void): MemoryServiceAdmission {
  return new MemoryServiceAdmission({ limit: 2, cooldownMs: 60000, maxCooldownMs: 900000, stopReason, fatal,
    persist: pause => writeJson(path.join(root, "service-pauses", `${randomUUID()}.json`), pause, true) });
}

/** A service fault closes only this independent sample; durable evidence faults close the campaign. */
export function memorySampleGate(directory: string, sampleKey: string, campaign: MemoryRequestGate, admission: MemoryServiceAdmission): MemoryRequestGate {
  const sample = new MemoryRequestGate(directory, 1, {
    beforeRequest: signal => admission.enter(signal), onSuccess: () => admission.success(), fatalReason: () => campaign.stopReason,
    onStop: reason => {
      if ((reason === "service_error" || reason === "usage_unknown") && sample.serviceFailure?.transient !== false) {
        admission.pause(sampleKey, reason, sample.serviceFailure); return;
      }
      if (sample.storageFailure) campaign.storageFailure ??= sample.storageFailure;
      campaign.stop(sample.serviceFailure?.transient === false ? `service_${sample.serviceFailure.category}` : reason);
      admission.stop();
    },
  });
  return sample;
}
