import {
  ReactAgent,
  type AgentIO,
  type ReactAgentOptions,
  type ResponseStreamLike,
  type ResponsesClientLike,
} from "../agent/react-agent.js";
import type { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import { GoalRuntime } from "../goal/runtime.js";
import { McpRuntime, type McpRuntimeLike } from "../mcp/runtime.js";
import {
  LearnedMemoryRuntime,
  LearnedMemoryStore,
  type LearnedMemoryPolicy,
  type LearnedMemoryRuntimeLike,
} from "../memory/learned-memory.js";
import {
  createProviderRuntime,
  createSessionPromptCacheKey,
  isOfficialOpenAiBaseUrl,
  supportsPromptCacheOptions,
  type ProviderRuntime,
} from "../providers/openai-compatible.js";
import type { RegisteredModel } from "../storage/model-registry.js";
import { SessionHistoryRuntime } from "../storage/session-history.js";
import { SessionStore } from "../storage/session-store.js";
import { SkillCatalog, type SkillCatalogLike } from "../skills/catalog.js";
import { DEFAULT_MODEL_BASH_TIMEOUT_MS, runBash, type BashOutputPreview, type BashResult } from "../tools/bash.js";
import type { CodeNavigationRuntimeLike } from "../tools/code-navigation.js";
import { createCodeNavigationFromEnvironment } from "../tools/code-navigation.js";
import { createEffectiveSandboxPolicy } from "../tools/sandbox-policy.js";
import { defaultPermissions, permissionPolicyRevision, type PermissionPolicy } from "../permissions/policy.js";
import {
  previewApplyPatch,
  runApplyPatch,
  type ApplyPatchOperation,
  type ApplyPatchResult,
} from "../tools/apply-patch.js";
import type { SessionGoal } from "../storage/session-store.js";
import type { TaskProgress } from "../workflow/task-progress.js";
import type { CodingWorkflowRuntime } from "../workflow/runtime.js";
import { projectWorkflowContext } from "../workflow/model-context.js";
import { POLICY_DENIED_REMEDY } from "../tools/tool-feedback.js";

export type ProductionAgentRestore = Pick<
  ReactAgentOptions,
  | "initialHistory"
  | "initialTaskProgress"
  | "contextWindow"
  | "initialContextTokens"
  | "onHistoryAppend"
  | "onContextCompacted"
  | "onContextPruned"
  | "onUsage"
  | "onPhase"
  | "onEvent"
  | "onToolEvent"
>;

export interface ProductionAgentOptions {
  model: RegisteredModel;
  workspacePath: string;
  io: AgentIO;
  sessionStore: SessionStore;
  sessionId(): string | undefined;
  version?: string;
  /** Omit for the production workspace catalog; pass null to disable skills. */
  skills?: SkillCatalogLike | null;
  /** Omit for the production workspace runtime; pass null to disable MCP. */
  mcp?: McpRuntimeLike | null;
  /** Omit for the default persistent store; pass null to disable Memory. */
  learnedMemoryStore?: LearnedMemoryStore | null;
  learnedMemory?: LearnedMemoryRuntimeLike;
  learnedMemoryPolicy?: Partial<LearnedMemoryPolicy>;
  requestAttemptLedger?: RequestAttemptLedger;
  restore?: ProductionAgentRestore;
  providerRuntime?: ProviderRuntime;
  runMemoryRequest?<T extends { usage?: unknown; status?: unknown }>(run: () => Promise<T>): Promise<T>;
  codeNavigation?: CodeNavigationRuntimeLike | null;
  parallelReadTools?: boolean;
  maxSteps?: number;
  maxTurnDurationMs?: number;
  memoryIdleDelayMs?: number;
  memoryMinTranscriptChars?: number;
}

export interface ProductionAgentHandle {
  agent: ReactAgent;
  learnedMemory?: LearnedMemoryRuntimeLike;
  skills?: SkillCatalogLike;
  readableRoots(): readonly string[];
  provider: ProviderRuntime;
  dispose(): Promise<void>;
}

function skillReadableRoots(skills: SkillCatalogLike | undefined): readonly string[] {
  if (!skills || !("readableRoots" in skills)) return [];
  const readableRoots = (skills as { readableRoots?: unknown }).readableRoots;
  if (typeof readableRoots !== "function") return [];
  const roots = readableRoots.call(skills) as unknown;
  return Array.isArray(roots) ? roots.filter((item): item is string => typeof item === "string") : [];
}

function providerClient(provider: ProviderRuntime): ResponsesClientLike {
  const client: ResponsesClientLike = {
    responses: {
      create(params, options) {
        return provider.responses.create(params, options as never);
      },
      async stream(params, options) {
        return await provider.responses.stream(params, options as never) as ResponseStreamLike;
      },
    },
  };
  if (provider.responses.compact) {
    client.responses.compact = (params, options) => provider.responses.compact!(params, options as never);
  }
  return client;
}

/**
 * Assemble the production ReactAgent stack without depending on Ink. TUI,
 * headless execution, and benchmarks provide their interaction policy through
 * AgentIO while sharing provider, history, durable output, Memory, MCP, and
 * request-budget behavior here.
 */
export function createProductionAgent(options: ProductionAgentOptions): ProductionAgentHandle {
  const provider = options.providerRuntime ?? createProviderRuntime(
    options.model.base_url,
    options.model.api_key,
    options.model.request_settings,
    options.model.model_name,
  );
  const client = providerClient(provider);
  const skills = options.skills === undefined ? new SkillCatalog(options.workspacePath) : options.skills ?? undefined;
  const ownedMcp = options.mcp === undefined
    ? new McpRuntime({ workspacePath: options.workspacePath, ...(options.version ? { version: options.version } : {}) })
    : undefined;
  const mcp = options.mcp === undefined ? ownedMcp : options.mcp ?? undefined;
  const learnedMemoryStore = options.learnedMemoryStore === undefined
    ? new LearnedMemoryStore()
    : options.learnedMemoryStore ?? undefined;
  let ownsLearnedMemory = false;
  let learnedMemory = options.learnedMemory;
  if (!learnedMemory && learnedMemoryStore) {
    ownsLearnedMemory = true;
    const runMemoryRequest = options.runMemoryRequest ?? (async <T extends { usage?: unknown; status?: unknown }>(run: () => Promise<T>) => run());
    learnedMemory = new LearnedMemoryRuntime({
      store: learnedMemoryStore,
      client: {
        responses: {
          create(params, requestOptions) {
            return runMemoryRequest(() => provider.responses.create(params, requestOptions as never));
          },
        },
      },
      model: options.model.model_name,
      sessionId: options.sessionId,
      ...(options.memoryIdleDelayMs === undefined ? {} : { idleDelayMs: options.memoryIdleDelayMs }),
      ...(options.memoryMinTranscriptChars === undefined ? {} : { minTranscriptChars: options.memoryMinTranscriptChars }),
      ...(options.learnedMemoryPolicy === undefined ? {} : { policy: options.learnedMemoryPolicy }),
    });
  }
  learnedMemory?.setPolicy?.(options.learnedMemoryPolicy ?? {});

  let codeNavigation = options.codeNavigation === null ? undefined : options.codeNavigation;
  if (options.codeNavigation === undefined) {
    try {
      codeNavigation = createCodeNavigationFromEnvironment(options.workspacePath, {
        permissionRevision: () => permissionPolicyRevision(options.io.getPermissions?.() ?? defaultPermissions()),
      });
    }
    catch { codeNavigation = undefined; }
  }
  const goalRuntime = options.io.getGoal && options.io.setGoal
    ? new GoalRuntime({ getGoal: options.io.getGoal, setGoal: options.io.setGoal })
    : undefined;
  const questionInteraction = options.io.requestUserInput
    ? { requestInput: options.io.requestUserInput }
    : undefined;
  const planInteraction = options.io.requestUserInput && options.io.reviewPlan
    ? { requestInput: options.io.requestUserInput, reviewPlan: options.io.reviewPlan }
    : undefined;
  const restore = options.restore;
  const agent = new ReactAgent({
    workspacePath: options.workspacePath,
    client,
    model: options.model.model_name,
    io: options.io,
    parallelReadTools: options.parallelReadTools ?? true,
    providerCapabilities: provider.capabilities,
    requestSettings: provider.settings,
    sessionHistory: new SessionHistoryRuntime({
      store: options.sessionStore,
      workspacePath: options.workspacePath,
      sessionId: options.sessionId,
    }),
    async onToolResultAppend(item, attachment) {
      const sessionId = options.sessionId();
      if (!sessionId) throw new Error("Tool output persistence requires an active session");
      await options.sessionStore.commitToolResult(sessionId, item, attachment);
    },
    ...(options.requestAttemptLedger ? { requestAttemptLedger: options.requestAttemptLedger } : {}),
    ...(skills ? { skills } : {}),
    ...(mcp ? { mcp } : {}),
    ...(learnedMemory ? { learnedMemory } : {}),
    ...(options.learnedMemoryPolicy ? { learnedMemoryPolicy: options.learnedMemoryPolicy } : {}),
    ...(goalRuntime ? { goalRuntime } : {}),
    ...(questionInteraction ? { questionInteraction } : {}),
    ...(planInteraction ? { planInteraction } : {}),
    ...(codeNavigation ? { codeNavigation } : {}),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.maxTurnDurationMs === undefined ? {} : { maxTurnDurationMs: options.maxTurnDurationMs }),
    ...(isOfficialOpenAiBaseUrl(options.model.base_url)
      ? {
          promptCacheKey: () => {
            const sessionId = options.sessionId();
            return sessionId === undefined ? undefined : createSessionPromptCacheKey(sessionId);
          },
          ...(supportsPromptCacheOptions(options.model.model_name)
            ? { promptCacheOptions: { mode: "implicit" as const, ttl: "30m" as const } }
            : {}),
        }
      : {}),
    ...(restore?.initialHistory === undefined ? {} : { initialHistory: restore.initialHistory }),
    ...(restore?.initialTaskProgress === undefined ? {} : { initialTaskProgress: restore.initialTaskProgress }),
    ...(restore?.contextWindow === undefined ? {} : { contextWindow: restore.contextWindow }),
    ...(restore?.initialContextTokens === undefined ? {} : { initialContextTokens: restore.initialContextTokens }),
    ...(restore?.onHistoryAppend === undefined ? {} : { onHistoryAppend: restore.onHistoryAppend }),
    ...(restore?.onContextCompacted === undefined ? {} : { onContextCompacted: restore.onContextCompacted }),
    ...(restore?.onContextPruned === undefined ? {} : { onContextPruned: restore.onContextPruned }),
    ...(restore?.onUsage === undefined ? {} : { onUsage: restore.onUsage }),
    ...(restore?.onPhase === undefined ? {} : { onPhase: restore.onPhase }),
    ...(restore?.onEvent === undefined ? {} : { onEvent: restore.onEvent }),
    ...(restore?.onToolEvent === undefined ? {} : { onToolEvent: restore.onToolEvent }),
  });

  const disposeAgent = agent.dispose.bind(agent);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await disposeAgent();
    } finally {
      try {
        if (ownsLearnedMemory) await learnedMemory?.dispose?.();
      } finally {
        await ownedMcp?.close();
      }
    }
  };
  // Existing hosts own an AgentSession rather than the richer handle. Keep
  // that interface safe: disposing the agent also releases services created
  // by this factory.
  agent.dispose = dispose;
  return {
    agent,
    ...(learnedMemory ? { learnedMemory } : {}),
    ...(skills ? { skills } : {}),
    readableRoots: () => skillReadableRoots(skills),
    provider,
    dispose,
  };
}

