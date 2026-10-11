import { isolatedCommand, verifyTeamIsolation } from "../team/isolation.js";
import { sanitizeExecOutput } from "../cli/exec-output.js";
import { TeamRuntime, type MemberExecution } from "../team/runtime.js";
import { TeamStore } from "../team/store.js";
import { teamWorkspaceRoot, within } from "../team/workspace.js";
import type { TeamOptions, TeamEvent } from "../team/types.js";
import { CodingWorkflowRuntime } from "../workflow/runtime.js";
import { CodingTaskRunner } from "../workflow/task-runner.js";
import {
  ReactAgent,
  type AgentIO,
  type ReactAgentOptions,
  type ResponseStreamLike,
  type ResponsesClientLike,
} from "../agent/react-agent.js";
import type { RequestAttemptLedger } from "../agent/request-attempt-ledger.js";
import { ProcessCleanupError } from "../tools/process-completion.js";
import { GoalRuntime } from "../goal/runtime.js";
import { McpRuntime, type McpRuntimeLike } from "../mcp/runtime.js";
import {
  LearnedMemoryRuntime,
  LearnedMemoryStore,
  type LearnedMemoryPolicy,
  type LearnedMemoryRuntimeLike,
  type MemoryRequestRunner,
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
import { commandPermission, defaultPermissions, permissionPolicyRevision, type PermissionPolicy } from "../permissions/policy.js";
import {
  previewApplyPatch,
  runApplyPatch,
  type ApplyPatchOperation,
  type ApplyPatchResult,
} from "../tools/apply-patch.js";
import type { SessionGoal } from "../storage/session-store.js";
import type { TaskProgress } from "../workflow/task-progress.js";
import { projectWorkflowContext } from "../workflow/model-context.js";
import { POLICY_DENIED_REMEDY } from "../tools/tool-feedback.js";
import { hasOpaqueProviderContext, resolveProviderCapabilities } from "../providers/capabilities.js";

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
> & { onMemberUsage?(usage: import("../status/model-status.js").TokenUsageSample | null): Promise<void>; };

class MemberInteractionStop extends Error {}

export interface ProductionAgentOptions {
  model: RegisteredModel;
  team?: TeamOptions;
  teamModels?: readonly RegisteredModel[];
  teamStore?: TeamStore;
  onTeamEvent?(event: TeamEvent): Promise<void> | void;
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
  runMemoryRequest?: MemoryRequestRunner;
  codeNavigation?: CodeNavigationRuntimeLike | null;
  parallelReadTools?: boolean;
  loopStrategy?: import("../agent/tool-feedback-policy.js").LoopStrategy;
  maxSteps?: number;
  maxTurnDurationMs?: number;
  memoryIdleDelayMs?: number;
  memoryMinTranscriptChars?: number;
}

export interface ProductionAgentHandle {
  agent: ReactAgent;
  team?: TeamRuntime;
  learnedMemory?: LearnedMemoryRuntimeLike;
  skills?: SkillCatalogLike;
  readableRoots(): readonly string[];
  provider: ProviderRuntime;
  prepareMcp?(signal?: AbortSignal): Promise<import("../agent/react-agent.js").AgentInteractionRequired | undefined>;
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
  const capabilities = options.providerRuntime?.capabilities ?? resolveProviderCapabilities(options.model.base_url, options.model.model_name, options.model.responses_profile);
  if (hasOpaqueProviderContext(options.restore?.initialHistory ?? []) && !capabilities.encryptedReasoning) {
    throw new Error("Saved opaque provider context is incompatible with this Responses profile. Restore the original profile or start a new Session.");
  }
  const provider = options.providerRuntime ?? createProviderRuntime(
    options.model.base_url,
    options.model.api_key,
    options.model.request_settings,
    options.model.model_name,
    options.model.responses_profile,
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
    learnedMemory = new LearnedMemoryRuntime({
      store: learnedMemoryStore,
      client,
      model: options.model.model_name,
      sessionId: options.sessionId,
      ...(options.runMemoryRequest ? { runRequest: options.runMemoryRequest } : {}),
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
    ? new GoalRuntime({ getGoal: options.io.getGoal, setGoal: async (goal) => { await options.io.setGoal!(goal); team?.restrictGoal(goal); } })
    : undefined;
  const questionInteraction = options.io.requestUserInput
    ? { requestInput: options.io.requestUserInput }
    : undefined;
  const planInteraction = options.io.requestUserInput && options.io.reviewPlan
    ? { requestInput: options.io.requestUserInput, reviewPlan: options.io.reviewPlan }
    : undefined;
  const restore = options.restore;
  let team: TeamRuntime | undefined;
  let approvalQueue = Promise.resolve();
  const confirmMember = (confirm: (() => Promise<boolean>) | undefined): Promise<boolean> => {
    const result = approvalQueue.then(() => confirm?.() ?? false);
    approvalQueue = result.then(() => {}, () => {});
    return result;
  };
  const rootIO: AgentIO = options.team ? { ...options.io,
    ...(options.io.setGoal ? { setGoal: async (goal) => { await options.io.setGoal!(goal); team?.restrictGoal(goal); } } : {}),
    confirmBash: (prompt, signal) => confirmMember(() => options.io.confirmBash(prompt, signal ?? team?.signal())),
    confirmPatch: (prompt, signal) => confirmMember(() => options.io.confirmPatch?.(prompt, signal ?? team?.signal()) ?? Promise.resolve(false)),
    confirmWeb: (prompt, signal) => confirmMember(() => options.io.confirmWeb?.(prompt, signal ?? team?.signal()) ?? Promise.resolve(false)),
    confirmMcp: (prompt, signal) => confirmMember(() => options.io.confirmMcp?.(prompt, signal ?? team?.signal()) ?? Promise.resolve(false)),
    confirmGoal: (prompt, signal) => confirmMember(() => options.io.confirmGoal?.(prompt, signal ?? team?.signal()) ?? Promise.resolve(false)),
  } : options.io;
  const executeMember = async (execution: MemberExecution) => {
    const workspacePath = execution.workspace?.workspace ?? options.workspacePath;
    const worker = execution.member.task.role === "worker";
    const getPolicy = (): PermissionPolicy => {
      const root = options.io.getPermissions?.() ?? defaultPermissions();
      return { ...root, mode: worker ? root.mode === "full-access" ? "workspace-write" : root.mode : "read-only" };
    };
    if (execution.workspace) await verifyTeamIsolation(execution.workspace, getPolicy(), execution.signal);
    const model = execution.model;
    const session = await options.sessionStore.create({ title: `[${execution.member.task.role}] ${execution.member.task.goal.slice(0, 80)}`, titlePending: false, workspacePath, model: { id: model.id, model_name: model.model_name, base_url: model.base_url, ...(model.responses_profile ? { responses_profile: model.responses_profile } : {}) } });
    await execution.onSession(session.id);
    let summary = "";
    let memberHandle: ProductionAgentHandle | undefined;
    let interaction: { kind: "approval" | "question"; tool: string; prompt?: string } | undefined;
    const workflow = new CodingWorkflowRuntime({ workspacePath, onState: (state) => options.sessionStore.setWorkflow(session.id, state) });
    const executeNative = createProductionCommandExecutor({ workspacePath, policy: getPolicy, ...(execution.workspace ? { isolation: { deniedRoots: [options.workspacePath, teamWorkspaceRoot(), ...(within(options.workspacePath, execution.workspace.commonGitDir) ? [] : [execution.workspace.commonGitDir])], writableRoot: workspacePath, traversalRoots: [execution.workspace.owner] } } : {}) });
    const label = `[Team ${execution.member.agentId} / ${execution.member.task.role}] ${workspacePath}\n`;
    const execute: ProductionCommandExecutor = async (command, signal, timeoutMs, onOutput) => {
      const policy = getPolicy(); const revision = permissionPolicyRevision(policy);
      const permission = commandPermission(command, policy);
      const allowed = permission !== "deny" && (permission !== "ask" || await confirmMember(() => options.io.confirmBash(`${label}Run verification: ${command}`, signal ?? execution.signal)));
      if (!allowed) {
        interaction ??= options.io.takeInteractionRequired?.();
        if (interaction) throw new MemberInteractionStop();
        return { stdout: "", stderr: "", exitCode: null, signal: null, error: "Verification command was not approved under the current policy" };
      }
      execution.signal.throwIfAborted();
      if (permissionPolicyRevision(getPolicy()) !== revision) throw new Error("Member verification permissions changed");
      const result = await executeNative(command, signal ?? execution.signal, timeoutMs, onOutput);
      await options.sessionStore.appendTimeline(session.id, { kind: "output", text: sanitizeExecOutput(`Verification command: ${command}\nExit: ${result.exitCode}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`, 128 * 1024) });
      return result;
    };

    const io = createProductionWorkflowAgentIO({ workspacePath, policy: getPolicy, workflow, execute: executeNative, executeVerification: execute,
      session: { getId: () => session.id },
      interaction: {
        confirm: (_kind, tool, prompt) => confirmMember(() => tool === "patch" ? options.io.confirmPatch?.(label + prompt, execution.signal) ?? Promise.resolve(false) : tool === "web" ? options.io.confirmWeb?.(label + prompt, execution.signal) ?? Promise.resolve(false) : options.io.confirmBash(label + prompt, execution.signal)),
        requestUserInput: async () => { interaction = { kind: "question", tool: "request_user_input", prompt: label + "Member needs clarification; ask the root Agent to resolve it." }; return {}; },
        takeInteractionRequired: () => interaction ?? options.io.takeInteractionRequired?.(),
      },
      output: { assistant: async (text) => { summary = text; await options.sessionStore.appendTimeline(session.id, { kind: "assistant", text }); } },
    });
    try {
      memberHandle = createProductionAgent({ model, workspacePath, io, sessionStore: options.sessionStore, sessionId: () => session.id, mcp: null, learnedMemoryStore: null, codeNavigation: null, requestAttemptLedger: execution.ledger,
        restore: {
          onHistoryAppend: (items) => options.sessionStore.appendContext(session.id, items),
          onContextCompacted: (items, automatic, usage) => options.sessionStore.compactContext(session.id, items, automatic, usage),
          onContextPruned: (items, metadata) => options.sessionStore.pruneContext(session.id, items, metadata),
          onUsage: async (usage) => { await options.sessionStore.appendUsage(session.id, usage); await execution.onUsage(usage); },
          onToolEvent: async (event) => { team?.observeTool(execution.member.agentId, event); },
        },
      });
      execution.attachSteering((message) => memberHandle!.agent.requestSteering(message));
      const runner = new CodingTaskRunner({ agent: memberHandle.agent, workflow, host: { executeVerification: execute, getGoal: async () => undefined, addGoalTime: async () => undefined } });
      const result = await runner.run({ text: execution.input, mode: worker ? "default" : "plan", signal: execution.signal });
      if (result.agentResult.interactionRequired) interaction = result.agentResult.interactionRequired;
      if (result.agentResult.stopReason) throw new Error(`Member stopped: ${result.agentResult.stopReason}`);
      return { summary, ...(worker ? { verification: `${result.workflowResult?.state.result ?? "unverified"}; ${result.workflowResult?.verificationSuite?.results.map((check) => `${check.command.label}: ${check.passed ? "passed" : "failed"}`).join(", ") ?? "no final checks"}; evidence in member Session outputs` } : {}), ...(interaction ? { interaction } : {}) };
    } catch (error) { if (error instanceof MemberInteractionStop && interaction) return { summary: "Member verification needs host interaction.", verification: "unverified", interaction }; throw error; } finally { await memberHandle?.dispose(); }
  };
  if (options.team?.enabled !== false && options.team) {
    const suppliedBudget = options.requestAttemptLedger?.snapshot().tokenBudget;
    team = new TeamRuntime({ config: { ...options.team, ...(suppliedBudget === undefined ? {} : { tokenBudget: Math.min(suppliedBudget, options.team.tokenBudget ?? suppliedBudget) }) }, model: options.model, models: options.teamModels ?? [options.model], workspacePath: options.workspacePath, sessionId: options.sessionId, io: rootIO, ...(options.teamStore ? { store: options.teamStore } : {}), executeMember,
      readEvidence: async (member) => { if (!member.sessionId) return []; const saved = await options.sessionStore.load(member.sessionId); if (saved.summary.workspace_path !== (member.sessionWorkspacePath ?? member.workspacePath ?? options.workspacePath)) throw new Error("Member evidence workspace does not match ownership"); return saved.timeline.filter((entry) => entry.kind === "output").slice(-8).map((entry) => ({ sessionId: member.sessionId, text: sanitizeExecOutput("text" in entry ? entry.text : "", 2048) })); },
      ...(options.onTeamEvent ? { onEvent: options.onTeamEvent } : {}),
      persistReference: async (snapshot) => { const id = options.sessionId(); if (id) await options.sessionStore.setTeam(id, { teamId: snapshot.teamId, state: snapshot.state, members: snapshot.members.map(({ agentId, taskId, sessionId, state }) => ({ agentId, taskId, ...(sessionId ? { sessionId } : {}), state })) }); },
      onMemberUsage: async (usage) => { if (restore?.onMemberUsage) await restore.onMemberUsage(usage); else { const id = options.sessionId(); if (id) await options.sessionStore.appendUsage(id, usage, { preserveContext: true }); } await team?.recordGoalUsage(usage); },
    });
  }
  const agent = new ReactAgent({
    workspacePath: options.workspacePath,
    client,
    model: options.model.model_name,
    ...(options.loopStrategy === undefined ? {} : { loopStrategy: options.loopStrategy }),
    io: team ? { ...rootIO, takeInteractionRequired: () => team?.takeInteraction() ?? options.io.takeInteractionRequired?.() } : options.io,
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
    ...(team ? { team, requestAttemptLedger: team.accounting } : options.requestAttemptLedger ? { requestAttemptLedger: options.requestAttemptLedger } : {}),
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
    ...(provider.capabilities.promptCacheOptions && isOfficialOpenAiBaseUrl(options.model.base_url)
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
    ...(team ? { onUsage: async (usage: import("../status/model-status.js").TokenUsageSample | null) => { await restore?.onUsage?.(usage); await team?.recordGoalUsage(usage); } } : restore?.onUsage === undefined ? {} : { onUsage: restore.onUsage }),
    ...(restore?.onPhase === undefined ? {} : { onPhase: restore.onPhase }),
    ...(restore?.onEvent === undefined ? {} : { onEvent: restore.onEvent }),
    ...(team ? { onToolEvent: async (event: import("../agent/agent-loop.js").LoopEvent) => { team?.observeTool("root", event); if (event.type === "tool_started" || event.type === "tool_finished") await restore?.onToolEvent?.(event); } } : restore?.onToolEvent === undefined ? {} : { onToolEvent: restore.onToolEvent }),
  });

  const disposeAgent = agent.dispose.bind(agent);
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => disposal ??= (async () => {
    const failures: unknown[] = [];
    for (const cleanup of [
      () => team?.cancel(new Error("Production runtime disposed")),
      () => disposeAgent(),
      () => ownsLearnedMemory ? learnedMemory?.dispose?.() : undefined,
      () => ownedMcp?.close(),
      () => options.providerRuntime === undefined ? provider.dispose?.() : undefined,
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Failed to dispose production services");
  })();
  // Existing hosts own an AgentSession rather than the richer handle. Keep
  // that interface safe: disposing the agent also releases services created
  // by this factory.
  agent.dispose = dispose;
  return {
    agent,
    ...(team ? { team } : {}),
    ...(learnedMemory ? { learnedMemory } : {}),
    ...(skills ? { skills } : {}),
    readableRoots: () => skillReadableRoots(skills),
    provider,
    async prepareMcp(signal) {
      const pending = (await mcp?.ensureReady(signal))?.servers.find((server) => server.state === "trust_required");
      return pending ? { kind: "approval", tool: pending.trustKind ?? (pending.transport === "stdio" ? "mcp_start" : "mcp_http"), prompt: "MCP startup requires approval. Use /mcp trust <server> in this workspace." } : undefined;
    },
    dispose,
  };
}

export interface ProductionCommandExecutorOptions {
  workspacePath: string;
  policy: PermissionPolicy | (() => PermissionPolicy);
  readableRoots?: readonly string[] | (() => readonly string[]);
  isolation?: { deniedRoots: readonly string[]; writableRoot: string; traversalRoots?: readonly string[] };
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
    return runBash(options.isolation ? isolatedCommand(command, options.workspacePath) : command, {
      cwd: options.workspacePath,
      streamOutput: false,
      timeoutMs: timeoutMs ?? DEFAULT_MODEL_BASH_TIMEOUT_MS,
      sandbox: { policy: createEffectiveSandboxPolicy(policy, options.workspacePath, readableRoots, options.isolation ? { isolation: options.isolation } : {}) },
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
  confirm?(kind: "approval", tool: ConfirmationTool, prompt: string, signal?: AbortSignal): Promise<boolean>;
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
  const confirm = (tool: ConfirmationTool, prompt: string, signal?: AbortSignal) =>
    options.interaction?.confirm?.("approval", tool, prompt, signal) ?? Promise.resolve(false);
  const session = options.session;
  const interaction = options.interaction;
  const output = options.output;
  return {
    ...(session?.getId ? { getSessionId: session.getId } : {}),
    getPermissions: () => ({ ...options.policy() }),
    isToolExecutionBlocked: () => workflowFrom(options).state.phase === "blocked",
    getWorkflowContext: () => projectWorkflowContext(workflowFrom(options).state),
    confirmBash: (command, signal) => confirm("bash", command, signal),
    confirmPatch: (summary, signal) => confirm("patch", summary, signal),
    confirmWeb: (request, signal) => confirm("web", request, signal),
    confirmMcp: (request, signal) => confirm("mcp", request, signal),
    confirmGoal: (request, signal) => confirm("goal", request, signal),
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
      workflow.assertCleanupComplete();
      if (workflow.state.phase === "blocked") {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: "The coding workflow reached its repair limit" };
      }
      let cleanupFailed = false;
      try {
        const result = await options.execute(command, signal);
        if (result.cleanupFailed) throw new ProcessCleanupError(result.error ?? "Foreground process ownership is unresolved");
        return result;
      } catch (error) {
        cleanupFailed = error instanceof ProcessCleanupError;
        if (error instanceof ProcessCleanupError) {
          try { await workflow.recordCleanupFailure(error); }
          catch (persistenceError) {
            throw new ProcessCleanupError(new AggregateError([error, persistenceError], `${error.message}; cleanup debt could not be persisted`));
          }
        }
        throw error;
      } finally {
        if (!cleanupFailed) await workflow.observeShellExecution();
      }
    },
    async runBackgroundBash(command, signal, timeoutMs, onOutput) {
      const workflow = workflowFrom(options);
      workflow.assertCleanupComplete();
      if (workflow.state.phase === "blocked") {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: "The coding workflow reached its repair limit" };
      }
      let cleanupFailed = false;
      try {
        const result = await (options.executeBackground ?? options.execute)(command, signal, timeoutMs, onOutput);
        if (result.cleanupFailed) throw new ProcessCleanupError(result.error ?? "Background process ownership is unresolved");
        return result;
      } catch (error) {
        cleanupFailed = error instanceof ProcessCleanupError;
        if (error instanceof ProcessCleanupError) {
          try { await workflow.recordCleanupFailure(error); }
          catch (persistenceError) {
            throw new ProcessCleanupError(new AggregateError([error, persistenceError], `${error.message}; cleanup debt could not be persisted`));
          }
        }
        throw error;
      } finally {
        if (!cleanupFailed) await workflow.observeShellExecution();
      }
    },
    writeAssistant: (text) => output?.assistant?.(text),
    ...(output?.assistantDelta ? { writeAssistantDelta: output.assistantDelta } : {}),
    ...(output?.tool ? { writeTool: output.tool } : {}),
    ...(output?.toolProgress ? { onToolProgress: output.toolProgress } : {}),
  };
}
