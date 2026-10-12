import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
  BenchmarkSkippedRun,
} from "./types.js";
import { createBenchmarkMetricsCollector } from "./metrics.js";
import { BoundedOutputBuffer } from "../tools/command-record.js";
import { observeProcessCompletion, ProcessCleanupError } from "../tools/process-completion.js";
import { captureWorkspaceSnapshot } from "./workspace.js";
import { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import { BenchmarkPreparationError } from "./preparation-failure.js";
import { classifyEditScope, type EditClassification } from './edit-classification.js';

const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
export interface BenchmarkProcessInvocation {
  command: string;
  args: string[];
}

/** Invoke npm through Node on Windows; npm.cmd is a batch shim and cannot use shell:false. */
export function resolveBenchmarkProcess(command: string, args: readonly string[] = []): BenchmarkProcessInvocation {
  if (process.platform !== "win32") return { command, args: [...args] };
  const normalized = command.replaceAll("\\", "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (basename === "npm" || basename === "npm.cmd") {
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (!existsSync(npmCli)) throw new Error(`Cannot locate the npm CLI beside Node: ${npmCli}`);
    return { command: process.execPath, args: [npmCli, ...args] };
  }
  return { command, args: [...args] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBenchmarkVerification(spec: BenchmarkVerification, workspacePath: string, signal: AbortSignal): Promise<BenchmarkVerificationResult> {
  const startedAt = Date.now();
  if (signal.aborted) return {
    attempted: false, passed: false, exitCode: null, stdout: "", stderr: "",
    durationMs: 0, timedOut: false, cancelled: true, error: "Verification was cancelled",
  };
  const stdout = new BoundedOutputBuffer(MAX_OUTPUT_BYTES);
  const stderr = new BoundedOutputBuffer(MAX_OUTPUT_BYTES);
  let child;
  try {
    const invocation = resolveBenchmarkProcess(spec.command, spec.args ?? []);
    child = spawn(invocation.command, invocation.args, {
      cwd: spec.cwd ?? workspacePath, env: { ...process.env, ...spec.env },
      detached: process.platform !== "win32", shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return { attempted: true, passed: false, exitCode: null, stdout: "", stderr: "",
      durationMs: Math.max(0, Date.now() - startedAt), timedOut: false, cancelled: false, error: errorMessage(error) };
  }
  const owned = observeProcessCompletion(child, { signal, timeoutMs: spec.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { if (!owned.closed) stdout.append(chunk); });
  child.stderr?.on("data", (chunk: string) => { if (!owned.closed) stderr.append(chunk); });
  const result = await owned.completion;
  const error = result.cleanupError?.message ?? result.error?.message
    ?? (result.timedOut ? "Verification timed out" : result.cancelled ? "Verification was cancelled" : undefined);
  return {
    attempted: true, passed: !error && result.exitCode === (spec.expectedExitCode ?? 0),
    exitCode: result.cancelled || result.timedOut ? null : result.exitCode,
    stdout: stdout.text, stderr: stderr.text, durationMs: Math.max(0, Date.now() - startedAt),
    timedOut: result.timedOut, cancelled: result.cancelled,
    ...(result.cleanupError ? { cleanupFailed: true } : {}),
    ...(error ? { error } : {}),
  };
}

export interface BenchmarkRunOptions {
  signal?: AbortSignal;
  now?: () => number;
  artifactSink?: BenchmarkArtifactSink;
  capabilities?: BenchmarkProviderCapabilities;
  onTaskPhase?(phase: BenchmarkTaskPhase, attempt: number): void;
  /** Required budget gate when a caller explicitly enables real provider requests. */
  liveApi?: boolean;
  totalTokenBudget?: number | null;
  /** Per-task admission budget. The campaign remainder may reduce this further. */
  taskTokenBudget?: number | null;
  tokenBudgetRemaining?: number;
  /** Internal artifact namespace used by isolated suite runs. */
  artifactPrefix?: string;
  campaignId?: string;
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
    const rejectOnAbort = () => {
      const error = signal.reason ?? new Error("Benchmark task was cancelled");
      if (adapter.settlesOnCancellation) {
        void runPromise.then(
          () => finish(() => reject(error)),
          (failure: unknown) => finish(() => reject(failure instanceof ProcessCleanupError ? failure : error)),
        );
      } else {
        finish(() => reject(error));
      }
    };
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
  const budgetSetting = options.tokenBudgetRemaining ?? options.totalTokenBudget;
  const tokenBudget = budgetSetting === null ? undefined : budgetSetting;
  if (options.liveApi === true && budgetSetting !== null && !validTokenBudget(tokenBudget)) {
    throw new Error("Live API benchmarks require a positive total token budget or explicit null for unlimited");
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
  let requestAttempts: number | undefined;
  let unsafeActions = 0;
  let notes: string | undefined;
  let verification: BenchmarkVerificationResult | undefined;
  const verificationAttempts: BenchmarkVerificationResult[] = [];
  const artifactPaths: string[] = [];
  const workspaceBeforeStarted = now();
  const workspaceBefore = await captureWorkspaceSnapshot(task.workspacePath, { now, signal: controller.signal });
  metrics.onEvent({ type: "timing_recorded", operation: "workspace_snapshot", durationMs: Math.max(0, now() - workspaceBeforeStarted) });
  let workspaceAfter = workspaceBefore;
  let capabilities = options.capabilities;
  let attempts = 0;
  let status: BenchmarkRunResult["status"] = "passed";
  let failure: string | undefined;
  let usage: import("./types.js").BenchmarkTokenUsage | undefined;
  let remainingBudget = tokenBudget;
  let terminalOutcome: BenchmarkHarnessResult["terminalOutcome"];
  let stopReason: string | undefined;
  let workflowOutcome: BenchmarkHarnessResult["workflowOutcome"];
  let diagnosticRounds: number | undefined;
  let teamMetrics: BenchmarkHarnessResult["teamMetrics"];
  let isolationFailed = false;
  let firstVerificationSuiteStatus: BenchmarkHarnessResult["firstVerificationSuiteStatus"];
  let harnessPermitsSuccess = true;
  let cleanupFailed = workspaceBefore.cleanupFailed === true;
  const requestAttemptLedger = options.liveApi === true
    ? new RequestAttemptLedger((tokenBudget === undefined ? {} : { tokenBudget }))
    : undefined;

  const writeArtifact = options.artifactSink === undefined
    ? undefined
    : async (name: string, content: string): Promise<string | undefined> => {
      try {
        const path = await options.artifactSink!.write(options.artifactPrefix ? `${options.artifactPrefix}-${name}` : name, content);
        if (path !== undefined) artifactPaths.push(path);
        return path;
      } catch (error) {
        notes = [notes, `Could not write artifact ${name}: ${errorMessage(error)}`].filter(Boolean).join("\n");
        return undefined;
      }
    };

  try {
    if (cleanupFailed) throw new ProcessCleanupError(workspaceBefore.error);
    const maxRepairAttempts = Math.min(10, Math.max(0, task.maxRepairAttempts ?? 3));
    while (true) {
      if (options.liveApi === true && remainingBudget !== undefined && remainingBudget <= 0) {
        status = "failed";
        failure = "Benchmark token budget was exhausted before the next model request";
        break;
      }
      attempts += 1;
      const phase = attempts === 1 ? "implement" as const : "diagnose" as const;
      options.onTaskPhase?.(phase, attempts);
      const ledgerBefore = requestAttemptLedger?.snapshot();
      let result: BenchmarkHarnessResult | void = undefined;
      let attemptError: unknown;
      try {
        result = await runAdapterAttempt(adapter, task, {
          task,
          signal: controller.signal,
          attempt: attempts,
          phase,
          ...(verification === undefined ? {} : { previousVerification: verification }),
          workspaceBefore,
          onPhase: metrics.onPhase,
          onEvent: metrics.onEvent,
          ...(writeArtifact === undefined ? {} : { writeArtifact: (name: string, content: string) => writeArtifact(`attempt-${attempts}-${name}`, content) }),
          ...(remainingBudget === undefined ? {} : { tokenBudgetRemaining: remainingBudget }),
          ...(requestAttemptLedger === undefined ? {} : { requestAttemptLedger }),
        }, controller.signal);
      } catch (error) {
        attemptError = error;
        if (error instanceof ProcessCleanupError) cleanupFailed = true;
      }
      manualInterventions += result?.manualInterventions ?? 0;
      if (result?.requestAttempts !== undefined) requestAttempts = (requestAttempts ?? 0) + result.requestAttempts;
      unsafeActions += result?.unsafeActions ?? 0;
      if (result?.notes !== undefined) notes = [notes, result.notes].filter(Boolean).join("\n");
      if (result?.capabilities !== undefined) capabilities = result.capabilities;
      terminalOutcome = result?.terminalOutcome ?? terminalOutcome;
      stopReason = result?.stopReason ?? stopReason;
      workflowOutcome = result?.workflowOutcome ?? workflowOutcome;
      diagnosticRounds = result?.diagnosticRounds ?? diagnosticRounds;
      teamMetrics = result?.teamMetrics ?? teamMetrics;
      isolationFailed ||= result?.isolationFailed === true;
      firstVerificationSuiteStatus = result?.firstVerificationSuiteStatus ?? firstVerificationSuiteStatus;
      const ledgerAfter = requestAttemptLedger?.snapshot();
      const ledgerRecordedAttempt = ledgerBefore !== undefined
        && ledgerAfter !== undefined
        && ledgerAfter.attempts.length > ledgerBefore.attempts.length;
      const ledgerBecameIncomplete = ledgerBefore?.complete === true && ledgerAfter?.complete === false;
      const attemptUsage = (ledgerRecordedAttempt || ledgerBecameIncomplete) && ledgerBefore !== undefined && ledgerAfter !== undefined
        ? {
            inputTokens: ledgerAfter.inputTokens - ledgerBefore.inputTokens,
            outputTokens: ledgerAfter.outputTokens - ledgerBefore.outputTokens,
            reasoningTokens: ledgerAfter.reasoningTokens - ledgerBefore.reasoningTokens,
            cachedInputTokens: result?.usage?.cachedInputTokens,
            cacheObservedInputTokens: result?.usage?.cacheObservedInputTokens,
            complete: ledgerAfter.complete,
          }
        : result?.usage;
      if (attemptUsage !== undefined) {
        const previous = usage;
        usage = {
          inputTokens: (previous?.inputTokens ?? 0) + attemptUsage.inputTokens,
          outputTokens: (previous?.outputTokens ?? 0) + attemptUsage.outputTokens,
          reasoningTokens: (previous?.reasoningTokens ?? 0) + (attemptUsage.reasoningTokens ?? 0),
          cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (attemptUsage.cachedInputTokens ?? 0),
          cacheObservedInputTokens: (previous?.cacheObservedInputTokens ?? 0) + (attemptUsage.cacheObservedInputTokens ?? 0),
          complete: (previous?.complete ?? true) && attemptUsage.complete,
        };
        const consumed = usage.inputTokens + usage.outputTokens;
        const attemptConsumed = attemptUsage.inputTokens + attemptUsage.outputTokens;
        if (remainingBudget !== undefined) remainingBudget -= attemptConsumed;
        if (tokenBudget !== undefined && consumed > tokenBudget) {
          status = "failed";
          failure = `Benchmark token budget exceeded (${consumed}/${tokenBudget})`;
          break;
        }
      }
      if (options.liveApi === true && (attemptUsage === undefined || attemptUsage.complete !== true)) {
        const previous = usage;
        usage = {
          inputTokens: previous?.inputTokens ?? 0,
          outputTokens: previous?.outputTokens ?? 0,
          reasoningTokens: previous?.reasoningTokens ?? 0,
          cachedInputTokens: previous?.cachedInputTokens ?? 0,
          cacheObservedInputTokens: previous?.cacheObservedInputTokens ?? 0,
          complete: false,
        };
        status = "failed";
        failure = "Live API benchmark adapters must report complete token usage";
        break;
      }

      if (attemptError !== undefined) throw attemptError;
      if (isolationFailed) { status = "failed"; failure = "Native isolation failed; the campaign must stop"; break; }

      const terminalStopped = terminalOutcome !== undefined && terminalOutcome !== "completed";
      const workflowFailed = workflowOutcome === "failed" || workflowOutcome === "unverified";
      if (terminalStopped || stopReason !== undefined || workflowFailed) {
        harnessPermitsSuccess = false;
        status = "failed";
        failure = stopReason
          ? `Production task stopped: ${stopReason}`
          : workflowFailed
            ? `Production workflow ended ${workflowOutcome}`
            : `Production task ended ${terminalOutcome}`;
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
      const verificationSpec = task.acceptance ?? task.verification;
      if (verificationSpec === undefined) break;

      options.onTaskPhase?.("verify", attempts);
      verification = await runBenchmarkVerification(verificationSpec, task.workspacePath, controller.signal);
      metrics.onEvent({ type: "timing_recorded", operation: "verification", durationMs: verification.durationMs });
      verificationAttempts.push(verification);
      if (verification.cleanupFailed) {
        cleanupFailed = true;
        throw new ProcessCleanupError(verification.error);
      }
      if (verification.cancelled) {
        status = timedOut ? "timed_out" : "error";
        failure = timedOut ? `Benchmark task exceeded ${task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS}ms` : "Benchmark task was cancelled";
        break;
      }
      if (verification.timedOut) {
        status = "timed_out";
        failure = verification.error ?? "Verification timed out";
        break;
      }
      if (verification.passed) {
        if (harnessPermitsSuccess) {
          status = "passed";
          failure = undefined;
        }
        break;
      }
      status = "failed";
      failure = verification.error ?? `Verification exited with code ${verification.exitCode ?? "unknown"}`;
      if (adapter.managesRepairs === true) break;
      if (attempts > maxRepairAttempts) break;
    }
  } catch (error) {
    cleanupFailed ||= error instanceof ProcessCleanupError;
    status = timedOut ? "timed_out" : "error";
    failure = errorMessage(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromParent);
    controller.abort();
    options.onTaskPhase?.("summarize", attempts);
    if (timedOut || options.signal?.aborted || cleanupFailed) {
      workspaceAfter = workspaceBefore;
    } else {
      const workspaceAfterStarted = now();
      workspaceAfter = await captureWorkspaceSnapshot(task.workspacePath, { now });
      if (workspaceAfter.cleanupFailed) {
        cleanupFailed = true;
        status = "error";
        failure = workspaceAfter.error;
      }
      metrics.onEvent({ type: "timing_recorded", operation: "workspace_snapshot", durationMs: Math.max(0, now() - workspaceAfterStarted) });
    }
  }

  if (writeArtifact !== undefined) {
    const artifactStarted = now();
    await writeArtifact("workspace-before.json", JSON.stringify(workspaceBefore, null, 2));
    await writeArtifact("workspace-after.json", JSON.stringify(workspaceAfter, null, 2));
    for (const [index, item] of verificationAttempts.entries()) {
      await writeArtifact(`verification-${index + 1}.json`, JSON.stringify(item, null, 2));
    }
    metrics.onEvent({ type: "timing_recorded", operation: "artifact_persistence", durationMs: Math.max(0, now() - artifactStarted) });
  }

  let editClassification: EditClassification | undefined;
  if (task.regression || task.allowedPaths) {
    if (cleanupFailed || timedOut || options.signal?.aborted) editClassification = {state:'unknown',outsideScope:0};
    else {
      const regression = task.regression ? await runBenchmarkVerification(task.regression, task.workspacePath, options.signal ?? new AbortController().signal) : undefined;
      editClassification = await classifyEditScope(task, regression);
      if (regression?.cleanupFailed) { cleanupFailed = true; status = 'error'; failure = regression.error; }
    }
  }
  const durationMs = Math.max(0, now() - startedAtMs);
  const runResult: BenchmarkRunResult = {
    taskId: task.id,
    ...(task.tags ? { tags: task.tags } : {}),
    ...(editClassification ? { editClassification } : {}),
    adapter: adapter.name,
    status,
    startedAt,
    durationMs,
    attempts,
    metrics: metrics.snapshot(now()),
    manualInterventions,
    ...(requestAttempts === undefined ? {} : { requestAttempts }),
    unsafeActions,
    ...(cleanupFailed ? { cleanupFailed: true, stopReason: "process_cleanup_failed" } : {}),
    ...(verification === undefined ? {} : { verification }),
    ...(verificationAttempts.length === 0 ? {} : { verificationAttempts }),
    workspaceBefore,
    workspaceAfter,
    ...(artifactPaths.length === 0 ? {} : { artifacts: artifactPaths }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(failure === undefined ? {} : { error: failure }),
    ...(notes === undefined ? {} : { notes }),
    ...(usage === undefined ? {} : { usage }),
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
    ...(stopReason === undefined || cleanupFailed ? {} : { stopReason }),
    ...(workflowOutcome === undefined ? {} : { workflowOutcome }),
    ...(diagnosticRounds === undefined ? {} : { diagnosticRounds }),
    ...(teamMetrics === undefined ? {} : { teamMetrics }),
    ...(isolationFailed ? { isolationFailed: true } : {}),
    ...(firstVerificationSuiteStatus === undefined ? {} : { firstVerificationSuiteStatus }),
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
    prepareRun?(task: BenchmarkTask, repetition: number): Promise<BenchmarkTask | void>;
  } = {},
): Promise<BenchmarkSuiteSummary> {
  const repetitions = options.repetitions ?? 1;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error("Benchmark repetitions must be a positive integer");
  if (repetitions > 1 && !options.prepareRun) throw new Error("Repeated benchmarks require prepareRun to restore an isolated workspace");
  if (options.liveApi === true && options.totalTokenBudget !== null && !validTokenBudget(options.totalTokenBudget)) {
    throw new Error("Live API benchmarks require a positive total token budget");
  }
  if (options.liveApi === true && options.taskTokenBudget !== null && !validTokenBudget(options.taskTokenBudget)) {
    throw new Error("Live API benchmark suites require a positive per-task token budget");
  }
  const results: BenchmarkRunResult[] = [];
  const skipped: BenchmarkSkippedRun[] = [];
  const planned = tasks.length * repetitions;
  let tokensConsumed = 0;
  let stopLiveSuite = false;
  let stopReason: string | undefined;
  for (const task of tasks) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      if (options.signal?.aborted) {
        stopLiveSuite = true;
        stopReason = "Campaign was cancelled";
        break;
      }
      const remaining = options.totalTokenBudget == null
        ? undefined
        : options.totalTokenBudget - tokensConsumed;
      if (options.liveApi === true && remaining !== undefined && remaining <= 0) {
        stopLiveSuite = true;
        stopReason = "Campaign token budget was exhausted";
        break;
      }
      let preparedTask: BenchmarkTask;
      try {
        preparedTask = await options.prepareRun?.(task, repetition) ?? task;
      } catch (error) {
        const message = errorMessage(error);
        const failedAt = options.now?.() ?? Date.now();
        const failed: BenchmarkRunResult = {
          taskId: task.id,
          adapter: adapter.name,
          status: "error",
          startedAt: new Date(failedAt).toISOString(),
          durationMs: 0,
          attempts: 0,
          metrics: createBenchmarkMetricsCollector(options.now).snapshot(failedAt),
          manualInterventions: 0,
          unsafeActions: 0,
          error: `Benchmark preparation failed: ${message}`,
          preparationError: message,
          preparationOutcome: error instanceof BenchmarkPreparationError ? error.outcome : "preparation_failed",
          ...(error instanceof ProcessCleanupError ? { cleanupFailed: true } : {}),
          ...(repetitions === 1 ? {} : { repetition }),
        };
        results.push(failed);
        options.onResult?.(failed);
        if (failed.cleanupFailed) {
          stopLiveSuite = true;
          stopReason = "Campaign stopped because process cleanup failed";
          break;
        }
        continue;
      }
      const runBudget = remaining === undefined
        ? options.taskTokenBudget
        : options.taskTokenBudget == null
          ? remaining
          : Math.min(remaining, options.taskTokenBudget);
      const result = await runBenchmarkTask(preparedTask, adapter, {
        ...options,
        artifactPrefix: `${(options.campaignId ?? "campaign").replace(/[^A-Za-z0-9._-]/gu, "-")}-${adapter.name.replace(/[^A-Za-z0-9._-]/gu, "-")}-${task.id.replace(/[^A-Za-z0-9._-]/gu, "-")}-${repetition}`,
        ...(runBudget == null ? {} : { tokenBudgetRemaining: runBudget }),
      });
      const repeated = repetitions === 1 ? result : { ...result, repetition };
      results.push(repeated);
      tokensConsumed += (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
      options.onResult?.(repeated);
      if (result.cleanupFailed) {
        stopLiveSuite = true;
        stopReason = "Campaign stopped because process cleanup failed";
        break;
      }
      if (options.signal?.aborted) {
        stopLiveSuite = true;
        stopReason = "Campaign was cancelled";
        break;
      }
      if (options.liveApi === true && (result.usage === undefined || result.usage.complete !== true)) {
        stopLiveSuite = true;
        stopReason = "Campaign stopped because a model request had unknown usage";
        break;
      }
    }
    if (stopLiveSuite) break;
  }

  if (results.length < planned) {
    const executed = new Set(results.map((result) => `${result.taskId}:${result.repetition ?? 1}`));
    const reason = stopReason?.includes("cleanup") ? "cleanup_failed" as const
      : stopReason?.includes("unknown") ? "usage_unknown" as const
      : options.signal?.aborted ? "cancelled" as const
        : "budget_exhausted" as const;
    for (const task of tasks) for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      if (!executed.has(`${task.id}:${repetition}`)) skipped.push({ taskId: task.id, repetition, reason });
    }
  }

  const passed = results.filter((result) => result.status === "passed").length;
  const verified = results.filter((result) => result.verification?.attempted === true).length;
  const verificationPassed = results.filter((result) => result.verification?.passed === true).length;
  const usageSamples = results.flatMap((result) => result.usage ? [result.usage] : []);
  return {
    adapter: adapter.name,
    planned,
    executed: results.length,
    skipped,
    statisticsComplete: results.length === planned && results.every((result) => result.usage?.complete !== false && !result.cleanupFailed),
    ...(stopReason === undefined ? {} : { stopReason }),
    total: planned,
    passed,
    failed: results.filter((result) => result.status === "failed").length,
    timedOut: results.filter((result) => result.status === "timed_out").length,
    errored: results.filter((result) => result.status === "error").length,
    verified,
    verificationPassed,
    completionRate: planned === 0 ? 0 : passed / planned,
    verificationPassRate: verified === 0 ? null : verificationPassed / verified,
    totalDurationMs: results.reduce((total, result) => total + result.durationMs, 0),
    totalAttempts: results.reduce((total, result) => total + result.attempts, 0),
    totalRepairAttempts: results.reduce((total, result) => total + (result.diagnosticRounds ?? Math.max(0, result.attempts - 1)), 0),
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
