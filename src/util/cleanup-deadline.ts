/** One monotonic deadline shared by nested cleanup operations. */
export class CleanupDeadline {
  readonly expiresAt: number;
  constructor(timeoutMs = 5000) { this.expiresAt = performance.now() + timeoutMs; }
  async wait<T>(operation: PromiseLike<T>, stage: string): Promise<T> {
    const pending = Promise.resolve(operation);
    // Late rejection remains observed even after the deadline has expired.
    void pending.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CleanupTimeoutError(stage)), Math.max(0, this.expiresAt - performance.now()));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
export class CleanupTimeoutError extends Error {
  readonly reason = 'deadline_exceeded';
  constructor(readonly stage: string) { super(`Cleanup deadline exceeded (${stage})`); this.name = 'CleanupTimeoutError'; }
}

export async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let abort!: () => void;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('Operation cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
