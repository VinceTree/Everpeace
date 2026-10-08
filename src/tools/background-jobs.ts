import { randomUUID } from "node:crypto";
import type { BashOutputPreview, BashResult } from "./bash.js";
import { commandFailureFeedback, ToolFeedbackError } from "./tool-feedback.js";

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

  constructor(run: (command: string, signal: AbortSignal, timeoutMs: number, onOutput: (output: BashOutputPreview) => void) => Promise<BashResult>) {
    this.#run = run;
  }

  start(
    command: string,
    parentSignal?: AbortSignal,
    onSettled?: (completion: BackgroundJobCompletion) => void,
  ): BackgroundJobSnapshot {
    if ([...this.#jobs.values()].filter((job) => job.status === "running").length >= MAX_RUNNING_JOBS) {
      throw new ToolFeedbackError("BACKGROUND_LIMIT", `At most ${MAX_RUNNING_JOBS} background jobs may run at once`, "Poll or wait for the running jobs to finish before starting another command.");
    }
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(parentSignal?.reason ?? new Error("Task cancelled"));
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    const job: BackgroundJob = {
      job_id: randomUUID(),
      command,
      status: "running",
      started_at: new Date().toISOString(),
      controller,
      promise: Promise.resolve(),
      ...(parentSignal ? { detachParent: () => parentSignal.removeEventListener("abort", abortFromParent) } : {}),
    };
    job.promise = this.#run(command, controller.signal, DEFAULT_JOB_TIMEOUT_MS, (output) => {
      job.preview = { ...output, headLines: [...output.headLines], tailLines: [...output.tailLines] };
    })
      .then((result) => {
        job.result = { ...result, ...commandFailureFeedback(result) };
        job.status = result.timedOut ? "timed_out" : result.cancelled ? "cancelled" : result.error || result.exitCode !== 0 ? "failed" : "completed";
      })
      .catch((error: unknown) => {
        job.result = { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
        job.status = controller.signal.aborted ? "cancelled" : "failed";
      })
      .finally(() => {
        job.finished_at = new Date().toISOString();
        job.detachParent?.();
        delete job.detachParent;
        try {
          onSettled?.({
            job_id: job.job_id,
            status: job.status as Exclude<BackgroundJobStatus, "running">,
            exit_code: job.result?.exitCode ?? null,
            finished_at: job.finished_at,
          });
        } catch {
          // Settlement observers cannot change command completion or cleanup.
        } finally {
          this.#prune();
        }
      });
    this.#jobs.set(job.job_id, job);
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
      await job.promise;
    }
    return this.#snapshot(job);
  }

  async waitAll(signal?: AbortSignal): Promise<BackgroundJobSnapshot[]> {
    const running = [...this.#jobs.values()].filter((job) => job.status === "running");
    if (running.length === 0) return [...this.#jobs.values()].map((job) => this.#snapshot(job));
    const abort = () => running.forEach((job) => job.controller.abort(signal?.reason ?? new Error("Cancelled")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { await Promise.all(running.map((job) => job.promise)); }
    finally { signal?.removeEventListener("abort", abort); }
    signal?.throwIfAborted();
    return [...this.#jobs.values()].map((job) => this.#snapshot(job));
  }

  async stopAll(reason: unknown = new Error("Background jobs stopped")): Promise<BackgroundJobSnapshot[]> {
    const running = [...this.#jobs.values()].filter((job) => job.status === "running");
    for (const job of running) job.controller.abort(reason);
    await Promise.allSettled(running.map((job) => job.promise));
    return [...this.#jobs.values()].map((job) => this.#snapshot(job));
  }

  dispose(): Promise<BackgroundJobSnapshot[]> {
    return this.stopAll(new Error("Agent disposed"));
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