export interface ProductionCommandExecutorOptions {
  workspacePath: string;
  policy: PermissionPolicy | (() => PermissionPolicy);
  readableRoots?: readonly string[] | (() => readonly string[]);
  onProcessStarted?(startupDurationMs: number): void;
}

export type ProductionCommandExecutor = (
  command: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  onOutput?: (output: BashOutputPreview) => void,
) => Promise<BashResult>;

/** Build the sandboxed command boundary used by model tools and verification. */
export function createProductionCommandExecutor(options: ProductionCommandExecutorOptions): ProductionCommandExecutor {
  return (command, signal, timeoutMs, onOutput) => {
    const startup = performance.now();
    const policy = typeof options.policy === "function" ? options.policy() : options.policy;
    const readableRoots = typeof options.readableRoots === "function"
      ? options.readableRoots()
      : options.readableRoots ?? [];
    return runBash(command, {
      cwd: options.workspacePath,
      streamOutput: false,
      timeoutMs: timeoutMs ?? DEFAULT_MODEL_BASH_TIMEOUT_MS,
      sandbox: { policy: createEffectiveSandboxPolicy(policy, options.workspacePath, readableRoots) },
      ...(options.onProcessStarted ? { onProcessStarted: () => options.onProcessStarted!(performance.now() - startup) } : {}),
      ...(signal ? { signal } : {}),
      ...(onOutput ? { onOutput } : {}),
    });
  };
}

