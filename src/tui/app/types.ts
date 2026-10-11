import type { TeamOptions, TeamSnapshot } from "../../team/types.js";
import type { AgentIO } from "../../agent/react-agent.js";
import type { LoopEvent, LoopPhase } from "../../agent/agent-loop.js";
import type { CommandRecord } from "../../tools/command-record.js";
import type { InputHistoryStore } from "../../storage/input-history.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
  StoredModelRegistration,
} from "../../storage/model-registry.js";
import type { ContextPruneMetadata, SessionStoreLike } from "../../storage/session-store.js";
import type { BashOutputPreview, BashResult } from "../../tools/bash.js";
import type { PermissionPolicy } from "../../permissions/policy.js";
import type { SkillManagerLike } from "../../skills/manager.js";
import type {
  LearnedMemoryPolicy,
  LearnedMemoryStatus,
  LearnedScope,
  LearnedTurnOutcome,
  MemorySnapshot,
} from "../../memory/learned-memory.js";
import type {
  StatusSnapshot,
  TokenUsageSample,
} from "../../status/model-status.js";
import type { AgentTaskOptions, AgentTurnOptions, AgentTurnResult } from "../../agent/react-agent.js";
import type { ModelRequestSettings, ResponsesProfile } from "../../providers/capabilities.js";
import type { BackgroundJobSnapshot } from "../../tools/background-jobs.js";
import type { FileAttachment } from "../../agent/file-attachments.js";
import type { ContextInspectionSnapshot } from "../../agent/context-inspection.js";
import type { TaskProgress } from "../../workflow/task-progress.js";

export interface AgentSession {
  getTeamSnapshot?(): TeamSnapshot | undefined;
  prepareTeamVerification?: ((signal?: AbortSignal) => Promise<string | undefined>) | undefined;
  finishTeamVerification?: ((verified: boolean) => Promise<void>) | undefined;
  runTurn(userInput: string, signal?: AbortSignal, options?: AgentTurnOptions): Promise<AgentTurnResult>;
  compact?(signal?: AbortSignal): Promise<{ items: Array<Record<string, unknown>>; usage: TokenUsageSample | null }>;
  requestSteering?(text: string, attachments?: readonly FileAttachment[]): boolean;
  setMemoryPolicy?(policy: Partial<LearnedMemoryPolicy>): void;
  getMemoryPolicy?(): LearnedMemoryPolicy | undefined;
  getMemorySnapshot?(): MemorySnapshot | undefined;
  getContextSnapshot?(): ContextInspectionSnapshot | undefined;
  finishMemoryTurn?(outcome: LearnedTurnOutcome): Promise<void>;
  finalizePendingGoalCompletion?(allow: boolean): Promise<void>;
  setRequestSettings?(settings: ModelRequestSettings): void;
  getRequestSettings?(): ModelRequestSettings;
  waitForBackgroundJobs?(signal?: AbortSignal): Promise<BackgroundJobSnapshot[]>;
  beginTask?(options: AgentTaskOptions): void | Promise<void>;
  endTask?(): void | Promise<void>;
  cancelBackgroundJobs?(reason?: unknown): Promise<BackgroundJobSnapshot[]>;
  dispose?(): void | Promise<void>;
}

export interface AgentRestoreOptions {
  team?: TeamOptions;
  initialContext?: readonly Record<string, unknown>[];
  onContextAppend?(items: readonly Record<string, unknown>[]): Promise<void>;
  onContextCompacted?(items: readonly Record<string, unknown>[], automatic: boolean, usage: TokenUsageSample | null): Promise<void>;
  onContextPruned?(items: readonly Record<string, unknown>[], metadata: ContextPruneMetadata): Promise<void>;
  contextWindow?: number | null;
  initialContextTokens?: number | null;
  initialTaskProgress?: TaskProgress;
  onUsage?(usage: TokenUsageSample | null): Promise<void>;
  onMemberUsage?(usage: TokenUsageSample | null): Promise<void>;
  onPhase?(phase: LoopPhase): void;
  onEvent?(event: LoopEvent): void;
}

