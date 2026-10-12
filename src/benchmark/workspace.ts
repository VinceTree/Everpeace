import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { BenchmarkWorkspaceGitSnapshot, BenchmarkWorkspaceSnapshot } from "./types.js";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { observeProcessCompletion, ProcessCleanupError } from "../tools/process-completion.js";

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitCommandResult> {
  signal?.throwIfAborted();
  const child = spawn("git", [...args], {
    cwd, detached: process.platform !== "win32", windowsHide: true, shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const owned = observeProcessCompletion(child, signal ? { signal } : {});
  const stdout = new BoundedOutputBuffer(MAX_GIT_OUTPUT_BYTES);
  const stderr = new BoundedOutputBuffer(MAX_GIT_OUTPUT_BYTES);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { if (!owned.closed) stdout.append(chunk); });
  child.stderr?.on("data", (chunk: string) => { if (!owned.closed) stderr.append(chunk); });
  const result = await owned.completion;
  if (result.cleanupError) throw result.cleanupError;
  signal?.throwIfAborted();
  if (result.error) throw result.error;
  return { exitCode: result.exitCode, stdout: stdout.text, stderr: stderr.text };
}

function commandText(result: GitCommandResult, args: readonly string[]): string {
  const detail = result.stderr.trim() || `exit code ${result.exitCode ?? "unknown"}`;
  return `git ${args.join(" ")} failed: ${detail}`;
}

export interface CaptureWorkspaceSnapshotOptions {
  omitDiff?: boolean;
  signal?: AbortSignal;
  now?: () => number;
}

/** Capture non-destructive Git state without changing the workspace. */
export async function captureWorkspaceSnapshot(
  workspacePath: string,
  options: CaptureWorkspaceSnapshotOptions = {},
): Promise<BenchmarkWorkspaceSnapshot> {
  const now = options.now ?? Date.now;
  const capturedAt = new Date(now()).toISOString();
  if (options.signal?.aborted) {
    return { capturedAt, workspacePath, error: "Workspace snapshot was cancelled" };
  }
  try {
    const rootResult = await runGit(["rev-parse", "--show-toplevel"], workspacePath, options.signal);
    if (rootResult.exitCode !== 0) {
      return { capturedAt, workspacePath, error: commandText(rootResult, ["rev-parse", "--show-toplevel"]) };
    }
    const root = rootResult.stdout.trim();
    const commands = await Promise.allSettled([
      runGit(["rev-parse", "HEAD"], workspacePath, options.signal),
      runGit(["branch", "--show-current"], workspacePath, options.signal),
      runGit(["status", "--porcelain=v1"], workspacePath, options.signal),
      options.omitDiff ? Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) : runGit(["diff", "--binary", "--no-ext-diff"], workspacePath, options.signal),
    ]);
    const failures = commands.filter((result) => result.status === "rejected");
    const failure = failures.find((result) => result.reason instanceof ProcessCleanupError) ?? failures[0];
    if (failure) throw failure.reason;
    const [headResult, branchResult, statusResult, diffResult] = commands.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    }) as [GitCommandResult, GitCommandResult, GitCommandResult, GitCommandResult];
    const diffBuffer = new BoundedOutputBuffer(MAX_GIT_OUTPUT_BYTES);
    diffBuffer.append(diffResult.stdout);
    const diff = diffBuffer.result();
    const git: BenchmarkWorkspaceGitSnapshot = {
      root,
      head: headResult.exitCode === 0 ? headResult.stdout.trim() || null : null,
      branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null,
      status: statusResult.exitCode === 0 ? statusResult.stdout : statusResult.stderr,
      diffHash: diff.text.length === 0 ? null : createHash("sha256").update(diff.text).digest("hex"),
      diff: diff.text,
      ...(diff.truncated ? { diffTruncated: true } : {}),
    };
    const failed = [headResult, branchResult, statusResult, diffResult].find((result) => result.exitCode !== 0);
    return {
      capturedAt,
      workspacePath,
      git,
      ...(failed === undefined ? {} : { error: "One or more Git snapshot commands failed" }),
    };
  } catch (error) {
    return { capturedAt, workspacePath, error: errorMessage(error),
      ...(error instanceof ProcessCleanupError ? { cleanupFailed: true } : {}) };
  }
}
