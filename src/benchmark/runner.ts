import { spawn } from "node:child_process";
import type {
  BenchmarkArtifactSink,
  BenchmarkHarnessAdapter,
  BenchmarkHarnessResult,
  BenchmarkProviderCapabilities,
  BenchmarkRunResult,
  BenchmarkSuiteSummary,
  BenchmarkTask,
  BenchmarkTaskPhase,
  BenchmarkVerification,
  BenchmarkVerificationResult,
} from "./types.js";
import { createBenchmarkMetricsCollector } from "./metrics.js";
import { retainOutput } from "../tools/command-record.js";
import { stopProcessTree } from "../tools/process-cancel.js";
import { captureWorkspaceSnapshot } from "./workspace.js";

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
  artifactSink?: BenchmarkArtifactSink;
  capabilities?: BenchmarkProviderCapabilities;
  onTaskPhase?(phase: BenchmarkTaskPhase, attempt: number): void;
  /** Required budget gate when a caller explicitly enables real provider requests. */
  liveApi?: boolean;
  totalTokenBudget?: number;
  tokenBudgetRemaining?: number;
}

function validTokenBudget(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

async function runAdapterAttempt(
  adapter: BenchmarkHarnessAdapter,
  task: BenchmarkTask,
  context: Parameters<BenchmarkHarnessAdapter["run"]>[1],
  signal: AbortSignal,
): Promise<BenchmarkHarnessResult | void> {
  if (signal.aborted) throw signal.reason ?? new Error("Benchmark task was cancelled");
  const runPromise = adapter.run(task, context);
  return await new Promise<BenchmarkHarnessResult | void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", rejectOnAbort);
      callback();
    };
    const rejectOnAbort = () => finish(() => reject(signal.reason ?? new Error("Benchmark task was cancelled")));
    signal.addEventListener("abort", rejectOnAbort, { once: true });
    if (signal.aborted) {
      rejectOnAbort();
      return;
    }
    runPromise.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export async function runBenchmarkTask(
  task: BenchmarkTask,
  adapter: BenchmarkHarnessAdapter,
  options: BenchmarkRunOptions = {},
): Promise<BenchmarkRunResult> {
  const tokenBudget = options.tokenBudgetRemaining ?? options.totalTokenBudget;
  if (options.liveApi === true && !validTokenBudget(tokenBudget)) {
    throw new Error("Live API benchmarks require a positive total token budget");
  }
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
  const verificationAttempts: BenchmarkVerificationResult[] = [];
  const artifactPaths: string[] = [];
  const workspaceBefore = await captureWorkspaceSnapshot(task.workspacePath, { now, signal: controller.signal });
  let workspaceAfter = workspaceBefore;
  let capabilities = options.capabilities;
  let attempts = 0;
  let status: BenchmarkRunResult["status"] = "passed";
  let failure: string | undefined;
  let usage: import("./types.js").BenchmarkTokenUsage | undefined;

  const writeArtifact = options.artifactSink === undefined
    ? undefined
    : async (name: string, content: string): Promise<string | undefined> => {
      try {
        const path = await options.artifactSink!.write(name, content);
        if (path !== undefined) artifactPaths.push(path);
        return path;
      } catch (error) {
        notes = [notes, `Could not write artifact ${name}: ${errorMessage(error)}`].filter(Boolean).join("\n");
        return undefined;
      }
    };

  try {
    const maxRepairAttempts = Math.min(10, Math.max(0, task.maxRepairAttempts ?? 3));
    while (true) {
      attempts += 1;
      const phase = attempts === 1 ? "implement" as const : "diagnose" as const;
      options.onTaskPhase?.(phase, attempts);
      const result = await runAdapterAttempt(adapter, task, {
        task,
        signal: controller.signal,
        attempt: attempts,
        phase,
        ...(verification === undefined ? {} : { previousVerification: verification }),
        workspaceBefore,
        onPhase: metrics.onPhase,
        onEvent: metrics.onEvent,
        ...(writeArtifact === undefined ? {} : { writeArtifact }),
        ...(tokenBudget === undefined ? {} : { tokenBudgetRemaining: tokenBudget }),
      }, controller.signal);
      manualInterventions += result?.manualInterventions ?? 0;
      unsafeActions += result?.unsafeActions ?? 0;
      if (result?.notes !== undefined) notes = [notes, result.notes].filter(Boolean).join("\n");
      if (result?.capabilities !== undefined) capabilities = result.capabilities;
      if (options.liveApi === true && (result?.usage === undefined || result.usage.complete !== true)) {
        status = "failed";
        failure = "Live API benchmark adapters must report complete token usage";
        break;
      }
      if (result?.usage !== undefined) {
        const previous = usage;
        usage = {
          inputTokens: (previous?.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens: (previous?.outputTokens ?? 0) + result.usage.outputTokens,
          reasoningTokens: (previous?.reasoningTokens ?? 0) + (result.usage.reasoningTokens ?? 0),
          cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (result.usage.cachedInputTokens ?? 0),
          cacheObservedInputTokens: (previous?.cacheObservedInputTokens ?? 0) + (result.usage.cacheObservedInputTokens ?? 0),
          complete: (previous?.complete ?? true) && result.usage.complete,
        };
        const consumed = usage.inputTokens + usage.outputTokens;
        if (tokenBudget !== undefined && consumed > tokenBudget) {
          status = "failed";
          failure = `Benchmark token budget exceeded (${consumed}/${tokenBudget})`;
          break;
        }
      }

      if (controller.signal.aborted) {
        status = timedOut ? "timed_out" : "error";
        failure = timedOut ? `Benchmark task exceeded ${task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS}ms` : "Benchmark task was cancelled";
        break;
      }
      if (unsafeActions > 0) {
        status = "failed";
        failure = `${unsafeActions} unsafe action(s) were reported by the harness`;
        break;
      }
      if (task.verification === undefined) break;

      options.onTaskPhase?.("verify", attempts);
      verification = await runVerification(task.verification, task.workspacePath, controller.signal);
      verificationAttempts.push(verification);
      if (verification.timedOut) {
        status = "timed_out";
        failure = verification.error ?? "Verification timed out";
        break;
      }
      if (verification.passed) {
        status = "passed";
        failure = undefined;
        break;
      }
      status = "failed";
      failure = verification.error ?? `Verification exited with code ${verification.exitCode ?? "unknown"}`;
      if (attempts > maxRepairAttempts) break;
    }
  } catch (error) {
    status = timedOut ? "timed_out" : "error";
    failure = errorMessage(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
    controller.abort();
    options.onTaskPhase?.("summarize", attempts);
    workspaceAfter = timedOut || options.signal?.aborted
      ? workspaceBefore
      : await captureWorkspaceSnapshot(task.workspacePath, { now });
  }

  if (writeArtifact !== undefined) {
    await writeArtifact("workspace-before.json", JSON.stringify(workspaceBefore, null, 2));
    await writeArtifact("workspace-after.json", JSON.stringify(workspaceAfter, null, 2));
    for (const [index, item] of verificationAttempts.entries()) {
      await writeArtifact(`verification-${index + 1}.json`, JSON.stringify(item, null, 2));
    }
  }

  const durationMs = Math.max(0, now() - startedAtMs);
  const runResult: BenchmarkRunResult = {
    taskId: task.id,
    adapter: adapter.name,
    status,
    startedAt,
    durationMs,
    attempts,
    metrics: metrics.snapshot(now()),
    manualInterventions,
    unsafeActions,
    ...(verification === undefined ? {} : { verification }),
    ...(verificationAttempts.length === 0 ? {} : { verificationAttempts }),
    workspaceBefore,
    workspaceAfter,
    ...(artifactPaths.length === 0 ? {} : { artifacts: artifactPaths }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(failure === undefined ? {} : { error: failure }),
    ...(notes === undefined ? {} : { notes }),
    ...(usage === undefined ? {} : { usage }),
  };
  if (writeArtifact !== undefined) {
    await writeArtifact("result.json", JSON.stringify(runResult, null, 2));
  }
  return runResult;
}

export async function runBenchmarkSuite(
  tasks: readonly BenchmarkTask[],
  adapter: BenchmarkHarnessAdapter,
  options: BenchmarkRunOptions & {
    onResult?(result: BenchmarkRunResult): void;
    repetitions?: number;
    prepareRun?(task: BenchmarkTask, repetition: number): Promise<void>;
  } = {},
): Promise<BenchmarkSuiteSummary> {
  const repetitions = options.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("Benchmark repetitions must be a positive integer");
  if (repetitions > 1 && !options.prepareRun) throw new Error("Repeated benchmarks require prepareRun to restore an isolated workspace");
  if (options.liveApi === true && !validTokenBudget(options.totalTokenBudget)) {
    throw new Error("Live API benchmarks require a positive total token budget");
  }
  const results: BenchmarkRunResult[] = [];
  let tokensConsumed = 0;
  for (const task of tasks) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      await options.prepareRun?.(task, repetition);
      const remaining = options.totalTokenBudget === undefined
        ? undefined
        : options.totalTokenBudget - tokensConsumed;
      if (options.liveApi === true && (remaining === undefined || remaining <= 0)) {
        throw new Error("Live API benchmark token budget was exhausted before the next run");
      }
      const result = await runBenchmarkTask(task, adapter, {
        ...options,
        ...(remaining === undefined ? {} : { tokenBudgetRemaining: remaining }),
      });
      const repeated = repetitions === 1 ? result : { ...result, repetition };
      results.push(repeated);
      tokensConsumed += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      options.onResult?.(repeated);
    }
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const verified = results.filter((result) => result.verification !== undefined).length;
  const verificationPassed = results.filter((result) => result.verification?.passed === true).length;
  const usageSamples = results.flatMap((result) => result.usage ? [result.usage] : []);
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
    totalAttempts: results.reduce((total, result) => total + result.attempts, 0),
    totalRepairAttempts: results.reduce((total, result) => total + Math.max(0, result.attempts - 1), 0),
    totalToolCalls: results.reduce((total, result) => total + result.metrics.toolCalls, 0),
    totalRetries: results.reduce((total, result) => total + result.metrics.retries, 0),
    totalManualInterventions: results.reduce((total, result) => total + result.manualInterventions, 0),
    unsafeActions: results.reduce((total, result) => total + result.unsafeActions, 0),
    results,
    ...(repetitions === 1 ? {} : { repetitions }),
    ...(usageSamples.length === 0 ? {} : {
      usage: {
        inputTokens: usageSamples.reduce((sum, usage) => sum + usage.inputTokens, 0),
        outputTokens: usageSamples.reduce((sum, usage) => sum + usage.outputTokens, 0),
        reasoningTokens: usageSamples.reduce((sum, usage) => sum + (usage.reasoningTokens ?? 0), 0),
        cachedInputTokens: usageSamples.reduce((sum, usage) => sum + (usage.cachedInputTokens ?? 0), 0),
        cacheObservedInputTokens: usageSamples.reduce((sum, usage) => sum + (usage.cacheObservedInputTokens ?? 0), 0),
        complete: usageSamples.length === results.length && usageSamples.every((usage) => usage.complete),
      },
    }),
  };
}
