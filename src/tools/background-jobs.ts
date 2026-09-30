import { randomUUID } from "node:crypto";
import type { BashResult } from "./bash.js";

const MAX_RUNNING_JOBS = 2;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;

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
  result?: BashResult;
}

interface BackgroundJob extends BackgroundJobSnapshot {
  controller: AbortController;
  promise: Promise<void>;
}

function stringArgument(argumentsJson: string, key: "command" | "job_id"): string | undefined {
  try {
    const value = JSON.parse(argumentsJson) as Record<string, unknown>;
    const result = value && typeof value === "object" ? value[key] : undefined;
    return typeof result === "string" && result.trim() ? result : undefined;
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
  readonly #run: (command: string, signal: AbortSignal, timeoutMs: number) => Promise<BashResult>;

  constructor(run: (command: string, signal: AbortSignal, timeoutMs: number) => Promise<BashResult>) {
    this.#run = run;
  }

  start(command: string): BackgroundJobSnapshot {
    if ([...this.#jobs.values()].filter((job) => job.status === "running").length >= MAX_RUNNING_JOBS) {
      throw new Error(`At most ${MAX_RUNNING_JOBS} background jobs may run at once`);
    }
    const controller = new AbortController();
    const job: BackgroundJob = {
      job_id: randomUUID(),
      command,
      status: "running",
      started_at: new Date().toISOString(),
      controller,
      promise: Promise.resolve(),
    };
    job.promise = this.#run(command, controller.signal, DEFAULT_JOB_TIMEOUT_MS)
      .then((result) => {
        job.result = result;
        job.status = result.timedOut ? "timed_out" : result.cancelled ? "cancelled" : result.error || result.exitCode !== 0 ? "failed" : "completed";
      })
      .catch((error: unknown) => {
        job.result = { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: controller.signal.aborted, error: error instanceof Error ? error.message : String(error) };
        job.status = controller.signal.aborted ? "cancelled" : "failed";
      })
      .finally(() => { job.finished_at = new Date().toISOString(); });
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

  dispose(): void {
    for (const job of this.#jobs.values()) if (job.status === "running") job.controller.abort(new Error("Agent disposed"));
  }

  #snapshot(job: BackgroundJob): BackgroundJobSnapshot {
    return {
      job_id: job.job_id,
      command: job.command,
      status: job.status,
      started_at: job.started_at,
      ...(job.finished_at ? { finished_at: job.finished_at } : {}),
      ...(job.result ? { result: { ...job.result } } : {}),
    };
  }
}

export const backgroundJobLimits = { maxRunningJobs: MAX_RUNNING_JOBS, defaultTimeoutMs: DEFAULT_JOB_TIMEOUT_MS } as const;
