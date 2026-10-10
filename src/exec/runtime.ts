import { TeamLimitError } from "../team/ledger.js";
import { RequestUsageIncompleteError } from "../agent/request-attempt-ledger.js";
import { normalizeTeamOptions } from "../team/types.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LoopEvent } from "../agent/agent-loop.js";
import { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import type { AgentIO, AgentInteractionRequired } from "../agent/react-agent.js";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";
import { loadPermissionPolicy, type PermissionPolicy } from "../permissions/policy.js";
import {
  createProductionAgent,
  createProductionCommandExecutor,
  createProductionWorkflowAgentIO,
  type ProductionAgentHandle,
  type ProductionCommandExecutor,
} from "../runtime/production.js";
import type { ResolvedModels } from "../storage/model-registry.js";
import { SessionStore, type LoadedSession } from "../storage/session-store.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";
import { ResourceCleanupError } from "../util/resource-cleanup-error.js";
import { CodingWorkflowRuntime } from "../workflow/runtime.js";
import { CodingTaskRunner, type CodingTaskRunnerResult } from "../workflow/task-runner.js";
import { cloneTaskProgress, type TaskProgress } from "../workflow/task-progress.js";
import type {
  ExecDependencies,
  ExecEvent,
  ExecOptions,
  ExecResult,
  ExecSelectedModel,
} from "./types.js";

const EXEC_MEMORY_POLICY = { readExisting: true, captureFuture: false } as const;
const MAX_EVENT_TEXT_CHARS = 4_096;

class ExecConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExecConfigurationError";
  }
}

function safeText(value: string, maximum = MAX_EVENT_TEXT_CHARS): string {
  const redacted = redactSecretsPreservingLayout(value);
  if (redacted.length <= maximum) return redacted;
  let result = "";
  let count = 0;
  for (const point of redacted) {
    if (count === maximum) return `${result}…`;
    result += point;
    count += 1;
  }
  return redacted;
}

function errorText(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error));
}

function isOutputError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && ((error as NodeJS.ErrnoException).code === "EPIPE"
    || (error as Error).name === "ExecOutputError"));
}

function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

function requirePositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new ExecConfigurationError(`${name} must be a positive integer`);
  }
}

export function deterministicExecTitle(prompt: string): string {
  const first = safeText(prompt)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/gu, " ") ?? "task";
  const value = `Exec: ${first}`;
  const points = [...value];
  return points.length <= 60 ? value : `${points.slice(0, 59).join("")}…`;
}

export function selectExecModel(resolved: ResolvedModels, selector?: string): ExecSelectedModel {
  const models = resolved.available;
  if (selector !== undefined) {
    const selected = selector.trim();
    if (!selected) throw new ExecConfigurationError("--model requires a non-empty registered model ID or model name");
    // Registration IDs have precedence across both credential states. Without
    // this check, a missing registration whose ID equals another model's name
    // could silently select the wrong model through the name fallback.
    const availableById = models.filter((model) => model.id === selected);
    const missingById = resolved.missing.filter((model) => model.id === selected);
    if (availableById.length + missingById.length > 1) {
      throw new ExecConfigurationError(`Registered model ID is duplicated: ${selected}`);
    }
    if (availableById.length === 1) return { model: availableById[0]!, selector: "id" };
    if (missingById.length === 1) {
      throw new ExecConfigurationError(`The selected model has no available credential: ${selected}`);
    }

    // A name is selectable only when it identifies one registration, including
    // registrations whose credential is currently unavailable.
    const availableByName = models.filter((model) => model.model_name === selected);
    const missingByName = resolved.missing.filter((model) => model.model_name === selected);
    if (availableByName.length + missingByName.length > 1) {
      throw new ExecConfigurationError(`Model name is ambiguous; use a registration ID: ${selected}`);
    }
    if (availableByName.length === 1) return { model: availableByName[0]!, selector: "name" };
    if (missingByName.length === 1) {
      throw new ExecConfigurationError(`The selected model has no available credential: ${selected}`);
    }
    throw new ExecConfigurationError(`No registered model matches: ${selected}`);
  }
  if (models.length === 1) return { model: models[0]!, selector: "only" };
  if (models.length === 0) {
    throw new ExecConfigurationError(resolved.missing.length > 0
      ? "No registered model has an available credential"
      : "No models are registered; run everpeace login first");
  }
  throw new ExecConfigurationError("Multiple models are available; select one with --model");
}