type ConfirmationTool = "bash" | "patch" | "web" | "mcp" | "goal";

export interface ProductionWorkflowSessionBridge {
  getId?(): string | undefined;
  getGoal?(): Promise<SessionGoal | undefined>;
  setGoal?(goal: SessionGoal): Promise<void>;
  getTaskProgress?(): TaskProgress | undefined;
  setTaskProgress?(progress: TaskProgress): Promise<void>;
}

export interface ProductionWorkflowInteractionBridge {
  confirm?(kind: "approval", tool: ConfirmationTool, prompt: string): Promise<boolean>;
  requestUserInput?: AgentIO["requestUserInput"];
  reviewPlan?: AgentIO["reviewPlan"];
  takeInteractionRequired?: AgentIO["takeInteractionRequired"];
}

export interface ProductionWorkflowOutputBridge {
  assistant?(text: string): void | Promise<void>;
  assistantDelta?(text: string): void;
  tool?(text: string): void;
  toolProgress?: AgentIO["onToolProgress"];
}

export interface ProductionWorkflowAgentIOOptions {
  workspacePath: string;
  policy(): PermissionPolicy;
  workflow: CodingWorkflowRuntime | (() => CodingWorkflowRuntime);
  execute: ProductionCommandExecutor;
  executeBackground?: ProductionCommandExecutor;
  executeVerification?: ProductionCommandExecutor;
  session?: ProductionWorkflowSessionBridge;
  interaction?: ProductionWorkflowInteractionBridge;
  output?: ProductionWorkflowOutputBridge;
}

