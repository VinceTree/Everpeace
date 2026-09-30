export interface PerformanceTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface PerformanceTraceSnapshot {
  timings: Readonly<Record<string, PerformanceTiming>>;
  counters: Readonly<Record<string, number>>;
}

/** Metadata-only performance trace. Callers must not put request or file contents in labels. */
export class PerformanceTrace {
  readonly #timings = new Map<string, PerformanceTiming>();
  readonly #counters = new Map<string, number>();

  record(operation: string, durationMs: number): void {
    if (!operation || !Number.isFinite(durationMs) || durationMs < 0) return;
    const current = this.#timings.get(operation) ?? { count: 0, totalMs: 0, maxMs: 0 };
    this.#timings.set(operation, {
      count: current.count + 1,
      totalMs: current.totalMs + durationMs,
      maxMs: Math.max(current.maxMs, durationMs),
    });
  }

  increment(counter: string, value = 1): void {
    if (!counter || !Number.isFinite(value)) return;
    this.#counters.set(counter, (this.#counters.get(counter) ?? 0) + value);
  }

  snapshot(): PerformanceTraceSnapshot {
    return {
      timings: Object.fromEntries([...this.#timings].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, { ...value }])),
      counters: Object.fromEntries([...this.#counters].sort(([left], [right]) => left.localeCompare(right))),
    };
  }
}
