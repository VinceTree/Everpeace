import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { stopProcessTree } from "../tools/process-cancel.js";

const require = createRequire(import.meta.url);

export interface CodexCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut?: boolean;
  attempts?: number;
  truncated?: boolean;
  error?: string;
}

export interface CodexCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  codexCliPath?: string;
  /** Used by tests and callers that need to model another host platform. */
  platform?: NodeJS.Platform;
}

/** A transient Windows sandbox helper setup failure is safe to retry once. */
export const WINDOWS_SANDBOX_HELPER_RETRY_LIMIT = 1;

export function isSandboxHelperSetupError(text: string): boolean {
  const normalized = text.toLowerCase();
  if (normalized.includes("helper_unknown_error")) return true;
  return normalized.includes("sandbox")
    && normalized.includes("helper")
    && (normalized.includes("setup") || normalized.includes("refresh") || normalized.includes("unknown"));
}

export function resolveCodexCliPath(): string {
  return require.resolve("@openai/codex/bin/codex.js");
}

export function codexCliLaunch(
  args: readonly string[],
  options: CodexCliOptions = {},
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [options.codexCliPath ?? resolveCodexCliPath(), ...args],
  };
}

export interface CodexProcessCallbacks {
  onSpawned?(): void;
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
}

export interface CodexDuplexExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stderrTruncated: boolean;
}

export interface CodexDuplexProcess {
  readonly stdout: Readable;
  readonly exit: Promise<CodexDuplexExit>;
  write(data: Uint8Array | string): Promise<void>;
  closeInput(): void;
  terminate(): Promise<CodexDuplexExit>;
}

export interface CodexDuplexOptions extends CodexCliOptions {
  stderrMaxBytes?: number;
  terminationTimeoutMs?: number;
}

async function terminateDuplexProcessTree(pid: number, platform: NodeJS.Platform): Promise<void> {
  if (platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", reject);
    killer.once("close", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with ${code ?? "no exit code"}`)));
  });
}

/** Start one raw-stdio command inside the pinned native sandbox launcher. */
export function startCodexDuplexProcess(
  args: readonly string[],
  options: CodexDuplexOptions = {},
): CodexDuplexProcess {
  const launch = codexCliLaunch(args, options);
  const child: ChildProcessWithoutNullStreams = spawn(launch.command, launch.args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    detached: (options.platform ?? process.platform) !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stderr = new BoundedOutputBuffer(options.stderrMaxBytes ?? 64 * 1024);
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
  let settled = false;
  let settle!: (value: CodexDuplexExit) => void;
  let rejectExit!: (error: Error) => void;
  const exit = new Promise<CodexDuplexExit>((resolve, reject) => { settle = resolve; rejectExit = reject; });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    rejectExit(error);
  });
  child.once("close", (exitCode, signal) => {
    if (settled) return;
    settled = true;
    settle({ exitCode, signal, stderr: stderr.text, stderrTruncated: stderr.truncated });
  });

  const write = async (data: Uint8Array | string): Promise<void> => {
    if (settled || child.stdin.destroyed) throw new Error("Sandboxed process stdin is closed");
    if (child.stdin.write(data)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.stdin.off("drain", drained);
        child.stdin.off("error", failed);
        child.off("close", closed);
      };
      const drained = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closed = () => { cleanup(); reject(new Error("Sandboxed process closed while writing")); };
      child.stdin.once("drain", drained);
      child.stdin.once("error", failed);
      child.once("close", closed);
    });
  };

  return {
    stdout: child.stdout,
    exit,
    write,
    closeInput() { if (!child.stdin.destroyed) child.stdin.end(); },
    async terminate() {
      let terminationError: unknown;
      if (!settled) {
        try {
          if (child.pid) await terminateDuplexProcessTree(child.pid, options.platform ?? process.platform);
          else child.kill();
        } catch (error) {
          if (!settled) {
            terminationError = error;
            try { child.kill(); } catch { /* preserve the process-tree cleanup error */ }
          }
        }
      }
      const timeoutMs = options.terminationTimeoutMs ?? 5_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          exit,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Sandboxed process did not exit within ${timeoutMs}ms`)), timeoutMs);
            timer.unref?.();
          }),
        ]);
        if (terminationError) throw new Error(`Sandboxed process-tree cleanup failed: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`);
        return result;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/** Execute a Codex CLI command with one bounded Windows sandbox retry. */
