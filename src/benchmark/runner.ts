import { spawn } from "node:child_process";
import type {
  BenchmarkHarnessAdapter,
  BenchmarkRunResult,
  BenchmarkSuiteSummary,
  BenchmarkTask,
  BenchmarkVerification,
  BenchmarkVerificationResult,
} from "./types.js";
import { createBenchmarkMetricsCollector } from "./metrics.js";
import { retainOutput } from "../tools/command-record.js";
import { stopProcessTree } from "../tools/process-cancel.js";

const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runVerification(spec: BenchmarkVerification, workspacePath: string, signal: AbortSignal): Promise<BenchmarkVerificationResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, spec.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      const expectedExitCode = spec.expectedExitCode ?? 0;
      resolve({
        attempted: true,
        passed: !timedOut && error === undefined && exitCode === expectedExitCode,
        exitCode,
        stdout,
        stderr,
        durationMs: Math.max(0, Date.now() - startedAt),
        timedOut,
        ...(error === undefined ? {} : { error }),
      });
    };

    const cancel = () => {
      timedOut = true;
      if (child.pid) stopProcessTree(child.pid);
      else child.kill();
      finish(null, "Verification was cancelled or timed out");
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, [...(spec.args ?? [])], {
        cwd: spec.cwd ?? workspacePath,
        env: { ...process.env, ...spec.env },
        detached: process.platform !== "win32",
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish(null, errorMessage(error));
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = retainOutput(stdout + chunk, MAX_OUTPUT_BYTES).text;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = retainOutput(stderr + chunk, MAX_OUTPUT_BYTES).text;
    });
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (exitCode) => finish(exitCode));
    timer = setTimeout(cancel, timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export interface BenchmarkRunOptions {
  signal?: AbortSignal;
  now?: () => number;
}

export async function runBenchmarkTask(
  task: BenchmarkTask,
  adapter: BenchmarkHarnessAdapter,
  options: BenchmarkRunOptions = {},
): Promise<BenchmarkRunResult> {
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const metrics = createBenchmarkMetricsCollector(now);
  const controller = new AbortController();
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;

  const abortFromParent = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Benchmark task exceeded ${task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS}ms`));
  }, Math.max(1, task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS));
  if (options.signal?.aborted) abortFromParent();

  let manualInterventions = 0;
  let unsafeActions = 0;
  let notes: string | undefined;
  let verification: BenchmarkVerificationResult | undefined;
  let status: BenchmarkRunResult["status"] = "passed";
  let failure: string | undefined;

  try {
    const runPromise = adapter.run(task, {
      task,
      signal: controller.signal,
      onPhase: metrics.onPhase,
      onEvent: metrics.onEvent,
    });
    const abortPromise = new Promise<never>((_, reject) => {
      const rejectOnAbort = () => reject(controller.signal.reason ?? new Error("Benchmark task was cancelled"));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      if (controller.signal.aborted) rejectOnAbort();
    });
    const result = await Promise.race([runPromise, abortPromise]);
    manualInterventions = result?.manualInterventions ?? 0;
    unsafeActions = result?.unsafeActions ?? 0;
    notes = result?.notes;
    if (controller.signal.aborted) {
      status = timedOut ? "timed_out" : "error";
      failure = timedOut ? `Benchmark task exceeded ${task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS}ms` : "Benchmark task was cancelled";
    } else if (task.verification) {
      verification = await runVerification(task.verification, task.workspacePath, controller.signal);
      if (verification.timedOut) {
        status = "timed_out";
        failure = verification.error ?? "Verification timed out";
      } else if (!verification.passed) {
        status = "failed";
        failure = verification.error ?? `Verification exited with code ${verification.exitCode ?? "unknown"}`;
      }
    }
    if (unsafeActions > 0) {
      status = "failed";
      failure = failure ?? `${unsafeActions} unsafe action(s) were reported by the harness`;
    }
  } catch (error) {
    status = timedOut ? "timed_out" : "error";
    failure = errorMessage(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
    controller.abort();
  }

  const durationMs = Math.max(0, now() - startedAtMs);
  return {
    taskId: task.id,
    adapter: adapter.name,
    status,
    startedAt,
    durationMs,
    metrics: metrics.snapshot(now()),
    manualInterventions,
    unsafeActions,
    ...(verification === undefined ? {} : { verification }),
    ...(failure === undefined ? {} : { error: failure }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export async function runBenchmarkSuite(
  tasks: readonly BenchmarkTask[],
  adapter: BenchmarkHarnessAdapter,
  options: BenchmarkRunOptions & { onResult?(result: BenchmarkRunResult): void } = {},
): Promise<BenchmarkSuiteSummary> {
  const results: BenchmarkRunResult[] = [];
  for (const task of tasks) {
    const result = await runBenchmarkTask(task, adapter, options);
    results.push(result);
    options.onResult?.(result);
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const verified = results.filter((result) => result.verification !== undefined).length;
  const verificationPassed = results.filter((result) => result.verification?.passed === true).length;
  return {
    adapter: adapter.name,
    total: results.length,
    passed,
    failed: results.filter((result) => result.status === "failed").length,
    timedOut: results.filter((result) => result.status === "timed_out").length,
    errored: results.filter((result) => result.status === "error").length,
    verified,
    verificationPassed,
    completionRate: results.length === 0 ? 0 : passed / results.length,
    verificationPassRate: verified === 0 ? null : verificationPassed / verified,
    totalDurationMs: results.reduce((total, result) => total + result.durationMs, 0),
    totalToolCalls: results.reduce((total, result) => total + result.metrics.toolCalls, 0),
    totalRetries: results.reduce((total, result) => total + result.metrics.retries, 0),
    totalManualInterventions: results.reduce((total, result) => total + result.manualInterventions, 0),
    unsafeActions: results.reduce((total, result) => total + result.unsafeActions, 0),
    results,
  };
}
