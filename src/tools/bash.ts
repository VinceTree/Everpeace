import { spawn } from "node:child_process";
import {
  BashOutputPreviewBuffer,
  type BashOutputPreview,
} from "./bash-output-preview.js";
import { stopProcessTree } from "./process-cancel.js";
import { retainOutput } from "./command-record.js";
import { codexCliLaunch } from "../codex/cli.js";

export type { BashOutputPreview } from "./bash-output-preview.js";

export interface BashResult {
  truncated?: boolean;
  cancelled?: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface BashOptions {
  signal?: AbortSignal;
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
  if (!options.sandbox) return { command: bashPath, args: ["-c", command] };
  const cwd = options.cwd ?? process.cwd();
  const sandboxCommand = process.platform === "win32"
    ? { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
    : { command: bashPath, args: ["-c", command] };
  return codexCliLaunch([
    "sandbox",
    "-P",
    options.sandbox.permissionProfile,
    "-C",
    cwd,
    ...(options.sandbox.readableRoots?.flatMap((root) => ["--sandbox-state-readable-root", root]) ?? []),
    "--",
    sandboxCommand.command,
    ...sandboxCommand.args,
  ], options.sandbox.codexCliPath ? { codexCliPath: options.sandbox.codexCliPath } : {});
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

  return new Promise((resolve) => {
    if (options.signal?.aborted) { resolve({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true }); return; }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let truncated = false;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
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

    const cancel = () => { if (child.pid) stopProcessTree(child.pid); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();

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
      finish({ stdout: out.text, stderr: err.text, exitCode, signal, truncated: truncated || out.truncated || err.truncated, cancelled: options.signal?.aborted ?? false });
    });
  });
}
