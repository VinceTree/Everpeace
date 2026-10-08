import { spawn, type ChildProcess } from "node:child_process";

export class ProcessCleanupError extends Error {
  constructor(cause: unknown) {
    super(`Process-tree cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "ProcessCleanupError";
  }
}

/** Callers must create a detached process group on Unix. No shell is involved. */
export async function terminateProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", reject);
    killer.once("close", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with ${code ?? "no exit code"}`)));
  });
}

export interface ProcessCompletion {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  timedOut: boolean;
  error?: Error;
  cleanupError?: ProcessCleanupError;
}

/** Own terminal events until both child close and any tree-kill request settle. */
export function observeProcessCompletion(child: ChildProcess, options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
} = {}): { readonly closed: boolean; completion: Promise<ProcessCompletion> } {
  let closed = false;
  let settled = false;
  let timedOut = false;
  let error: Error | undefined;
  let cleanupError: ProcessCleanupError | undefined;
  let cleanup: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: ProcessCompletion) => void;
  const completion = new Promise<ProcessCompletion>((accept) => { resolve = accept; });
  const detach = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", stop);
  };
  const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    settled = true;
    detach();
    resolve({ exitCode, signal, cancelled: options.signal?.aborted ?? false, timedOut,
      ...(error ? { error } : {}), ...(cleanupError ? { cleanupError } : {}) });
  };
  const stop = () => {
    if (closed || settled || cleanup) return;
    // Reserve the promise before invoking platform code or reentrant observers.
    cleanup = Promise.resolve().then(async () => {
      if (child.pid) await terminateProcessTree(child.pid, options.platform);
      else child.kill();
    }).catch((cause: unknown) => {
      cleanupError = new ProcessCleanupError(cause);
      if (!closed) {
        try { child.kill(); } catch { /* retain tree failure, still await close */ }
      }
    });
  };
  const failed = (cause: Error) => {
    if (closed || settled) return;
    error ??= cause;
    if (child.pid) stop();
    else { closed = true; finish(null, null); }
  };
  child.on("error", failed);
  child.stdin?.on("error", failed);
  child.once("close", async (exitCode, signal) => {
    if (settled) return;
    closed = true;
    detach();
    await cleanup;
    finish(exitCode, signal);
  });
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647)));
  }
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  return { get closed() { return closed; }, completion };
}
