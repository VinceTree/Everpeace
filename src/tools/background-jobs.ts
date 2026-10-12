import { randomUUID } from "node:crypto";
import type { BashOutputPreview, BashResult } from "./bash.js";
import { commandFailureFeedback, ToolFeedbackError } from "./tool-feedback.js";
import { ProcessCleanupError } from "./process-completion.js";

const MAX_RUNNING_JOBS = 2;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
const MAX_RETAINED_JOBS = 20;
const MAX_RETAINED_RESULT_BYTES = 4 * 1024 * 1024;

export const BACKGROUND_JOB_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    name: "start_background",
    description: "Start a bounded non-interactive shell command in the existing model sandbox. At most two jobs may run at once.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    strict: true,
  },
  {
    type: "function" as const,
    name: "poll_background",
    description: "Read the current state and retained output of a background job.",
    parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
    strict: true,
  },
  {
    type: "function" as const,
    name: "stop_background",
    description: "Stop a running background job and its process tree.",
    parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], additionalProperties: false },
    strict: true,
  },
] as const;

export type BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";

export interface BackgroundJobSnapshot {
  job_id: string;
  command: string;
  status: BackgroundJobStatus;
  started_at: string;
  finished_at?: string;
  preview?: BashOutputPreview;
  result?: BashResult;
}

export interface BackgroundJobCompletion {
  job_id: string;
  status: Exclude<BackgroundJobStatus, "running">;
  exit_code: number | null;
  finished_at: string;
}

interface BackgroundJob extends BackgroundJobSnapshot {
  controller: AbortController;
  promise: Promise<void>;
  detachParent?: () => void;
}

function stringArgument(argumentsJson: string, key: "command" | "job_id"): string | undefined {
  try {
    const value = JSON.parse(argumentsJson) as Record<string, unknown>;
    const result = value && typeof value === "object" ? value[key] : undefined;
    return typeof result === "string" && result.trim() && !result.includes("\0") && Object.keys(value).every((field) => field === key) ? result : undefined;
  } catch { return undefined; }
}

export function parseBackgroundCommand(argumentsJson: string): string | undefined {
  return stringArgument(argumentsJson, "command");
}

export function parseBackgroundJobId(argumentsJson: string): string | undefined {
  return stringArgument(argumentsJson, "job_id");
}

export class BackgroundJobManager {
  readonly #jobs = new Map<string, BackgroundJob>();
  readonly #run: (command: string, signal: AbortSignal, timeoutMs: number, onOutput: (output: BashOutputPreview) => void) => Promise<BashResult>;
  #cleanupDepth = 0;
  #disposed = false;
  #disposal: Promise<BackgroundJobSnapshot[]> | undefined;
  #cleanupFailure: ProcessCleanupError | undefined;

  constructor(run: (command: string, signal: AbortSignal, timeoutMs: number, onOutput: (output: BashOutputPreview) => void) => Promise<BashResult>) {
    this.#run = run;
  }

