import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { observeProcessCompletion } from "../tools/process-completion.js";

const require = createRequire(import.meta.url);

export interface CodexCliResult {
  cleanupFailed?: boolean;
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
  // Pin the Windows enforcement backend as well as its package. Legacy token
  // sessions do not establish direct-socket denial for the LSP policy.
  const nativeArgs = [...args];
  if ((options.platform ?? process.platform) === "win32" && nativeArgs[0] === "sandbox") {
    const delimiter = nativeArgs.indexOf("--");
    nativeArgs.splice(delimiter < 0 ? nativeArgs.length : delimiter, 0, "-c", "windows.sandbox=mxc");
  }
  return {
    command: process.execPath,
    args: [options.codexCliPath ?? resolveCodexCliPath(), ...nativeArgs],
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
}

/** Start one raw-stdio command inside the pinned native sandbox launcher. */
export function startCodexDuplexProcess(
  args: readonly string[],
  options: CodexDuplexOptions = {},
): CodexDuplexProcess {
  options.signal?.throwIfAborted();
  const launch = codexCliLaunch(args, options);
  const child: ChildProcessWithoutNullStreams = spawn(launch.command, launch.args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    detached: (options.platform ?? process.platform) !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const owned = observeProcessCompletion(child, {
    platform: options.platform ?? process.platform,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const stderr = new BoundedOutputBuffer(options.stderrMaxBytes ?? 64 * 1024);
  child.stderr.on("data", (chunk: Buffer) => {
    if (!owned.closed) stderr.append(chunk.toString("utf8"));
  });
  const exit = owned.completion.then((result): CodexDuplexExit => {
    if (result.cleanupError) throw result.cleanupError;
    if (result.error) throw result.error;
    return { exitCode: result.exitCode, signal: result.signal, stderr: stderr.text, stderrTruncated: stderr.truncated };
  });
  let inputClosed = false;
  let termination: Promise<CodexDuplexExit> | undefined;

  const write = async (data: Uint8Array | string): Promise<void> => {
    if (owned.closed || owned.stopping || inputClosed || child.stdin.destroyed) throw new Error("Sandboxed process stdin is closed");
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
    closeInput() {
      if (inputClosed) return;
      inputClosed = true;
      if (!child.stdin.destroyed) child.stdin.end();
    },
    terminate() {
      if (!termination) {
        owned.stop();
        termination = owned.completion.then((result): CodexDuplexExit => {
          if (result.cleanupError) throw result.cleanupError;
          return { exitCode: result.exitCode, signal: result.signal, stderr: stderr.text, stderrTruncated: stderr.truncated };
        });
      }
      return termination;
    },
  };
}

/** Execute a Codex CLI command with one bounded Windows sandbox retry. */
export async function runCodexProcess(
  args: readonly string[],
  options: CodexCliOptions & CodexProcessCallbacks = {},
): Promise<CodexCliResult> {
  if (options.signal?.aborted) return { stdout: "", stderr: "", exitCode: null, cancelled: true };
  const platform = options.platform ?? process.platform;
  // Payload output cannot prove that a command has not run.
  const retryable = platform === "win32" && args.length === 3 && args[0] === "sandbox"
    && args[1] === "-P" && [":read-only", ":workspace", ":danger-full-access"].includes(args[2]!);
  for (let attempts = 1; ; attempts++) {
    const stdout = new BoundedOutputBuffer(1024 * 1024);
    const stderr = new BoundedOutputBuffer(1024 * 1024);
    let child;
    try {
      const launch = codexCliLaunch(args, options);
      child = spawn(launch.command, launch.args, {
        cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env,
        detached: platform !== "win32", shell: false,
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch (error) {
      return { stdout: "", stderr: "", exitCode: null, cancelled: false, attempts,
        error: error instanceof Error ? error.message : String(error) };
    }
    const owned = observeProcessCompletion(child, {
      platform,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (owned.closed) return;
      stdout.append(chunk);
      try { options.onStdout?.(chunk); } catch { /* observers do not own process lifetime */ }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (owned.closed) return;
      stderr.append(chunk);
      try { options.onStderr?.(chunk); } catch { /* observers do not own process lifetime */ }
    });
    try { options.onSpawned?.(); } catch { /* observers do not own process lifetime */ }
    const result = await owned.completion;
    const helperError = retryable && result.exitCode !== 0 && isSandboxHelperSetupError(stderr.text);
    if (helperError && !result.cancelled && !result.timedOut && !result.error && !result.cleanupError
      && attempts <= WINDOWS_SANDBOX_HELPER_RETRY_LIMIT) continue;
    const error = result.cleanupError?.message ?? result.error?.message
      ?? (result.timedOut ? `Codex CLI command timed out after ${options.timeoutMs ?? 0} ms` : undefined)
      ?? (helperError ? "Codex sandbox helper setup failed after a bounded retry" : undefined);
    return {
      stdout: stdout.text, stderr: stderr.text, exitCode: result.exitCode, cancelled: result.cancelled,
      attempts, truncated: stdout.truncated || stderr.truncated,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.cleanupError ? { cleanupFailed: true } : {}),
      ...(error ? { error } : {}),
    };
  }
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
