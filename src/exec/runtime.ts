import { TeamLimitError } from "../team/ledger.js";
import { execErrorCode } from "./errors.js";
import { PersistenceError } from "../storage/persistence-error.js";
import { RequestUsageIncompleteError } from "../agent/request-attempt-ledger.js";
import { normalizeTeamOptions } from "../team/types.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { LoopEvent } from "../agent/agent-loop.js";
import { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import type { AgentIO, AgentInteractionRequired, AgentSkillInput } from "../agent/react-agent.js";
import { hasPromptImages, type PromptAttachment } from "../agent/file-attachments.js";
import type { TeamOptions } from "../team/types.js";
import { normalizePlanReview, type PlanRequest, type PlanReviewResult, type SubmittedPlan } from "../plan/runtime.js";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";
import { loadPermissionPolicy, permissionPolicyRevision, webPermissionPolicy, type PermissionPolicy } from "../permissions/policy.js";
import { uiText } from "../localization/messages.js";
import { supportsResponsesImages } from "../providers/openai-compatible.js";
import {
  createProductionAgent,
  createProductionCommandExecutor,
  createProductionWorkflowAgentIO,
  type ProductionAgentHandle,
  type ProductionCommandExecutor,
  type ProductionWorkflowInteractionBridge,
} from "../runtime/production.js";
import type { ResolvedModels } from "../storage/model-registry.js";
import { nextGoalRevision, SessionStore, type LoadedSession, type SessionGoal, type StoredTextTimelineEntry, type StoredTimelineEntry, type TimelineInputFile, type WebTurnOutcome } from "../storage/session-store.js";
import type { WebInboxItem } from "../storage/web-inbox.js";
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

export class InteractivePermissionChangeError extends Error {
  constructor() {
    super("Permission policy changed. Start a new turn to use the current permissions.");
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
    errorCode: "CONFIGURATION_ERROR",
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
  const code = execErrorCode(classification, status);
  return {
    exitCode,
    classification,
    status,
    usageComplete: usage?.complete ?? true,
    ...(code ? { errorCode: code } : {}),
    ...(usage ? { usage } : {}),
    ...details,
  };
}

function successfulResult(
  result: CodingTaskRunnerResult,
  sessionId: string,
  assistantText: string | undefined,
  ledger: RequestAttemptLedger,
  planOnly = false,
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
  if (planOnly && result.disposition === "completed" || result.disposition === "plan_cancelled" || result.disposition === "plan_approved") {
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

function webTurnOutcome(result: ExecResult): WebTurnOutcome {
  switch (result.classification) {
    case "success": return result.workflowResult === "verified" ? "verified" : result.workflowResult === "no_changes" ? "no_changes" : "plan";
    case "cancelled": return "cancelled";
    case "verification_failed": return result.workflowResult === "unverified" ? "unverified" : "verification_failed";
    case "limit_reached":
      return result.stopReason && result.stopReason !== "aborted" && result.stopReason !== "output_closed"
        ? result.stopReason : "runtime_error";
    case "runtime_error":
      if (result.status === "cleanup_failed") return "cleanup_failed";
      if (result.status === "permission_changed") return "permission_changed";
      if (result.errorCode === "PERSISTENCE_FAILED") return "persistence_failed";
      return "runtime_error";
    default: return result.classification;
  }
}

/** Run one normal, recoverable coding Session without mounting Ink. */
export async function runExec(options: ExecOptions, dependencies: ExecDependencies): Promise<ExecResult> {
  return runTask(options, dependencies);
}

/** Process-local interaction hooks. The CLI and public SDK keep their one-shot contract. */
export interface InteractiveTaskHost {
  confirm: NonNullable<ProductionWorkflowInteractionBridge["confirm"]>;
  confirmWithoutUntrustedMcp(signal: AbortSignal): Promise<boolean>;
  skillInput(text: string): AgentSkillInput;
  backgroundJobs: import("../tools/background-jobs.js").BackgroundJobObserver;
  ask(request: PlanRequest, signal: AbortSignal): Promise<Record<string, string>>;
  reviewPlan(submission: SubmittedPlan, callId: string, signal: AbortSignal): Promise<PlanReviewResult>;
  onPlanImplementation(): void;
  onSettlement(): void;
  onGoal(sessionId: string, goal: SessionGoal, revision: number): void;
  onSteeringReady(offer: (item: WebInboxItem) => boolean): void;
  onHistoryLoaded(entries: readonly StoredTimelineEntry[]): void;
  onDelta(text: string): void;
  onTool(callId: string, name: string, output?: string): void;
  onTimeline(entry: StoredTextTimelineEntry): void;
}

export interface InteractivePromptData {
  attachments?: readonly PromptAttachment[];
  uploadedFiles?: readonly TimelineInputFile[];
  referenceContext?: string;
  inboxItem?: Pick<WebInboxItem, "id" | "requestId" | "revision">;
  resumeGoal?: true;
  team?: TeamOptions;
}

export async function runInteractiveTask(
  options: Pick<ExecOptions, "prompt" | "workspacePath" | "model" | "resume" | "signal" | "onEvent" | "plan" | "team"> & InteractivePromptData,
  dependencies: ExecDependencies,
  host: InteractiveTaskHost,
): Promise<ExecResult> {
  return runTask(options, dependencies, host, options);
}

async function runTask(options: ExecOptions, dependencies: ExecDependencies, interactive?: InteractiveTaskHost, input?: InteractivePromptData): Promise<ExecResult> {
  try {
    if (!options.prompt.trim() && !input?.attachments?.length) throw new ExecConfigurationError("Exec prompt must not be empty");
    if (options.resume !== undefined && !/^[A-Za-z0-9_-]+$/u.test(options.resume)) {
      throw new ExecConfigurationError("--resume requires a local Session ID");
    }
    if (!interactive && options.resume !== undefined && options.model !== undefined) {
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
  let permissionChanged = false;
  let interactivePromptSaved = false;
  let releaseInteractiveSession: import("../storage/session-activity.js").ActivityLease | undefined;
  let timeline = Promise.resolve();
  const appendTimeline = (entry: StoredTextTimelineEntry): void => {
    if (!sessionId) return;
    const id = sessionId;
    timeline = timeline.then(async () => {
      const stored = interactive && entry.kind === "user"
        ? { ...entry, web_turn_started: true as const, ...(input?.inboxItem ? { web_input: input.inboxItem } : {}) }
        : entry;
      if (stored.web_input) await sessionStore.commitWebInput(id, stored);
      else await sessionStore.appendTimeline(id, stored);
      if (stored.web_turn_started) interactivePromptSaved = true;
      interactive?.onTimeline(stored);
    });
    // Keep the rejection for settlement even when no caller is awaiting this append yet.
    void timeline.catch(() => undefined);
  };
  const queueTimeline = (kind: "user" | "assistant" | "system" | "tool", text: string): void => {
    const files = kind === "user" && input?.uploadedFiles?.length ? input.uploadedFiles : undefined;
    appendTimeline({ kind, text, ...(files === undefined ? {} : { input_files: [...files] }) });
  };
  let planCallId: string | undefined;
  let approvedPlan: SubmittedPlan | undefined;

  try {
    taskSignal.throwIfAborted();
    const workspace = await waitWithSignal(fs.stat(workspacePath), taskSignal).catch((error) => {
      throw new ExecConfigurationError(`Workspace is unavailable: ${workspacePath}`, { cause: error });
    });
    if (!workspace.isDirectory()) throw new ExecConfigurationError(`Workspace is not a directory: ${workspacePath}`);
    let restored: LoadedSession | undefined;
    if (options.resume !== undefined) {
      if (interactive) releaseInteractiveSession = await sessionStore.activity.acquire(options.resume);
      try { restored = await waitWithSignal(sessionStore.load(options.resume), taskSignal); }
      catch (error) { throw new ExecConfigurationError("The requested Session could not be loaded", { cause: error }); }
      if (normalizeWorkspacePath(restored.summary.workspace_path) !== normalizeWorkspacePath(workspacePath)) {
        throw new ExecConfigurationError("The saved Session belongs to a different workspace; use -C with its original directory");
      }
      interactive?.onHistoryLoaded(restored.timeline);
    }
    const resolved = await waitWithSignal(dependencies.registry.resolveAll(), taskSignal);
    if (interactive && options.model !== undefined) {
      if (restored && restored.summary.model.id !== options.model) throw new ExecConfigurationError("The saved Session model changed. Reopen the session before sending.");
      if (!resolved.available.some(model => model.id === options.model)) throw new ExecConfigurationError("The selected model is unavailable.");
    }
    let selected = restored ? selectResumeModel(restored, resolved, workspacePath) : selectExecModel(resolved, options.model);
    const supportsImages = supportsResponsesImages(selected.model.base_url, selected.model.model_name);
    if (hasPromptImages(input?.attachments) && !supportsImages) throw new ExecConfigurationError(uiText("web.image.modelUnsupported"));
    taskSignal.throwIfAborted();
    const basePolicy = await waitWithSignal(readPolicy(workspacePath), taskSignal);
    // A CLI override selects the approval tier but keeps restrictive web,
    // shell-network, and command-rule constraints from the saved policy.
    const policy: PermissionPolicy = interactive
      ? webPermissionPolicy(basePolicy, restored?.summary.web_permission_mode)
      : options.permissionMode === undefined ? basePolicy : { ...basePolicy, mode: options.permissionMode };
    if (interactive) sessionId = options.resume;
    else if (options.resume !== undefined && !options.team?.resumeTeamId) {
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
    let goal = interactive ? restored?.goal : undefined;
    let goalRevision = restored?.summary.goal_revision ?? 0;
    const persistGoal = async (next: SessionGoal) => {
      if (!sessionId) throw new Error("Goal persistence requires an active session");
      await sessionStore.setGoal(sessionId, next);
      goalRevision = nextGoalRevision(goal, next, goalRevision);
      goal = { ...next };
      interactive?.onGoal(sessionId, goal, goalRevision);
    };
    let taskProgress: TaskProgress | undefined = restored?.taskProgress;
    let pendingInteraction: AgentInteractionRequired | undefined;
    const requestInteraction = (kind: AgentInteractionRequired["kind"], tool: string, prompt?: string): false => {
      pendingInteraction ??= { kind, tool, ...(prompt ? { prompt: safeText(prompt) } : {}) };
      return false;
    };
    const validatePermissions = async (signal = taskSignal) => {
      signal.throwIfAborted();
      if (permissionPolicyRevision(await readPolicy(workspacePath)) !== permissionPolicyRevision(basePolicy)) {
        permissionChanged = true;
        const error = new InteractivePermissionChangeError();
        controller.abort(error);
        throw error;
      }
      signal.throwIfAborted();
    };
    const confirm = async (kind: "approval", tool: Parameters<InteractiveTaskHost["confirm"]>[1], prompt: string, signal?: AbortSignal) => {
      if (!interactive) return requestInteraction(kind, tool === "patch" ? "apply_patch" : tool, prompt);
      const approvalSignal = signal ? AbortSignal.any([signal, taskSignal]) : taskSignal;
      approvalSignal.throwIfAborted();
      const accepted = await interactive.confirm(kind, tool, safeText(prompt, 32_768), approvalSignal);
      if (accepted) await validatePermissions(approvalSignal);
      return accepted;
    };
    let lastAssistantText: string | undefined;
    const executeDelegate: ProductionCommandExecutor = async (command, signal, timeoutMs, onOutput, onOutputChunk) => {
      if (!execute) throw new Error("Command executor is not initialized");
      if (interactive) await validatePermissions(signal);
      return execute(command, signal, timeoutMs, onOutput, onOutputChunk);
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
        setGoal: persistGoal,
        getTaskProgress() { return taskProgress === undefined ? undefined : cloneTaskProgress(taskProgress); },
        async setTaskProgress(progress) {
          if (!sessionId) throw new Error("Task progress persistence requires an active session");
          await sessionStore.setTaskProgress(sessionId, progress);
          taskProgress = cloneTaskProgress(progress);
        },
      },
      interaction: {
        confirm,
        async requestUserInput(request, signal) {
          if (interactive) {
            const questionSignal = signal ? AbortSignal.any([signal, taskSignal]) : taskSignal;
            const answer = await interactive.ask(request, questionSignal);
            await validatePermissions(questionSignal);
            return answer;
          }
          requestInteraction("question", "request_user_input", questionPrompt(request));
          return {};
        },
        ...(options.plan === true ? {
          async reviewPlan(submitted: SubmittedPlan, signal?: AbortSignal) {
            const safe = safeText(submitted.plan, Number.MAX_SAFE_INTEGER);
            if (interactive) {
              const title = safeText(submitted.title, 120).replace(/\s+/gu, " ").trim();
              const markdown = /^#\s+\S/u.test(safe) ? safe : `# ${title}\n\n${safe}`;
              if (markdown.length > 60_000) throw new Error("Submit a plan of at most 60000 characters");
              const visible = { title, plan: markdown };
              const callId = planCallId = randomUUID();
              appendTimeline({ kind: "tool", text: markdown, plan: { callId, phase: "submitted" } });
              await timeline;
              const reviewSignal = signal ? AbortSignal.any([signal, taskSignal]) : taskSignal;
              const review = normalizePlanReview(await interactive.reviewPlan(visible, callId, reviewSignal));
              if (review.decision === "approve") {
                await validatePermissions(reviewSignal);
                approvedPlan = visible;
              }
              return review;
            }
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
        assistantDelta(text) { interactive?.onDelta(text); },
        tool() {},
      },
    });
    if (interactive) {
      io.beforeTool = validatePermissions;
      io.backgroundJobs = interactive.backgroundJobs;
      io.onSkillInvoked = async name => {
        appendTimeline({ kind: "system", text: "", web_skill_name: name });
        await timeline;
      };
      io.confirmWithoutUntrustedMcp = async signal => {
        const proceed = await interactive.confirmWithoutUntrustedMcp(signal);
        if (proceed) await validatePermissions(signal);
        return proceed;
      };
    }
    const onAgentEvent = async (event: LoopEvent): Promise<void> => {
      if (event.type === "tool_started") {
        interactive?.onTool(event.call.call_id, event.call.name);
        await emit({ type: "tool_started", name: event.call.name, callId: event.call.call_id });
      } else if (event.type === "tool_finished") {
        if (interactive) {
          const output = safeText(event.output, 24_000);
          if (event.call.name === "submit_plan" && planCallId !== undefined) {
            appendTimeline({ kind: "tool", text: output, plan: { callId: planCallId, phase: "settled" } });
            planCallId = undefined;
          } else queueTimeline("tool", `${event.call.name}\n${output}`);
          await timeline;
          interactive.onTool(event.call.call_id, event.call.name, output);
        }
        const status = toolStatus(event.output);
        await emit({ type: "tool_finished", name: event.call.name, callId: event.call.call_id, ...(status ? { status } : {}) });
      }
    };
    handle = createAgent({
      onPerformanceReport: (report) => emit({ type: "performance_report", report }),
      model: selected.model,
      onCostEstimate: (estimate) => emit({ type: "cost_estimated", estimate }),
      ...(options.team ? { team: { ...options.team, maxAttempts: Math.min(options.maxSteps ?? Infinity, options.team.maxAttempts ?? 96) }, teamModels: resolved.available, onTeamEvent: async (event: import("../team/types.js").TeamEvent) => { await emit(event); } } : {}),
      workspacePath,
      io,
      sessionStore,
      sessionId: () => sessionId,
      ...(options.version ? { version: options.version } : {}),
      learnedMemoryPolicy: interactive ? restored?.memoryPolicy ?? EXEC_MEMORY_POLICY : EXEC_MEMORY_POLICY,
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
      onProcessStarted: (ms) => handle?.agent.recordPerformanceTiming?.("sandbox_startup", ms),
      workspacePath,
      policy: () => policy,
      readableRoots: handle.readableRoots,
    });
    startupConfigured = true;
    if (!restored) {
      const session = await sessionStore.create({
        title: interactive ? deterministicExecTitle(options.prompt.trim() || input?.uploadedFiles?.[0]?.name || "").slice(6) : deterministicExecTitle(options.prompt),
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
    if (interactive && !releaseInteractiveSession) releaseInteractiveSession = await sessionStore.activity.acquire(sessionId);
    if (!interactive || !restored) await sessionStore.setMemoryPolicy(sessionId, EXEC_MEMORY_POLICY);
    workflow = new CodingWorkflowRuntime({
      workspacePath,
      confirmVerificationBasis: (summary, signal) => confirm("approval", "verification_basis", summary, signal),
      permissionRevision: () => permissionPolicyRevision(policy),
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
          ...(state.last_verification_suite?.evidence ? { verificationEvidence: state.last_verification_suite.evidence } : {}),
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
          return executeDelegate(command, signal, timeoutMs);
        },
        async getGoal() { return goal; },
        async addGoalTime(seconds) {
          if (!goal) return undefined;
          const next = { ...goal, time_used_seconds: goal.time_used_seconds + seconds, updated_at: new Date().toISOString() };
          await persistGoal(next);
          return { ...goal };
        },
        onSystemMessage(message) { queueTimeline("system", safeText(message, Number.MAX_SAFE_INTEGER)); },
      },
    });
    // Interactive turns handle pending startup trust at the Agent's turn boundary.
    const startupInteraction = interactive ? undefined : await handle.prepareMcp?.(taskSignal);
    // Acquire the current Session lease before considering startup cleanup.
    await handle.agent.ensureSessionActivity?.();
    if (dependencies.sessionStore === undefined) {
      const { SessionPrivacy } = await import("../storage/session-privacy.js");
      try { await new SessionPrivacy(sessionStore).autoCleanup(); }
      catch { queueTimeline("system", "Automatic privacy cleanup could not complete. Use the privacy CLI to preview and retry."); }
    }
    const prompt = options.prompt.trim() || "Use the attachments in this message.";
    const text = input?.referenceContext ? `${prompt}\n\n${input.referenceContext}` : prompt;
    const interactiveSource = restored?.forkPendingResume || input?.resumeGoal ? "session_resume" : "user";
    let planOnly = !!interactive && options.plan === true;
    if (interactive) {
      const agent = handle.agent;
      const id = sessionId;
      interactive.onSteeringReady(item => {
        if (planOnly || taskSignal.aborted || !supportsImages && hasPromptImages(item.attachments)) return false;
        const prompt = item.text.trim() || "Use the attachments in this message.";
        const text = item.referenceContext ? `${prompt}\n\n${item.referenceContext}` : prompt;
        const { id: itemId, requestId, revision } = item;
        const entry: StoredTextTimelineEntry = {
          kind: "user", text: item.text, web_input: { id: itemId, requestId, revision },
          ...(item.uploadedFiles ? { input_files: [...item.uploadedFiles] } : {}),
        };
        return agent.requestSteering(text, item.attachments, {
          // Let the in-flight request report usage before applying steering.
          // The loop checkpoints its response and skips stale tool calls.
          waitForSample: true,
          skillInput: interactive.skillInput(item.text),
          async persist(protectedItems) {
            await timeline;
            await sessionStore.commitWebInput(id, entry, protectedItems);
            interactive.onTimeline(entry);
          },
        });
      });
    }
    let runnerResult: CodingTaskRunnerResult = startupInteraction
      ? { disposition: "stopped", agentResult: { interactionRequired: startupInteraction }, diagnosticRounds: 0 }
      : await runner.run({ text, ...(input?.attachments?.length ? { attachments: input.attachments } : {}),
        ...(interactive ? { skillInput: interactive.skillInput(options.prompt) } : {}),
        mode: options.plan === true ? "plan" : "default", source: interactive ? interactiveSource : restored ? "session_resume" : "exec", signal: taskSignal });
    if (interactive && runnerResult.disposition === "plan_approved" && approvedPlan) {
      await timeline;
      await validatePermissions(taskSignal);
      if (!ledger.usageComplete) throw new RequestUsageIncompleteError();
      interactive.onPlanImplementation();
      planOnly = false;
      runnerResult = await runner.run({
        text: `Implement the following plan, which the user approved and explicitly started in the browser. Inspect current files and project rules before editing, respect current permissions, and verify the result.\n\n${approvedPlan.plan}`,
        mode: "default", source: interactiveSource, signal: taskSignal, continueRequestAccounting: true,
      });
    }
    await timeline;
    const assistantText = lastAssistantText;
    result = interactive && runnerResult.disposition === "plan_cancelled"
      ? runtimeResult("cancelled", 130, "cancelled", ledger, { sessionId, stopReason: "aborted" })
      : successfulResult(runnerResult, sessionId, assistantText, ledger, planOnly);
    if (handle.team) { const snapshot = handle.team.snapshot(); if (snapshot) result.team = snapshot; }
    taskSignal.throwIfAborted();
    if (restored?.forkPendingResume && result.classification === "success" && !planOnly) {
      await sessionStore.setForkPendingResume(sessionId, false);
    }
    if (result.interaction) await emit({ type: "interaction_required", ...result.interaction });
  } catch (error) {
    if (error instanceof ResourceCleanupError) {
      result = runtimeResult("runtime_error", 1, "cleanup_failed", ledger, {
        ...(sessionId ? { sessionId } : {}),
        error: errorText(error),
      });
    } else if (error instanceof PersistenceError) {
      result = runtimeResult("runtime_error", 1, "runtime_error", ledger, {
        ...(sessionId ? { sessionId } : {}), error: errorText(error), errorCode: "PERSISTENCE_FAILED",
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
    } else if (permissionChanged || options.signal?.reason instanceof InteractivePermissionChangeError) {
      result = runtimeResult("runtime_error", 1, "permission_changed", ledger, {
        ...(sessionId ? { sessionId } : {}),
        error: errorText(permissionChanged ? controller.signal.reason : options.signal?.reason),
      });
    } else if (options.signal?.aborted || taskSignal.aborted) {
      result = runtimeResult("cancelled", options.signalExitCode ?? 130, "cancelled", ledger, {
        ...(sessionId ? { sessionId } : {}),
        stopReason: "aborted",
        ...(interactive && controller.signal.aborted && !options.signal?.aborted ? { error: errorText(controller.signal.reason) } : {}),
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
    let settlementFailed = false;
    let settlementError: unknown;
    await timeline.catch((error) => cleanupErrors.push(error));
    if (handle) await handle.dispose().catch((error) => cleanupErrors.push(error));
    const releaseActivity = () => releaseInteractiveSession?.(cleanupErrors.length === 0 && result?.status !== "cleanup_failed")
      .catch((error) => { cleanupErrors.push(error); });
    if (interactive && sessionId && interactivePromptSaved && result) {
      let outcome: WebTurnOutcome | undefined;
      try {
        // The append holds the log lock across activity release. A new owner may
        // acquire activity then, but its writes must follow this outcome.
        await sessionStore.settleWebTurn(sessionId, async () => {
          await releaseActivity();
          interactive.onSettlement();
          if (result?.classification === "success" && options.signal?.aborted) {
            result = options.signal.reason instanceof InteractivePermissionChangeError
              ? runtimeResult("runtime_error", 1, "permission_changed", ledger, { sessionId: sessionId!, error: errorText(options.signal.reason) })
              : runtimeResult("cancelled", 130, "cancelled", ledger, { sessionId: sessionId!, stopReason: "aborted" });
          }
          outcome = cleanupErrors.length ? "cleanup_failed" : webTurnOutcome(result!);
          return outcome;
        });
      } catch (error) {
        settlementFailed = true;
        settlementError = error;
        if (outcome === undefined) await releaseActivity();
        outcome = undefined;
      }
      if (outcome !== undefined) interactive.onTimeline({ kind: "system", text: "", web_turn_outcome: outcome });
    } else {
      await releaseActivity();
    }
    if (cleanupErrors.length > 0) {
      result = runtimeResult("runtime_error", 1, "cleanup_failed", ledger, {
        ...(sessionId ? { sessionId } : {}),
        error: errorText(cleanupErrors[0]),
      });
    } else if (settlementFailed && result?.status !== "cleanup_failed") {
      result = runtimeResult("runtime_error", 1, "persistence_failed", ledger, {
        ...(sessionId ? { sessionId } : {}),
        error: errorText(settlementError),
      });
    }
  }

  if (result && handle?.team) { const snapshot = handle.team.snapshot(); if (snapshot) result.team = snapshot; }
  if (result && handle?.agent.getPerformanceReport) { const report = handle.agent.getPerformanceReport(); if (report) result.performanceReport = report; }
  return result ?? runtimeResult("runtime_error", 1, "runtime_error", ledger, {
    ...(sessionId ? { sessionId } : {}),
    error: "Exec ended without a terminal result",
  });
}
