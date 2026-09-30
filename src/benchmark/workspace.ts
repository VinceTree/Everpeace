import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { BenchmarkWorkspaceGitSnapshot, BenchmarkWorkspaceSnapshot } from "./types.js";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { stopProcessTree } from "../tools/process-cancel.js";

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", [...args], {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout = new BoundedOutputBuffer(MAX_GIT_OUTPUT_BYTES);
    const stderr = new BoundedOutputBuffer(MAX_GIT_OUTPUT_BYTES);
    let settled = false;
    const finish = (result: GitCommandResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      resolve(result);
    };
    const cancel = () => {
      if (child.pid) stopProcessTree(child.pid);
      else child.kill();
      finish({ exitCode: null, stdout: stdout.text, stderr: `${stderr.text}\nGit command was cancelled` });
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout.append(chunk);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr.append(chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => finish({ exitCode, stdout: stdout.text, stderr: stderr.text }));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function commandText(result: GitCommandResult, args: readonly string[]): string {
  const detail = result.stderr.trim() || `exit code ${result.exitCode ?? "unknown"}`;
  return `git ${args.join(" ")} failed: ${detail}`;
}

export interface CaptureWorkspaceSnapshotOptions {
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
    const [headResult, branchResult, statusResult, diffResult] = await Promise.all([
      runGit(["rev-parse", "HEAD"], workspacePath, options.signal),
      runGit(["branch", "--show-current"], workspacePath, options.signal),
      runGit(["status", "--porcelain=v1"], workspacePath, options.signal),
      runGit(["diff", "--binary", "--no-ext-diff"], workspacePath, options.signal),
    ]);
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
    return { capturedAt, workspacePath, error: errorMessage(error) };
  }
}