function selectResumeModel(session: LoadedSession, resolved: ResolvedModels, workspacePath: string): ExecSelectedModel {
  if (normalizeWorkspacePath(session.summary.workspace_path) !== normalizeWorkspacePath(workspacePath)) {
    throw new ExecConfigurationError("The saved Session belongs to a different workspace; use -C with its original directory");
  }
  const saved = session.summary.model;
  // Resume never falls back from a missing registration ID to another model's name.
  if (!resolved.available.some((model) => model.id === saved.id)) {
    throw new ExecConfigurationError("The saved Session model is unavailable; restore its registered model and credential first");
  }
  const selected = selectExecModel(resolved, saved.id);
  if (selected.model.model_name !== saved.model_name || selected.model.base_url !== saved.base_url) {
    throw new ExecConfigurationError("The saved Session model registration has changed; use the TUI to review a replacement model");
  }
  return {
    ...selected,
    model: {
      ...selected.model,
      ...(saved.request_settings && saved.responses_profile === selected.model.responses_profile ? { request_settings: { ...saved.request_settings } } : {}),
    },
  };
}

function toolStatus(output: string): string | undefined {
  try {
    const value = JSON.parse(output) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const status = (value as Record<string, unknown>).status;
    return typeof status === "string" && /^[a-z_]{1,40}$/u.test(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

function questionPrompt(request: unknown): string {
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const questions = (request as { questions?: unknown }).questions;
    if (Array.isArray(questions)) {
      const first = questions.find((value) => value && typeof value === "object" && !Array.isArray(value)) as { question?: unknown } | undefined;
      if (typeof first?.question === "string" && first.question.trim()) return safeText(first.question);
    }
  }
  return "The model requested structured user input.";
}

function configurationResult(error: unknown): ExecResult {
  return {
    exitCode: 2,
    classification: "configuration_error",
    status: "configuration_error",
    usageComplete: true,
    error: errorText(error),
  };
}

function runtimeResult(
  classification: ExecResult["classification"],
  exitCode: number,
  status: string,
  ledger: RequestAttemptLedger | undefined,
  details: Partial<ExecResult> = {},
): ExecResult {
  const usage = ledger?.snapshot();
  return {
    exitCode,
    classification,
    status,
    usageComplete: usage?.complete ?? true,
    ...(usage ? { usage } : {}),
    ...details,
  };
}

function successfulResult(
  result: CodingTaskRunnerResult,
  sessionId: string,
  assistantText: string | undefined,
  ledger: RequestAttemptLedger,
): ExecResult {
  const common = {
    sessionId,
    ...(assistantText ? { assistantText } : {}),
  };
  if (result.agentResult.interactionRequired) {
    return runtimeResult("interaction_required", 5, "interaction_required", ledger, {
      ...common,
      interaction: result.agentResult.interactionRequired,
    });
  }
  if (result.disposition === "stopped" && result.agentResult.stopReason) {
    return runtimeResult("limit_reached", 4, result.agentResult.stopReason, ledger, {
      ...common,
      stopReason: result.agentResult.stopReason,
      ...(result.agentResult.requestFailure ? { error: result.agentResult.requestFailure } : {}),
      ...(result.workflowResult?.state.result ? { workflowResult: result.workflowResult.state.result } : {}),
    });
  }
  // A non-interactive plan run never approves; the submitted plan is the product.
  if (result.disposition === "plan_cancelled" || result.disposition === "plan_approved") {
    return runtimeResult("success", 0, "plan", ledger, common);
  }
  const workflowResult = result.workflowResult?.state.result;
  if (workflowResult === "verified" || workflowResult === "no_changes") {
    return runtimeResult("success", 0, workflowResult, ledger, { ...common, workflowResult });
  }
  const settled = workflowResult ?? "unverified";
  return runtimeResult("verification_failed", 3, settled, ledger, {
    ...common,
    workflowResult: settled,
  });
}

/** Run one normal, recoverable coding Session without mounting Ink. */
export async function runExec(options: ExecOptions, dependencies: ExecDependencies): Promise<ExecResult> {
  try {
    if (!options.prompt.trim()) throw new ExecConfigurationError("Exec prompt must not be empty");
    if (options.resume !== undefined && !/^[A-Za-z0-9_-]+$/u.test(options.resume)) {
      throw new ExecConfigurationError("--resume requires a local Session ID");
    }
    if (options.resume !== undefined && options.model !== undefined) {
      throw new ExecConfigurationError("--resume uses the saved model; --model cannot be combined with it");
    }
    if (options.permissionMode !== undefined
      && options.permissionMode !== "read-only"
      && options.permissionMode !== "ask"
      && options.permissionMode !== "workspace-write") {
      throw new ExecConfigurationError("--permission-mode must be read-only, ask, or workspace-write; exec cannot request full-access");
    }
    if (options.team) normalizeTeamOptions(options.team);
    requirePositiveInteger("tokenBudget", options.tokenBudget);
    requirePositiveInteger("timeoutMs", options.timeoutMs);
    requirePositiveInteger("maxSteps", options.maxSteps);
  } catch (error) {
    return configurationResult(error);
  }

  const workspacePath = path.resolve(options.workspacePath);
  const sessionStore = dependencies.sessionStore ?? new SessionStore();
  const createAgent = dependencies.createAgent ?? createProductionAgent;
  const createCommandExecutor = dependencies.createCommandExecutor ?? createProductionCommandExecutor;
  const readPolicy = dependencies.loadPermissionPolicy ?? loadPermissionPolicy;
  const controller = new AbortController();
  let deadlineExceeded = false;
  let outputClosed = false;
  const effectiveTimeout = options.team?.enabled !== false && options.team ? Math.min(options.timeoutMs ?? Infinity, options.team.timeoutMs ?? 1_800_000) : options.timeoutMs;
  const timeout = effectiveTimeout === undefined ? undefined : setTimeout(() => {
    deadlineExceeded = true;
    const error = new Error("Exec task deadline exceeded");
    error.name = "ExecTaskDeadlineError";
    controller.abort(error);
  }, effectiveTimeout);
  const taskSignal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const emit = async (event: ExecEvent): Promise<void> => {
    if (outputClosed) return;
    try {
      await options.onEvent?.(event);
    } catch (error) {
      if (isOutputError(error)) {
        outputClosed = true;
        controller.abort(error);
      }
      throw error;
    }
  };

  let ledger: RequestAttemptLedger | undefined;
  let handle: ProductionAgentHandle | undefined;
  let sessionId: string | undefined;
  let result: ExecResult | undefined;
  let startupConfigured = false;
  let timeline = Promise.resolve();
  const queueTimeline = (kind: "user" | "assistant" | "system", text: string): void => {
    if (!sessionId) return;
    timeline = timeline.then(() => sessionStore.appendTimeline(sessionId!, { kind, text }));
  };

  try {
    taskSignal.throwIfAborted();
    const workspace = await waitWithSignal(fs.stat(workspacePath), taskSignal).catch((error) => {
      throw new ExecConfigurationError(`Workspace is unavailable: ${workspacePath}`, { cause: error });
    });
    if (!workspace.isDirectory()) throw new ExecConfigurationError(`Workspace is not a directory: ${workspacePath}`);
    let restored: LoadedSession | undefined;
    if (options.resume !== undefined) {
      try { restored = await waitWithSignal(sessionStore.load(options.resume), taskSignal); }
      catch (error) { throw new ExecConfigurationError("The requested Session could not be loaded", { cause: error }); }
      if (normalizeWorkspacePath(restored.summary.workspace_path) !== normalizeWorkspacePath(workspacePath)) {
        throw new ExecConfigurationError("The saved Session belongs to a different workspace; use -C with its original directory");
      }
    }
    const resolved = await waitWithSignal(dependencies.registry.resolveAll(), taskSignal);
    let selected = restored ? selectResumeModel(restored, resolved, workspacePath) : selectExecModel(resolved, options.model);
    taskSignal.throwIfAborted();
    const basePolicy = await waitWithSignal(readPolicy(workspacePath), taskSignal);
    // A CLI override selects the approval tier but keeps restrictive web,
    // shell-network, and command-rule constraints from the saved policy.
    const policy: PermissionPolicy = options.permissionMode === undefined
      ? basePolicy
      : { ...basePolicy, mode: options.permissionMode };
    if (options.resume !== undefined && !options.team?.resumeTeamId) {
      // Fork owns cancellation and must finish its transaction before cleanup.
      // Load the published child, not the earlier source projection: another
      // host may have appended to the source before its locked EOF was frozen.
      startupConfigured = true;
      const child = await sessionStore.fork(options.resume, { title: deterministicExecTitle(options.prompt), signal: taskSignal });
      sessionId = child.id;
      restored = await waitWithSignal(sessionStore.load(sessionId), taskSignal);
      selected = selectResumeModel(restored, resolved, workspacePath);
    }
    if (options.team?.resumeTeamId) { if (!restored || !options.resume) throw new ExecConfigurationError("Team continuation requires --resume with its root Session"); sessionId = options.resume; }
    ledger = new RequestAttemptLedger(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget });
    let workflow: CodingWorkflowRuntime | undefined;
    let execute: ProductionCommandExecutor | undefined;
    let goal: Awaited<ReturnType<NonNullable<AgentIO["getGoal"]>>>;
    let taskProgress: TaskProgress | undefined = restored?.taskProgress;
    let pendingInteraction: AgentInteractionRequired | undefined;
    const requestInteraction = (kind: AgentInteractionRequired["kind"], tool: string, prompt?: string): false => {
      pendingInteraction ??= { kind, tool, ...(prompt ? { prompt: safeText(prompt) } : {}) };
      return false;
    };
    let lastAssistantText: string | undefined;
    const executeDelegate: ProductionCommandExecutor = (command, signal, timeoutMs, onOutput) => {
      if (!execute) throw new Error("Command executor is not initialized");
      return execute(command, signal, timeoutMs, onOutput);
    };
    const io: AgentIO = createProductionWorkflowAgentIO({
      workspacePath,
      policy: () => policy,
      workflow: () => {
        if (!workflow) throw new Error("Coding workflow is not initialized");
        return workflow;
      },
      execute: executeDelegate,
      session: {
        getId: () => sessionId,
        async getGoal() { return goal; },
        async setGoal(next) {
          if (!sessionId) throw new Error("Goal persistence requires an active session");
          await sessionStore.setGoal(sessionId, next);
          goal = { ...next };
        },
        getTaskProgress() { return taskProgress === undefined ? undefined : cloneTaskProgress(taskProgress); },
        async setTaskProgress(progress) {
          if (!sessionId) throw new Error("Task progress persistence requires an active session");
          await sessionStore.setTaskProgress(sessionId, progress);
          taskProgress = cloneTaskProgress(progress);
        },
      },
      interaction: {
        async confirm(_kind, tool, prompt) {
          return requestInteraction("approval", tool === "patch" ? "apply_patch" : tool, prompt);
        },
        async requestUserInput(request) {
          requestInteraction("question", "request_user_input", questionPrompt(request));
          return {};
        },
        ...(options.plan === true ? {
          async reviewPlan(submitted: Parameters<NonNullable<AgentIO["reviewPlan"]>>[0]) {
            const safe = safeText(submitted.plan, Number.MAX_SAFE_INTEGER);
            lastAssistantText = safe;
            queueTimeline("assistant", safe);
            await emit({ type: "assistant_message", text: safe });
            // Non-interactive exec never auto-approves an implementation plan.
            return "cancel" as const;
          },
        } : {}),
        takeInteractionRequired() {
          const interaction = pendingInteraction;
          pendingInteraction = undefined;
          return interaction;
        },
      },
      output: {
        async assistant(text) {
          const safe = safeText(text, Number.MAX_SAFE_INTEGER);
          lastAssistantText = safe;
          queueTimeline("assistant", safe);
          await emit({ type: "assistant_message", text: safe });
        },
        assistantDelta() {},
        tool() {},
      },
    });
    const onAgentEvent = async (event: LoopEvent): Promise<void> => {
      if (event.type === "tool_started") {
        await emit({ type: "tool_started", name: event.call.name, callId: event.call.call_id });
      } else if (event.type === "tool_finished") {
        const status = toolStatus(event.output);
        await emit({ type: "tool_finished", name: event.call.name, callId: event.call.call_id, ...(status ? { status } : {}) });
      }
    };
    handle = createAgent({
      model: selected.model,
      ...(options.team ? { team: { ...options.team, maxAttempts: Math.min(options.maxSteps ?? Infinity, options.team.maxAttempts ?? 96) }, teamModels: resolved.available, onTeamEvent: async (event: import("../team/types.js").TeamEvent) => { await emit(event); } } : {}),
      workspacePath,
      io,
      sessionStore,
      sessionId: () => sessionId,
      ...(options.version ? { version: options.version } : {}),
      learnedMemoryPolicy: EXEC_MEMORY_POLICY,
      requestAttemptLedger: ledger,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      restore: {
        ...(restored ? { initialHistory: restored.context } : {}),
        ...(restored?.taskProgress ? { initialTaskProgress: restored.taskProgress } : {}),
        onHistoryAppend: (items) => {
          if (!sessionId) throw new Error("Context persistence requires an active session");
          return sessionStore.appendContext(sessionId, items);
        },
        onContextCompacted: (items, automatic, usage) => {
          if (!sessionId) throw new Error("Compaction persistence requires an active session");
          return sessionStore.compactContext(sessionId, items, automatic, usage);
        },
        onContextPruned: (items, metadata) => {
          if (!sessionId) throw new Error("Context pruning persistence requires an active session");
          return sessionStore.pruneContext(sessionId, items, metadata);
        },
        onUsage: (usage) => {
          if (!sessionId) throw new Error("Usage persistence requires an active session");
          return sessionStore.appendUsage(sessionId, usage);
        },
        onToolEvent: onAgentEvent,
      },
    });
    if (handle.team) ledger = handle.team.accounting;
    execute = createCommandExecutor({
      workspacePath,
      policy: () => policy,
      readableRoots: handle.readableRoots,
    });
    startupConfigured = true;
    if (!restored) {
      const session = await sessionStore.create({
        title: deterministicExecTitle(options.prompt),
        titlePending: false,
        workspacePath,
        model: {
          id: selected.model.id,
          model_name: selected.model.model_name,
          base_url: selected.model.base_url,
          request_settings: { ...handle.provider.settings },
          ...(selected.model.responses_profile === undefined ? {} : { responses_profile: selected.model.responses_profile }),
        },
      });
      sessionId = session.id;
    }
    if (!sessionId) throw new Error("Exec requires an active Session");
    await sessionStore.setMemoryPolicy(sessionId, EXEC_MEMORY_POLICY);
    workflow = new CodingWorkflowRuntime({
      workspacePath,
      ...(restored?.workflow ? { initialState: restored.workflow } : {}),
      async onState(state) {
        await sessionStore.setWorkflow(sessionId!, state);
        await emit({
          type: "workflow_updated",
          phase: state.phase,
          taskId: state.task_id,
          ...(state.result ? { result: state.result } : {}),
          ...(state.result_reason ? { resultReason: safeText(state.result_reason) } : {}),
          changedPaths: [...state.changed_paths],
          repairAttempts: state.repair_attempts,
          maxRepairAttempts: state.max_repair_attempts,
          pendingVerification: state.pending_verification === true,
        });
      },
    });
    queueTimeline("user", safeText(options.prompt, Number.MAX_SAFE_INTEGER));
    await timeline;
    await emit({
      type: "session_started",
      sessionId,
      modelId: selected.model.id,
      modelName: selected.model.model_name,
      workspacePath,
      ...(restored?.lineage ? { parentSessionId: restored.lineage.parent_session_id } : {}),
    });
    taskSignal.throwIfAborted();
    const runner = new CodingTaskRunner({
      agent: handle.agent,
      workflow,
      host: {
        executeVerification(command, signal, timeoutMs) {
          if (!execute) throw new Error("Command executor is not initialized");
          return execute(command, signal, timeoutMs);
        },
        async getGoal() { return goal; },
        async addGoalTime(seconds) {
          if (!goal) return undefined;
          const next = { ...goal, time_used_seconds: goal.time_used_seconds + seconds, updated_at: new Date().toISOString() };
          await sessionStore.setGoal(sessionId!, next);
          goal = next;
          return { ...goal };
        },
        onSystemMessage(message) { queueTimeline("system", safeText(message, Number.MAX_SAFE_INTEGER)); },
      },
    });
    const runnerResult = await runner.run({ text: options.prompt, mode: options.plan === true ? "plan" : "default", source: restored ? "session_resume" : "exec", signal: taskSignal });
    await timeline;
    const assistantText = lastAssistantText;
    result = successfulResult(runnerResult, sessionId, assistantText, ledger);
    if (handle.team) { const snapshot = handle.team.snapshot(); if (snapshot) result.team = snapshot; }
    taskSignal.throwIfAborted();
    if (restored?.forkPendingResume && result.classification === "success") {
      await sessionStore.setForkPendingResume(sessionId, false);
    }
    if (result.interaction) await emit({ type: "interaction_required", ...result.interaction });
  } catch (error) {
    if (error instanceof ResourceCleanupError) {
      result = runtimeResult("runtime_error", 1, "cleanup_failed", ledger, {
        ...(sessionId ? { sessionId } : {}),
        error: errorText(error),
      });
    } else if (error instanceof TeamLimitError || error instanceof RequestUsageIncompleteError) {
      const reason = error instanceof TeamLimitError ? error.reason : "usage_limited";
      result = runtimeResult("limit_reached", 4, reason, ledger, { ...(sessionId ? { sessionId } : {}), stopReason: reason });
    } else if (deadlineExceeded) {
      result = runtimeResult("limit_reached", 4, "deadline_exceeded", ledger, {
        ...(sessionId ? { sessionId } : {}),
        stopReason: "deadline_exceeded",
      });
    } else if (outputClosed) {
      result = runtimeResult("cancelled", 1, "output_closed", ledger, {
        ...(sessionId ? { sessionId } : {}),
        stopReason: "output_closed",
      });
    } else if (options.signal?.aborted || taskSignal.aborted) {
      result = runtimeResult("cancelled", options.signalExitCode ?? 130, "cancelled", ledger, {
        ...(sessionId ? { sessionId } : {}),
        stopReason: "aborted",
      });
    } else if (error instanceof ExecConfigurationError || sessionId === undefined && !startupConfigured) {
      result = configurationResult(error);
    } else {
      result = runtimeResult("runtime_error", 1, "runtime_error", ledger, {
        ...(sessionId ? { sessionId } : {}),
        error: errorText(error),
      });
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    const cleanupErrors: unknown[] = [];
    await timeline.catch((error) => cleanupErrors.push(error));
    if (handle) await handle.dispose().catch((error) => cleanupErrors.push(error));
    if (cleanupErrors.length > 0) {
      result = runtimeResult("runtime_error", 1, "cleanup_failed", ledger, {
        ...(sessionId ? { sessionId } : {}),
        error: errorText(cleanupErrors[0]),
      });
    }
  }

  if (result && handle?.team) { const snapshot = handle.team.snapshot(); if (snapshot) result.team = snapshot; }
  return result ?? runtimeResult("runtime_error", 1, "runtime_error", ledger, {
    ...(sessionId ? { sessionId } : {}),
    error: "Exec ended without a terminal result",
  });
}
