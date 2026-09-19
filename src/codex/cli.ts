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
  error?: string;
}

export interface CodexCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  codexCliPath?: string;
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

export function runCodexCli(
  args: readonly string[],
  options: CodexCliOptions = {},
): Promise<CodexCliResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: null, cancelled: true });
      return;
    }

    const launch = codexCliLaunch(args, options);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CodexCliResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        detached: process.platform !== "win32",
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
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = retainOutput(stdout + chunk, 1024 * 1024).text;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
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
      finish({
        stdout,
        stderr,
        exitCode,
        cancelled: options.signal?.aborted ?? false,
      });
    });
  });
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