export interface TuiModelRegistry {
  resolveAll(): Promise<ResolvedModels>;
  listStatuses(): Promise<RegisteredModelStatus[]>;
  registerMany(
    baseUrl: string,
    modelNames: readonly string[],
    apiKey: string,
  ): Promise<StoredModelRegistration[]>;
  removeMany(ids: readonly string[]): Promise<StoredModelRegistration[]>;
  setResponsesProfile?(model: Pick<StoredModelRegistration, "id" | "base_url" | "model_name">, profile: ResponsesProfile): Promise<StoredModelRegistration>;
}

export interface TuiDependencies {
  inputHistory?: InputHistoryStore;
  registry: TuiModelRegistry;
  version: string;
  workspacePath: string;
  sessionStore: SessionStoreLike;
  getAuxiliaryUsage?(): import("../../status/model-status.js").SessionUsage;
  listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]>;
  createAgent(
    model: RegisteredModel,
    io: AgentIO,
    restore?: AgentRestoreOptions,
  ): AgentSession;
  getMemoryStatus?(workspacePath: string): Promise<LearnedMemoryStatus>;
  getMemoryPrompt?(workspacePath: string): Promise<string>;
  setMemoryEnabled?(enabled: boolean): Promise<void>;
  clearMemory?(scope: LearnedScope, workspacePath: string): Promise<void>;
  archiveMemory?(scope: LearnedScope, workspacePath: string, id: string): Promise<void>;
  deleteMemoryEntry?(scope: LearnedScope, workspacePath: string, id: string): Promise<void>;
  rememberMemory?(
    model: RegisteredModel,
    workspacePath: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void>;
  generateSessionTitle(
    model: RegisteredModel,
    firstQuestion: string,
    signal?: AbortSignal,
  ): Promise<string>;
  doctor?(
    model: RegisteredModel | undefined,
    policy: PermissionPolicy,
    live: boolean,
    signal?: AbortSignal,
  ): Promise<string>;
  changeWorkspace(workspacePath: string): Promise<string>;
  loadPermissions?(workspacePath: string): Promise<PermissionPolicy>;
  savePermissions?(workspacePath: string, policy: PermissionPolicy, scope?: "user" | "project"): Promise<void>;
  runBash(
    command: string,
    policy: PermissionPolicy,
    signal?: AbortSignal,
    onOutput?: (output: BashOutputPreview) => void,
    timeoutMs?: number,
  ): Promise<BashResult>;
  getTeamConfig?(): Promise<TeamOptions>;
  configureTeam?(config: TeamOptions): Promise<void>;
  getTeamSnapshot?(): TeamSnapshot | undefined;
  inspectTeam?(sessionId: string, teamId?: string): Promise<TeamSnapshot | undefined>;
  manageTeam?(action: "cancel" | "cleanup", id: string, sessionId?: string, teamId?: string): Promise<void>;
  reconnectMcp?(): Promise<void>;
  getMcpStatus?(): Promise<string>;
  previewMcpTrust?(name: string, signal?: AbortSignal): Promise<import("../../mcp/trust.js").McpTrustPreview>;
  approveMcpTrust?(preview: import("../../mcp/trust.js").McpTrustPreview, signal?: AbortSignal): Promise<void>;
  revokeMcpTrust?(name: string): Promise<void>;
  getSkillsStatus?(): Promise<string>;
  skillManager?: SkillManagerLike;
  generateSkillDraft?(model: RegisteredModel, description: string, signal?: AbortSignal): Promise<string>;
  reviseSkillDraft?(model: RegisteredModel, skillMarkdown: string, signal?: AbortSignal): Promise<string>;
  runTerminalCommand(
    command: string,
    onOutput?: (output: string) => void,
    signal?: AbortSignal,
    onInputReady?: (write: ((input: string) => void) | undefined) => void,
  ): Promise<BashResult>;
  /** Release workspace-scoped services after Ink has fully exited. */
  dispose?(): Promise<void>;
}

export type HistoryKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "output"
  | "error";

export interface HistoryEntry {
  command?: CommandRecord;
  id: number;
  kind: HistoryKind;
  text: string;
}

export interface BannerEntry {
  id: number;
  kind: "banner";
  modelName?: string;
}

export interface StatusEntry {
  id: number;
  kind: "status";
  snapshot: StatusSnapshot;
}

export type TimelineEntry = BannerEntry | HistoryEntry | StatusEntry;