export function runCodexProcess(
  args: readonly string[],
  options: CodexCliOptions & CodexProcessCallbacks = {},
): Promise<CodexCliResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: null, cancelled: true });
      return;
    }

    const platform = options.platform ?? process.platform;
    // stdout/stderr cannot prove that a payload has not started. Only the legacy
    // profile-only invocation is known to contain no command (with or without --).
    const retryable = platform === "win32" && args.length === 3 && args[0] === "sandbox"
      && args[1] === "-P" && [":read-only", ":workspace", ":danger-full-access"].includes(args[2]!);
    let attempts = 0;
    const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.max(1, Math.min(Math.floor(options.timeoutMs), 2_147_483_647))
      : undefined;

    const runAttempt = () => {
      const stdoutBuffer = new BoundedOutputBuffer(1024 * 1024);
      const stderrBuffer = new BoundedOutputBuffer(1024 * 1024);
      let settled = false;
      let timedOut = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      let child;
      const finish = (result: CodexCliResult) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (cancelTimer) clearTimeout(cancelTimer);
        resolve({ ...result, attempts: attempts + 1, truncated: result.truncated === true || stdoutBuffer.truncated || stderrBuffer.truncated });
      };
      try {
        const launch = codexCliLaunch(args, options);
        child = spawn(launch.command, launch.args, {
          cwd: options.cwd ?? process.cwd(),
          env: options.env ?? process.env,
          detached: platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        options.onSpawned?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish({ stdout: stdoutBuffer.text, stderr: stderrBuffer.text, exitCode: null, cancelled: false, error: message });
        return;
      }

      const cancel = () => {
        if (child.pid) stopProcessTree(child.pid);
        if (cancelTimer) return;
        cancelTimer = setTimeout(() => {
          if (settled) return;
          try { child.kill(); } catch { /* process may already be gone */ }
          options.signal?.removeEventListener("abort", cancel);
          finish({
            stdout: stdoutBuffer.text,
            stderr: stderrBuffer.text,
            exitCode: null,
            cancelled: options.signal?.aborted ?? false,
            ...(timedOut ? { timedOut: true, error: `Codex CLI command timed out after ${timeoutMs ?? 0} ms` } : {}),
          });
        }, 500);
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        options.onStdout?.(chunk);
        stdoutBuffer.append(chunk);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        options.onStderr?.(chunk);
        stderrBuffer.append(chunk);
      });
      child.on("error", (error) => {
        options.signal?.removeEventListener("abort", cancel);
        finish({
          stdout: stdoutBuffer.text,
          stderr: stderrBuffer.text,
          exitCode: null,
          cancelled: options.signal?.aborted ?? false,
          error: error.message,
        });
      });
      child.on("close", (exitCode) => {
        if (settled) return;
        options.signal?.removeEventListener("abort", cancel);
        const helperError = retryable && exitCode !== 0 && isSandboxHelperSetupError(stderrBuffer.text);
        if (
          retryable
          && !options.signal?.aborted
          && !timedOut
          && helperError
          && attempts < WINDOWS_SANDBOX_HELPER_RETRY_LIMIT
        ) {
          attempts += 1;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (cancelTimer) clearTimeout(cancelTimer);
          settled = true;
          runAttempt();
          return;
        }
        finish({
          stdout: stdoutBuffer.text,
          stderr: stderrBuffer.text,
          exitCode,
          cancelled: options.signal?.aborted ?? false,
          ...(timedOut ? { timedOut: true, error: `Codex CLI command timed out after ${timeoutMs ?? 0} ms` } : {}),
          ...(helperError && attempts >= WINDOWS_SANDBOX_HELPER_RETRY_LIMIT
            ? { error: "Codex sandbox helper setup failed after a bounded retry" }
            : {}),
        });
      });
      if (timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
      }
    };

    runAttempt();
  });
}

export function runCodexCli(
  args: readonly string[],
  options: CodexCliOptions = {},
): Promise<CodexCliResult> {
  return runCodexProcess(args, options);
}

export async function readCodexCliJson<T>(
  args: readonly string[],
  options: CodexCliOptions = {},
): Promise<T> {
  const result = await runCodexCli(args, options);
  if (result.cancelled) throw new Error("Codex CLI request was cancelled");
  if (result.error) throw new Error(`Could not start Codex CLI: ${result.error}`);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode ?? "unknown"}`;
    throw new Error(`Codex CLI failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error("Codex CLI returned invalid JSON");
  }
}
