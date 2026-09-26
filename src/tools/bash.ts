import { spawn } from "node:child_process";
import {
  BashOutputPreviewBuffer,
  type BashOutputPreview,
} from "./bash-output-preview.js";
import { stopProcessTree } from "./process-cancel.js";
import { retainOutput } from "./command-record.js";
import { codexCliLaunch, runCodexProcess } from "../codex/cli.js";

export type { BashOutputPreview } from "./bash-output-preview.js";

/** Model shell commands must not wait forever when a child ignores guidance. */
export const DEFAULT_MODEL_BASH_TIMEOUT_MS = 120_000;

export interface BashResult {
  truncated?: boolean;
  cancelled?: boolean;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface BashOptions {
  signal?: AbortSignal;
  /** Stop the child after this many milliseconds. Omit for no timeout. */
  timeoutMs?: number;
  onOutput?(output: BashOutputPreview): void;
  bashPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  streamOutput?: boolean;
  /**
   * Attach the child directly to the current terminal. This preserves TTY-aware
   * layouts, ANSI colors and interactive stdin, but stdout/stderr cannot also
   * be captured in the returned result.
   */
  terminal?: boolean;
  sandbox?: {
    permissionProfile: ":read-only" | ":workspace" | ":danger-full-access";
    readableRoots?: readonly string[];
    codexCliPath?: string;
  };
}

export const BASH_TOOL_DEFINITION = {
  type: "function",
  name: "bash",
  description:
    process.platform === "win32"
      ? "Run one PowerShell command in the user's current working directory through the Codex Windows sandbox. Use PowerShell syntax."
      : "Run one Bash command in the user's current working directory through the Codex OS sandbox.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: process.platform === "win32"
          ? "The complete command to pass to PowerShell -Command."
          : "The complete command to pass to bash -c.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  strict: true,
} as const;

export function parseBashCommand(argumentsJson: string): string | undefined {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    if (
      typeof value === "object" &&
      value !== null &&
      "command" in value &&
      typeof value.command === "string" &&
      value.command.length > 0
    ) {
      return value.command;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function serializeBashResult(result: BashResult): string {
  return JSON.stringify({
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    signal: result.signal,
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.timedOut ? { timed_out: true } : {}),
    ...(result.error === undefined ? {} : { error: result.error }),
  });
}

export function resolveBashPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVERPEACE_BASH_PATH?.trim() || "bash";
}

export function resolveBashLaunch(
  command: string,
  options: BashOptions = {},
): { command: string; args: string[] } {
  const env = options.env ?? process.env;
  const bashPath = options.bashPath ?? resolveBashPath(env);
  if (!options.sandbox) {
    const configuredBashPath = options.bashPath ?? env.EVERPEACE_BASH_PATH?.trim();
    if (process.platform === "win32" && !configuredBashPath) {
      return {
        command: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      };
    }
    return { command: bashPath, args: ["-c", command] };
  }
  const cwd = options.cwd ?? process.cwd();
  return codexCliLaunch(resolveSandboxArgs(command, options, bashPath, cwd), options.sandbox.codexCliPath ? { codexCliPath: options.sandbox.codexCliPath } : {});
}

function resolveSandboxArgs(
  command: string,
  options: BashOptions,
  bashPath: string,
  cwd: string,
): string[] {
  const sandbox = options.sandbox;
  if (!sandbox) throw new Error("Sandbox options are required");
  const sandboxCommand = process.platform === "win32"
    ? { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
    : { command: bashPath, args: ["-c", command] };
  return [
    "sandbox",
    "-P",
    sandbox.permissionProfile,
    "-C",
    cwd,
    ...(sandbox.readableRoots?.flatMap((root) => ["--sandbox-state-readable-root", root]) ?? []),
    "--",
    sandboxCommand.command,
    ...sandboxCommand.args,
  ];
}

async function runSandboxBash(
  command: string,
  options: BashOptions,
  env: NodeJS.ProcessEnv,
  bashPath: string,
  cwd: string,
  streamOutput: boolean,
): Promise<BashResult> {
  const previewOutput = options.onOutput ? new BashOutputPreviewBuffer() : undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const preview = () => {
    if (!options.onOutput || !previewOutput || previewTimer) return;
    previewTimer = setTimeout(() => {
      previewTimer = undefined;
      options.onOutput?.(previewOutput.snapshot());
    }, 80);
  };
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const append = (kind: "stdout" | "stderr", chunk: string) => {
    previewOutput?.push(chunk);
    if (kind === "stdout") stdout += chunk;
    else stderr += chunk;
    const retained = retainOutput(kind === "stdout" ? stdout : stderr, 1024 * 1024);
    if (kind === "stdout") stdout = retained.text;
    else stderr = retained.text;
    truncated ||= retained.truncated;
    preview();
    if (streamOutput) (kind === "stdout" ? process.stdout : process.stderr).write(chunk);
  };
  const result = await runCodexProcess(
    resolveSandboxArgs(command, options, bashPath, cwd),
    {
      cwd,
      env,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.sandbox?.codexCliPath ? { codexCliPath: options.sandbox.codexCliPath } : {}),
      onStdout: (chunk) => append("stdout", chunk),
      onStderr: (chunk) => append("stderr", chunk),
    },
  );
  if (previewTimer) clearTimeout(previewTimer);
  const out = retainOutput(stdout);
  const err = retainOutput(stderr);
  return {
    stdout: out.text,
    stderr: err.text,
    exitCode: result.exitCode,
    signal: null,
    truncated: truncated || out.truncated || err.truncated,
    cancelled: result.cancelled,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

export function runBash(
  command: string,
  options: BashOptions = {},
): Promise<BashResult> {
  const env = options.env ?? process.env;
  const bashPath = options.bashPath ?? resolveBashPath(env);
  const streamOutput = options.streamOutput ?? true;
  const terminal = options.terminal ?? false;
  const cwd = options.cwd ?? process.cwd();

  if (options.sandbox && !terminal) {
    return runSandboxBash(command, options, env, bashPath, cwd, streamOutput);
  }

  return new Promise((resolve) => {
    if (options.signal?.aborted) { resolve({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true }); return; }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let truncated = false;
    let timedOut = false;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let effectiveTimeoutMs: number | undefined;
    const previewOutput = options.onOutput
      ? new BashOutputPreviewBuffer()
      : undefined;
    const preview = () => {
      if (!options.onOutput || !previewOutput || previewTimer) return;
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        options.onOutput?.(previewOutput.snapshot());
      }, 80);
    };

    const finish = (result: BashResult): void => {
      if (settled) return;
      settled = true;
      if (previewTimer) clearTimeout(previewTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (cancelTimer) clearTimeout(cancelTimer);
      resolve(result);
    };

    let child;
    try {
      const launch = resolveBashLaunch(command, options);
      child = spawn(launch.command, launch.args, {
        detached: process.platform !== "win32",
        cwd,
        env,
        shell: false,
        stdio: terminal ? "inherit" : ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (streamOutput) process.stderr.write(`Failed to start ${options.sandbox ? "Codex sandbox" : "Bash"}: ${message}\n`);
      finish({ stdout, stderr, exitCode: null, signal: null, error: message });
      return;
    }

    const cancel = () => {
      if (child.pid) stopProcessTree(child.pid);
      if (cancelTimer) return;
      cancelTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill(); } catch { /* the process may already be gone */ }
        options.signal?.removeEventListener("abort", cancel);
        finish({
          stdout: retainOutput(stdout).text,
          stderr: retainOutput(stderr).text,
          exitCode: null,
          signal: null,
          cancelled: options.signal?.aborted ?? false,
          ...(timedOut ? { timedOut: true, error: `Bash command timed out after ${effectiveTimeoutMs ?? 0} ms` } : {}),
        });
      }, 500);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();

    const timeoutMs = options.timeoutMs;
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      effectiveTimeoutMs = Math.max(1, Math.min(Math.floor(timeoutMs), 2_147_483_647));
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        cancel();
      }, effectiveTimeoutMs);
    }

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        previewOutput?.push(chunk);
        stdout += chunk;
        const retained = retainOutput(stdout, 1024 * 1024);
        stdout = retained.text;
        truncated ||= retained.truncated;
        preview();
        if (streamOutput) process.stdout.write(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        previewOutput?.push(chunk);
        stderr += chunk;
        const retained = retainOutput(stderr, 1024 * 1024);
        stderr = retained.text;
        truncated ||= retained.truncated;
        preview();
        if (streamOutput) process.stderr.write(chunk);
      });
    }

    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", cancel);
      const message = error.message;
      if (streamOutput) process.stderr.write(`Failed to start ${options.sandbox ? "Codex sandbox" : "Bash"}: ${message}\n`);
      finish({ stdout, stderr, exitCode: null, signal: null, error: message });
    });

    child.on("close", (exitCode, signal) => {
      options.signal?.removeEventListener("abort", cancel);
      const out = retainOutput(stdout);
      const err = retainOutput(stderr);
      finish({
        stdout: out.text,
        stderr: err.text,
        exitCode,
        signal,
        truncated: truncated || out.truncated || err.truncated,
        cancelled: options.signal?.aborted ?? false,
        ...(timedOut ? { timedOut: true, error: `Bash command timed out after ${effectiveTimeoutMs ?? 0} ms` } : {}),
      });
    });
  });
}
