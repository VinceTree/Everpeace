import type { ChildProcess } from "node:child_process";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { processOwner, type OwnedProcess, type ProcessState } from './owned-process.js';
import { CleanupDeadline, CleanupTimeoutError } from '../util/cleanup-deadline.js';

export class ProcessCleanupError extends ResourceCleanupError {
  readonly resource = "process";
  readonly stage: string;
  readonly reason: 'deadline_exceeded' | 'ownership_unresolved';

  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message.startsWith("Process-tree cleanup failed:") ? message : `Process-tree cleanup failed: ${message}`, { cause });
    this.name = "ProcessCleanupError";
    this.stage = cause instanceof CleanupTimeoutError ? cause.stage : 'process_tree';
    this.reason = cause instanceof CleanupTimeoutError ? 'deadline_exceeded' : 'ownership_unresolved';
  }
}

/** Callers must create a detached process group on Unix. No shell is involved. */
export async function terminateProcessTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  const owner = processOwner(pid);
  if (owner) {
    owner.stop();
    const receipt = await new CleanupDeadline().wait(owner.receipt, 'owned_process_exit');
    if (receipt.status !== 'confirmed_exited') throw new Error('Owned process state is unknown');
    return;
  }
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = new CleanupDeadline();
    while (true) {
      try { process.kill(-pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
      await deadline.wait(new Promise<void>(resolve => setTimeout(resolve, 10)), 'unix_process_group_exit');
    }
  }
  throw new Error('Unowned Windows PID has no independently verified descendant ownership; taskkill was not invoked');
}

export interface ProcessCompletion {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cancelled: boolean;
  timedOut: boolean;
  error?: Error;
  cleanupError?: ProcessCleanupError;
  cleanupStatus?: ProcessState;
}

/** Own terminal events until both child close and any tree-kill request settle. */
export function observeProcessCompletion(child: ChildProcess, options: {
  signal?: AbortSignal;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  cleanupTimeoutMs?: number;
  owner?: OwnedProcess;
} = {}): { readonly closed: boolean; readonly stopping: boolean; completion: Promise<ProcessCompletion>; stop(): void } {
  let closed = false;
  let settled = false;
  let timedOut = false;
  let error: Error | undefined;
  let cleanupError: ProcessCleanupError | undefined;
  let cleanup: Promise<void> | undefined;
  const owner = options.owner ?? (child.pid ? processOwner(child.pid) : undefined);
  let cleanupStatus: ProcessState | undefined;
  let notifyClose!: () => void;
  const didClose = new Promise<void>(resolve => { notifyClose = resolve; });
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
      ...(error ? { error } : {}), ...(cleanupError ? { cleanupError } : {}), ...(cleanupStatus ? { cleanupStatus } : {}) });
  };
  const stop = () => {
    if (closed || settled || cleanup) return;
    // Reserve the promise before invoking platform code or reentrant observers.
    const deadline = new CleanupDeadline(options.cleanupTimeoutMs);
    cleanup = Promise.resolve().then(async () => {
      if (owner) {
        owner.stop();
        const receipt = await deadline.wait(owner.receipt, 'owned_process_exit');
        cleanupStatus = receipt.status;
        if (receipt.status !== 'confirmed_exited') throw new Error(`Owned process cleanup state is ${receipt.status}${receipt.winError === undefined ? '' : ` (Win32 ${receipt.winError})`}`);
      }
      else if (child.pid) { await deadline.wait(terminateProcessTree(child.pid, options.platform), 'process_tree'); cleanupStatus = 'confirmed_exited'; }
      else child.kill();
      await deadline.wait(didClose, 'launcher_close');
    }).catch(async (cause: unknown) => {
      cleanupStatus ??= 'unknown';
      cleanupError = new ProcessCleanupError(cause);
      if (!closed) {
        try { child.kill(); } catch { /* retain tree failure, still await close */ }
        try { await deadline.wait(didClose, 'fallback_launcher_close'); } catch { /* unknown state remains a fault */ }
      }
    }).then(() => {
      if (!closed && cleanupError) finish(null, null);
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
    notifyClose();
    detach();
    await cleanup;
    if (owner && !cleanupError) {
      try {
        const receipt = await new CleanupDeadline(options.cleanupTimeoutMs).wait(owner.receipt, 'process_exit_receipt');
        cleanupStatus = receipt.status;
        if (receipt.status !== 'confirmed_exited') throw new Error(`Native process ownership could not confirm exit${receipt.winError === undefined ? '' : ` (Win32 ${receipt.winError})`}`);
        if (receipt.winError !== undefined) {
          const code = receipt.winError === 2 || receipt.winError === 3 ? 'ENOENT' : receipt.winError === 5 ? 'EACCES' : 'NATIVE_LAUNCH_ERROR';
          error ??= Object.assign(new Error(`Process launch failed: ${code} (Win32 ${receipt.winError})`), { code });
        }
        exitCode = receipt.exitCode;
      } catch (cause) { cleanupStatus = 'unknown'; cleanupError = new ProcessCleanupError(cause); }
    }
    finish(exitCode, signal);
  });
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647)));
  }
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  return { get closed() { return closed; }, get stopping() { return cleanup !== undefined; }, completion, stop };
}