function workflowFrom(options: ProductionWorkflowAgentIOOptions): CodingWorkflowRuntime {
  return typeof options.workflow === "function" ? options.workflow() : options.workflow;
}

/**
 * Build the UI-neutral tool host around a coding workflow. Interaction and
 * rendering stay caller-owned; patch tracking, sandbox execution, blocked
 * state, and shell observation use the same behavior in every host.
 */
export function createProductionWorkflowAgentIO(options: ProductionWorkflowAgentIOOptions): AgentIO {
  const confirm = (tool: ConfirmationTool, prompt: string) =>
    options.interaction?.confirm?.("approval", tool, prompt) ?? Promise.resolve(false);
  const session = options.session;
  const interaction = options.interaction;
  const output = options.output;
  return {
    ...(session?.getId ? { getSessionId: session.getId } : {}),
    getPermissions: () => ({ ...options.policy() }),
    isToolExecutionBlocked: () => workflowFrom(options).state.phase === "blocked",
    getWorkflowContext: () => projectWorkflowContext(workflowFrom(options).state),
    confirmBash: (command) => confirm("bash", command),
    confirmPatch: (summary) => confirm("patch", summary),
    confirmWeb: (request) => confirm("web", request),
    confirmMcp: (request) => confirm("mcp", request),
    confirmGoal: (request) => confirm("goal", request),
    ...(interaction?.requestUserInput ? { requestUserInput: interaction.requestUserInput } : {}),
    ...(interaction?.reviewPlan ? { reviewPlan: interaction.reviewPlan } : {}),
    ...(interaction?.takeInteractionRequired ? { takeInteractionRequired: interaction.takeInteractionRequired } : {}),
    ...(session?.getGoal ? { getGoal: session.getGoal } : {}),
    ...(session?.setGoal ? { setGoal: session.setGoal } : {}),
    ...(session?.getTaskProgress ? { getTaskProgress: session.getTaskProgress } : {}),
    ...(session?.setTaskProgress ? { setTaskProgress: session.setTaskProgress } : {}),
    previewPatch(operations: readonly ApplyPatchOperation[]) {
      return previewApplyPatch(operations, options.workspacePath, {
        allowProtectedPaths: options.policy().mode === "full-access",
      });
    },
    async runApplyPatch(operations: readonly ApplyPatchOperation[], signal?: AbortSignal): Promise<ApplyPatchResult> {
      const workflow = workflowFrom(options);
      await workflow.capturePatch(operations);
      signal?.throwIfAborted();
      const policy = options.policy();
      if (policy.mode === "read-only") {
        return { status: "rejected", files: [], error: "The read-only profile does not allow file edits", errorCode: "POLICY_DENIED", remedy: POLICY_DENIED_REMEDY };
      }
      return runApplyPatch(operations, options.workspacePath, { allowProtectedPaths: policy.mode === "full-access" });
    },
    afterPatchApplied(operations: readonly ApplyPatchOperation[], result: ApplyPatchResult, signal?: AbortSignal) {
      return workflowFrom(options).afterPatch(operations, result, options.executeVerification ?? options.execute, signal);
    },
    async runBash(command: string, signal?: AbortSignal) {
      const workflow = workflowFrom(options);
      if (workflow.state.phase === "blocked") {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: "The coding workflow reached its repair limit" };
      }
      try { return await options.execute(command, signal); }
      finally { await workflow.observeShellExecution(); }
    },
    async runBackgroundBash(command, signal, timeoutMs, onOutput) {
      const workflow = workflowFrom(options);
      if (workflow.state.phase === "blocked") {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: "The coding workflow reached its repair limit" };
      }
      try { return await (options.executeBackground ?? options.execute)(command, signal, timeoutMs, onOutput); }
      finally { await workflow.observeShellExecution(); }
    },
    writeAssistant: (text) => output?.assistant?.(text),
    ...(output?.assistantDelta ? { writeAssistantDelta: output.assistantDelta } : {}),
    ...(output?.tool ? { writeTool: output.tool } : {}),
    ...(output?.toolProgress ? { onToolProgress: output.toolProgress } : {}),
  };
}
