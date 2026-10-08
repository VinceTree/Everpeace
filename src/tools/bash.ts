import { spawn } from "node:child_process";
import {
  BashOutputPreviewBuffer,
  type BashOutputPreview,
} from "./bash-output-preview.js";
import { observeProcessCompletion } from "./process-completion.js";
import { BoundedOutputBuffer } from "./command-record.js";
import { commandFailureFeedback } from "./tool-feedback.js";
import { codexCliLaunch, runCodexProcess } from "../codex/cli.js";
import {
  materializeSandboxControlPaths,
  modelShellEnvironment,
  nativePermissionProfileArgs,
  type EffectiveSandboxPolicy,
  type NativePermissionProfile,
} from "./sandbox-policy.js";

export type { BashOutputPreview } from "./bash-output-preview.js";

/** Model shell commands must not wait forever when a child ignores guidance. */
export const DEFAULT_MODEL_BASH_TIMEOUT_MS = 120_000;

export interface BashResult {
  cleanupFailed?: boolean;
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
  onProcessStarted?(): void;
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
    permissionProfile?: NativePermissionProfile;
    readableRoots?: readonly string[];
    policy?: EffectiveSandboxPolicy;
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
      value.command.trim().length > 0 &&
      !value.command.includes("\0") &&
      Object.keys(value).every((key) => key === "command")
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
    ...(result.cleanupFailed ? { cleanup_failed: true } : {}),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...commandFailureFeedback(result),
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
  const permissionProfile = sandbox.policy?.permissionProfile ?? sandbox.permissionProfile;
  if (!permissionProfile) throw new Error("Sandbox permission profile is required");
  const sandboxCommand = process.platform === "win32"
    ? { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
    : { command: bashPath, args: ["-c", command] };
  return [
    "sandbox",
    ...(sandbox.policy ? nativePermissionProfileArgs(sandbox.policy) : ["-P", permissionProfile]),
    "-C",
    cwd,
    ...((sandbox.policy?.readableRoots ?? sandbox.readableRoots)?.flatMap((root) => ["--sandbox-state-readable-root", root]) ?? []),
    ...(sandbox.policy?.networkMode === "deny" ? ["--sandbox-state-disable-network"] : []),
    "--include-managed-config",
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
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
  const append = (kind: "stdout" | "stderr", chunk: string) => {
    previewOutput?.push(chunk);
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
      ...(options.onProcessStarted ? { onSpawned: options.onProcessStarted } : {}),
      onStdout: (chunk) => append("stdout", chunk),
      onStderr: (chunk) => append("stderr", chunk),
    },
  );
  if (previewTimer) clearTimeout(previewTimer);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    signal: null,
    truncated: result.truncated === true,
    cancelled: result.cancelled,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.cleanupFailed ? { cleanupFailed: true } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

export async function runBash(
  command: string,
  options: BashOptions = {},
): Promise<BashResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true });
  }
  if (options.sandbox?.policy) {
    try {
      materializeSandboxControlPaths(options.sandbox.policy);
    } catch (error) {
      return Promise.resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        error: `Could not prepare sandbox control paths: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  const env = options.sandbox ? modelShellEnvironment(options.env ?? process.env) : options.env ?? process.env;
  const bashPath = options.bashPath ?? resolveBashPath(env);
  const streamOutput = options.streamOutput ?? true;
  const terminal = options.terminal ?? false;
  const cwd = options.cwd ?? process.cwd();

  if (options.sandbox && !terminal) {
    return runSandboxBash(command, options, env, bashPath, cwd, streamOutput);
  }

  const stdout = new BoundedOutputBuffer(1024 * 1024);
  const stderr = new BoundedOutputBuffer(1024 * 1024);
  let child;
  try {
    const launch = resolveBashLaunch(command, options);
    child = spawn(launch.command, launch.args, {
      detached: process.platform !== "win32", cwd, env, shell: false,
      stdio: terminal ? "inherit" : ["ignore", "pipe", "pipe"], windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: "", exitCode: null, signal: null, error: message };
  }
  const owned = observeProcessCompletion(child, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const previewOutput = options.onOutput ? new BashOutputPreviewBuffer() : undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  const append = (kind: "stdout" | "stderr", chunk: string) => {
    if (owned.closed) return;
    (kind === "stdout" ? stdout : stderr).append(chunk);
    previewOutput?.push(chunk);
    if (previewOutput && !previewTimer) {
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        if (owned.closed) return;
        try { options.onOutput?.(previewOutput.snapshot()); } catch { /* observers do not own the process */ }
      }, 80);
    }
    if (streamOutput) (kind === "stdout" ? process.stdout : process.stderr).write(chunk);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: string) => append("stderr", chunk));
  try { options.onProcessStarted?.(); } catch { /* observers do not own the process */ }
  const result = await owned.completion;
  if (previewTimer) clearTimeout(previewTimer);
  const error = result.cleanupError?.message ?? result.error?.message
    ?? (result.timedOut ? `Bash command timed out after ${options.timeoutMs ?? 0} ms` : undefined);
  return {
    stdout: stdout.text, stderr: stderr.text, exitCode: result.exitCode, signal: result.signal,
    truncated: stdout.truncated || stderr.truncated, cancelled: result.cancelled,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.cleanupError ? { cleanupFailed: true } : {}),
    ...(error ? { error } : {}),
  };
}