  assertCleanupComplete(): void {
    if (this.#cleanupFailure) throw this.#cleanupFailure;
  }

  start(
    command: string,
    parentSignal?: AbortSignal,
    onSettled?: (completion: BackgroundJobCompletion) => void,
  ): BackgroundJobSnapshot {
    parentSignal?.throwIfAborted();
    if (this.#disposed) {
      throw new ToolFeedbackError("BACKGROUND_DISPOSED", "The background job manager has been disposed", "Start work only through the current active Agent. Disposed jobs cannot be restarted.");
    }
    if (this.#cleanupDepth > 0) {
      throw new ToolFeedbackError("BACKGROUND_CLEANUP", "Background jobs are still cleaning up", "Wait for cleanup to finish before explicitly starting new work. Do not retry the interrupted command automatically.");
    }
    this.assertCleanupComplete();
    if ([...this.#jobs.values()].filter((job) => job.status === "running").length >= MAX_RUNNING_JOBS) {
      throw new ToolFeedbackError("BACKGROUND_LIMIT", `At most ${MAX_RUNNING_JOBS} background jobs may run at once`, "Poll or wait for the running jobs to finish before starting another command.");
    }
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error("Task cancelled"));
    let accept!: (result: BashResult | PromiseLike<BashResult>) => void;
    let reject!: (error: unknown) => void;
    const execution = new Promise<BashResult>((resolve, fail) => { accept = resolve; reject = fail; });
    const job: BackgroundJob = {
      job_id: randomUUID(),
      command,
      status: "running",
      started_at: new Date().toISOString(),
      controller,
      promise: Promise.resolve(),
      ...(parentSignal ? { detachParent: () => parentSignal.removeEventListener("abort", abortFromParent) } : {}),
    };
    job.promise = execution.then(
      (result) => this.#settle(job, result, onSettled),
      (error: unknown) => this.#settle(job, {
        stdout: "", stderr: "", exitCode: null, signal: null,
        cancelled: controller.signal.aborted,
        ...(error instanceof ProcessCleanupError ? { cleanupFailed: true } : {}),
        error: error instanceof Error ? error.message : String(error),
      }, onSettled),
    );
    // Reserve both admission and the cleanup promise before invoking host code.
    this.#jobs.set(job.job_id, job);
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    try {
      controller.signal.throwIfAborted();
      accept(this.#run(command, controller.signal, DEFAULT_JOB_TIMEOUT_MS, (output) => {
        if (job.status !== "running") return;
        job.preview = { ...output, headLines: [...output.headLines], tailLines: [...output.tailLines] };
      }));
    } catch (error) { reject(error); }
    return this.#snapshot(job);
  }

  poll(jobId: string): BackgroundJobSnapshot | undefined {
    const job = this.#jobs.get(jobId);
    return job ? this.#snapshot(job) : undefined;
  }

  async stop(jobId: string): Promise<BackgroundJobSnapshot | undefined> {
    const job = this.#jobs.get(jobId);
    if (!job) return undefined;
    if (job.status === "running") {
      job.controller.abort(new Error("Background job stopped"));
    }
    await job.promise;
    this.assertCleanupComplete();
    return this.#snapshot(job);
  }

  async waitAll(signal?: AbortSignal): Promise<BackgroundJobSnapshot[]> {
    const jobs = [...this.#jobs.values()];
    const abort = () => jobs.filter((job) => job.status === "running").forEach((job) => job.controller.abort(signal?.reason ?? new Error("Cancelled")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { await Promise.all(jobs.map((job) => job.promise)); }
    finally { signal?.removeEventListener("abort", abort); }
    this.assertCleanupComplete();
    signal?.throwIfAborted();
    return [...this.#jobs.values()].map((job) => this.#snapshot(job));
  }

  async stopAll(reason: unknown = new Error("Background jobs stopped")): Promise<BackgroundJobSnapshot[]> {
    this.#cleanupDepth++;
    try {
      const jobs = [...this.#jobs.values()];
      for (const job of jobs) if (job.status === "running") job.controller.abort(reason);
      await Promise.allSettled(jobs.map((job) => job.promise));
      this.assertCleanupComplete();
      return [...this.#jobs.values()].map((job) => this.#snapshot(job));
    } finally { this.#cleanupDepth--; }
  }

  dispose(): Promise<BackgroundJobSnapshot[]> {
    this.#disposed = true;
    return this.#disposal ??= this.stopAll(new Error("Agent disposed"));
  }

  #settle(job: BackgroundJob, result: BashResult, onSettled?: (completion: BackgroundJobCompletion) => void): void {
    job.result = { ...result, ...commandFailureFeedback(result) };
    if (result.cleanupFailed) this.#cleanupFailure ??= new ProcessCleanupError(result.error ?? "Background process ownership is unresolved");
    const status = result.cleanupFailed ? "failed" : result.timedOut ? "timed_out" : result.cancelled ? "cancelled" : result.error || result.exitCode !== 0 ? "failed" : "completed";
    job.finished_at = new Date().toISOString();
    job.status = status;
    job.detachParent?.();
    delete job.detachParent;
    try {
      onSettled?.({ job_id: job.job_id, status, exit_code: result.exitCode, finished_at: job.finished_at });
    } catch {
      // Settlement observers cannot change command completion or cleanup.
    } finally { this.#prune(); }
  }

  #prune(): void {
    const terminal = [...this.#jobs.values()].filter((job) => job.status !== "running");
    const bytes = (job: BackgroundJob) => Buffer.byteLength(job.result?.stdout ?? "") + Buffer.byteLength(job.result?.stderr ?? "");
    let retainedBytes = terminal.reduce((sum, job) => sum + bytes(job), 0);
    while (terminal.length > MAX_RETAINED_JOBS || retainedBytes > MAX_RETAINED_RESULT_BYTES) {
      const job = terminal.shift();
      if (!job) break;
      this.#jobs.delete(job.job_id);
      retainedBytes -= bytes(job);
    }
  }

  #snapshot(job: BackgroundJob): BackgroundJobSnapshot {
    return {
      job_id: job.job_id,
      command: job.command,
      status: job.status,
      started_at: job.started_at,
      ...(job.finished_at ? { finished_at: job.finished_at } : {}),
      ...(job.preview ? { preview: { ...job.preview, headLines: [...job.preview.headLines], tailLines: [...job.preview.tailLines] } } : {}),
      ...(job.result ? { result: { ...job.result } } : {}),
    };
  }
}

export const backgroundJobLimits = {
  maxRunningJobs: MAX_RUNNING_JOBS,
  defaultTimeoutMs: DEFAULT_JOB_TIMEOUT_MS,
  maxRetainedJobs: MAX_RETAINED_JOBS,
  maxRetainedResultBytes: MAX_RETAINED_RESULT_BYTES,
} as const;
