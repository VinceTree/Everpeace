import { spawn } from "node:child_process";

export interface BashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface BashOptions {
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
}

export const BASH_TOOL_DEFINITION = {
  type: "function",
  name: "bash",
  description:
    "Run one Bash command in the user's current working directory. Use it to inspect files, run programs, and complete coding tasks.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The complete command to pass to bash -c.",
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
    ...(result.error === undefined ? {} : { error: result.error }),
  });
}

export function resolveBashPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVERPEACE_BASH_PATH?.trim() || "bash";
}

export function runBash(
  command: string,
  options: BashOptions = {},
): Promise<BashResult> {
  const env = options.env ?? process.env;
  const bashPath = options.bashPath ?? resolveBashPath(env);
  const streamOutput = options.streamOutput ?? true;
  const terminal = options.terminal ?? false;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: BashResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(bashPath, ["-c", command], {
        cwd: options.cwd ?? process.cwd(),
        env,
        shell: false,
        stdio: terminal ? "inherit" : ["inherit", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (streamOutput) process.stderr.write(`Failed to start Bash: ${message}\n`);
      finish({ stdout, stderr, exitCode: null, signal: null, error: message });
      return;
    }

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (streamOutput) process.stdout.write(chunk);
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (streamOutput) process.stderr.write(chunk);
      });
    }

    child.on("error", (error) => {
      const message = error.message;
      if (streamOutput) process.stderr.write(`Failed to start Bash: ${message}\n`);
      finish({ stdout, stderr, exitCode: null, signal: null, error: message });
    });

    child.on("close", (exitCode, signal) => {
      finish({ stdout, stderr, exitCode, signal });
    });
  });
}
