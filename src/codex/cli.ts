import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { retainOutput } from "../tools/command-record.js";
import { stopProcessTree } from "../tools/process-cancel.js";

const require = createRequire(import.meta.url);

export interface CodexCliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cancelled: boolean;
  timedOut?: boolean;
  attempts?: number;
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
  onStdout?(chunk: string): void;
  onStderr?(chunk: string): void;
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
    const retryable = platform === "win32" && args[0] === "sandbox";
    let attempts = 0;
    const timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.max(1, Math.min(Math.floor(options.timeoutMs), 2_147_483_647))
      : undefined;

    const runAttempt = () => {
      let stdout = "";
      let stderr = "";
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
        resolve({ ...result, attempts: attempts + 1 });
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish({ stdout, stderr, exitCode: null, cancelled: false, error: message });
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
            stdout: retainOutput(stdout, 1024 * 1024).text,
            stderr: retainOutput(stderr, 1024 * 1024).text,
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
        stdout = retainOutput(stdout + chunk, 1024 * 1024).text;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        options.onStderr?.(chunk);
        stderr = retainOutput(stderr + chunk, 1024 * 1024).text;
      });
      child.on("error", (error) => {
        options.signal?.removeEventListener("abort", cancel);
        finish({
          stdout,
          stderr,
          exitCode: null,
          cancelled: options.signal?.aborted ?? false,
          error: error.message,
        });
      });
      child.on("close", (exitCode) => {
        options.signal?.removeEventListener("abort", cancel);
        const helperError = isSandboxHelperSetupError(`${stdout}\n${stderr}`);
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
          stdout,
          stderr,
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
