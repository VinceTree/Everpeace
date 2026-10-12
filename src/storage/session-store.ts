import { createHash, randomUUID } from "node:crypto";
import { isCostEstimate, type CostEstimate } from "../status/cost.js";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { PerformanceTrace } from "../performance/trace.js";
import { SessionActivity } from "./session-activity.js";
import { isTaskPerformanceReport, type TaskPerformanceReport } from "../performance/task-report.js";
import { isVerificationEvidence } from "../workflow/verification-evidence.js";
import { isCommandRecord, type CommandRecord } from "../tools/command-record.js";
import {
  applyUsageSample,
  applyCompactionUsage,
  createEmptySessionUsage,
  isStatusSnapshot,
  isTokenUsageSample,
  resetContextUsage,
  type SessionUsage,
  type StatusSnapshot,
  type TokenUsageSample,
} from "../status/model-status.js";
import { createWorkflowState, type VerificationSuiteResult, type WorkflowPhase, type WorkflowState, type VerificationResult } from "../workflow/types.js";
import type { LearnedMemoryPolicy } from "../memory/learned-memory.js";
import { isModelRequestSettings, isResponsesProfile, type ResponsesProfile, type ModelRequestSettings } from "../providers/capabilities.js";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";
import { cloneTaskProgress, isTaskProgress, type TaskProgress } from "../workflow/task-progress.js";
import { RETAINED_TOOL_OUTPUTS, type PreparedOutputAttachment, type ReadToolOutputArguments, type StoredToolOutputRange } from "../agent/context-limits.js";
import {
  SessionOutputStorage,
  isToolOutputAttachmentReference,
  readToolOutputReferences,
  toolOutputAttachmentReference,
  type StoredToolOutput,
  type ToolOutputAttachmentReference,
} from "./session-outputs.js";

export type { StoredToolOutput } from "./session-outputs.js";

export interface SessionOutputReadOptions {
  signal?: AbortSignal;
  /** Absolute Date.now() deadline, supplied by the caller's bounded history scan. */
  deadline?: number;
}

function checkOutputReadBudget(options?: SessionOutputReadOptions): void {
  options?.signal?.throwIfAborted();
  if (options?.deadline !== undefined && Date.now() >= options.deadline) {
    const error = new Error("Historical output read deadline exceeded");
    error.name = "TimeoutError";
    throw error;
  }
}

function withinOutputReadBudget<T>(pending: Promise<T>, options?: SessionOutputReadOptions): Promise<T> {
  if (!options) return pending;
  try { checkOutputReadBudget(options); } catch (error) { return Promise.reject(error); }
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
    };
    const aborted = () => { cleanup(); reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")); };
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.deadline !== undefined) timer = setTimeout(() => {
      cleanup();
      const error = new Error("Historical output read deadline exceeded");
      error.name = "TimeoutError";
      reject(error);
    }, Math.max(0, options.deadline - Date.now()));
    pending.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

const SESSION_FORMAT_VERSION = 1;

export type SessionTimelineKind =
  | "user"
  | "assistant"
  | "system"
  | "tool"
  | "output"
  | "error";

export interface SessionModelRef {
  id: string;
  model_name: string;
  base_url: string;
  request_settings?: ModelRequestSettings;
  responses_profile?: ResponsesProfile;
}

export type GoalStatus = "active" | "paused" | "blocked" | "complete" | "budget_limited" | "usage_limited";

export interface SessionGoal {
  goal_id: string;
  objective: string;
  status: GoalStatus;
  token_budget: number | null;
  tokens_used: number;
  usage_complete: boolean;
  time_used_seconds: number;
  /** Consecutive goal turns that reported the same blocker. */
  blocked_streak?: number;
  created_at: string;
  updated_at: string;
}

export interface StoredTextTimelineEntry {
  command?: CommandRecord;
  kind: SessionTimelineKind;
  text: string;
}

export interface StoredStatusTimelineEntry {
  kind: "status";
  snapshot: StatusSnapshot;
}

export type StoredTimelineEntry =
  | StoredTextTimelineEntry
  | StoredStatusTimelineEntry;

export interface SessionTeamReference { teamId: string; state: string; members: Array<{ agentId: string; taskId: string; sessionId?: string; state: string }>; }

export interface SessionSummary {
  team?: SessionTeamReference;
  id: string;
  title: string;
  title_pending: boolean;
  created_at: string;
  updated_at: string;
  workspace_path: string;
  model: SessionModelRef;
  goal?: SessionGoal;
  workflow?: WorkflowState;
  task_progress?: TaskProgress;
  memory_policy?: LearnedMemoryPolicy;
  lineage?: SessionLineage;
  fork_pending_resume?: boolean;
}

export interface SessionLineage {
  parent_session_id: string;
  forked_at: string;
  source_boundary_bytes: number;
  source_header_sha256: string;
}

export interface LoadedSession {
  performanceReport?: TaskPerformanceReport;
  costs?: import("../status/cost.js").CostEstimate[];
  summary: SessionSummary;
  timeline: StoredTimelineEntry[];
  context: Array<Record<string, unknown>>;
  usage: SessionUsage;
  goal?: SessionGoal;
  workflow?: WorkflowState;
  taskProgress?: TaskProgress;
  memoryPolicy?: LearnedMemoryPolicy;
  lineage?: SessionLineage;
  forkPendingResume?: boolean;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  skipped: number;
}

export interface SessionSearchMatch {
  summary: SessionSummary;
  match?: {
    kind: "title" | "user" | "assistant";
    snippet: string;
    timelineIndex?: number;
  };
  preview?: Array<{ kind: "user" | "assistant"; snippet: string }>;
}

export interface SessionSearchResult {
  matches: SessionSearchMatch[];
  total: number;
  skipped: number;
}

export interface SessionSearchOptions {
  query: string;
  workspacePath?: string;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface CreateSessionInput {
  title: string;
  titlePending: boolean;
  workspacePath: string;
  model: SessionModelRef;
}

export interface ForkSessionInput {
  title?: string;
  signal?: AbortSignal;
}

export interface SessionStoreLike {
  create(input: CreateSessionInput): Promise<SessionSummary>;
  updateTitle(sessionId: string, title: string): Promise<void>;
  appendTimeline(sessionId: string, entry: StoredTimelineEntry): Promise<void>;
  appendContext(
    sessionId: string,
    items: readonly Record<string, unknown>[],
  ): Promise<void>;
  commitToolResult?(sessionId: string, item: Record<string, unknown>, attachment?: PreparedOutputAttachment): Promise<void>;
  captureSessionBoundary?(sessionId: string): Promise<number>;
  readToolOutput?(sessionId: string, outputId: string): Promise<StoredToolOutput | null>;
  readReferencedToolOutput?(sessionId: string, reference: ToolOutputAttachmentReference, options?: SessionOutputReadOptions): Promise<StoredToolOutput | null>;
  readReferencedToolOutputPage?(sessionId: string, reference: ToolOutputAttachmentReference, arguments_: ReadToolOutputArguments, options?: SessionOutputReadOptions): Promise<StoredToolOutputRange | null>;
  compactContext(
    sessionId: string,
    items: readonly Record<string, unknown>[],
    automatic: boolean,
    usage: TokenUsageSample | null,
  ): Promise<void>;
  pruneContext?(
    sessionId: string,
    items: readonly Record<string, unknown>[],
    metadata: ContextPruneMetadata,
  ): Promise<void>;
  appendUsage(
    sessionId: string,
    usage: TokenUsageSample | null,
    options?: { preserveContext?: boolean },
  ): Promise<void>;
  selectModel(
    sessionId: string,
    model: SessionModelRef,
    preserveContext: boolean,
  ): Promise<void>;
  list(): Promise<SessionListResult>;
  search?(options: SessionSearchOptions): Promise<SessionSearchResult>;
  deleteMany(sessionIds: readonly string[]): Promise<void>;
  load(sessionId: string): Promise<LoadedSession>;
  setGoal(sessionId: string, goal: SessionGoal): Promise<void>;
  updateGoal(sessionId: string, patch: Partial<Pick<SessionGoal, "status" | "tokens_used" | "usage_complete" | "time_used_seconds" | "blocked_streak" | "updated_at">>): Promise<void>;
  setTeam?(sessionId: string, team: SessionTeamReference): Promise<void>;
  setWorkflow?(sessionId: string, workflow: WorkflowState): Promise<void>;
  setTaskProgress?(sessionId: string, progress: TaskProgress): Promise<void>;
  setMemoryPolicy?(sessionId: string, policy: LearnedMemoryPolicy): Promise<void>;
  fork?(sessionId: string, input?: ForkSessionInput): Promise<SessionSummary>;
  setForkPendingResume?(sessionId: string, pending: boolean): Promise<void>;
}

interface EventBase {
  version: typeof SESSION_FORMAT_VERSION;
  at: string;
}

interface SessionCreatedEvent extends EventBase {
  type: "session_created";
  session_id: string;
  title: string;
  title_pending: boolean;
  workspace_path: string;
  model: SessionModelRef;
  usage_tracking: boolean;
  lineage?: SessionLineage;
}

interface TitleUpdatedEvent extends EventBase {
  type: "title_updated";
  title: string;
}

interface TimelineEntryEvent extends EventBase {
  type: "timeline_entry";
  entry: StoredTimelineEntry;
}

interface ContextAppendEvent extends EventBase {
  type: "context_append";
  items: Array<Record<string, unknown>>;
  tool_output_attachment?: ToolOutputAttachmentReference;
}

interface ContextCompactedEvent extends EventBase {
  type: "context_compacted";
  items: Array<Record<string, unknown>>;
  automatic: boolean;
  usage: TokenUsageSample | null;
}

export interface ContextPruneMetadata {
  original_bytes: number;
  pruned_bytes: number;
  pruned_results: number;
}

interface ContextPrunedEvent extends EventBase, ContextPruneMetadata {
  type: "context_pruned";
  items: Array<Record<string, unknown>>;
}

interface ModelSelectedEvent extends EventBase {
  type: "model_selected";
  model: SessionModelRef;
  preserve_context: boolean;
}

interface UsageRecordedEvent extends EventBase {
  type: "usage_recorded";
  preserve_context?: boolean;
  usage: TokenUsageSample | null;
}

interface GoalUpdatedEvent extends EventBase {
  type: "goal_updated";
  goal: SessionGoal;
}

interface WorkflowUpdatedEvent extends EventBase {
  type: "workflow_updated";
  workflow: WorkflowState;
}

interface TaskProgressUpdatedEvent extends EventBase {
  type: "task_progress_updated";
  progress: TaskProgress;
}

interface MemoryPolicyUpdatedEvent extends EventBase {
  type: "memory_policy_updated";
  policy: LearnedMemoryPolicy;
}

interface ForkBoundaryEvent extends EventBase {
  type: "fork_boundary";
  lineage: SessionLineage;
  workflow?: WorkflowState;
  task_progress?: TaskProgress;
  memory_policy?: LearnedMemoryPolicy;
}

interface ForkResumeUpdatedEvent extends EventBase {
  type: "fork_resume_updated";
  pending: boolean;
}

interface TeamUpdatedEvent extends EventBase { type: "team_updated"; team: SessionTeamReference; }

type SessionEvent =
  | (EventBase & { type: "cost_estimated"; estimate: import("../status/cost.js").CostEstimate })
  | (EventBase & { type: "performance_report"; report: TaskPerformanceReport })
  | TeamUpdatedEvent
  | SessionCreatedEvent
  | TitleUpdatedEvent
  | TimelineEntryEvent
  | ContextAppendEvent
  | ContextCompactedEvent
  | ContextPrunedEvent
  | ModelSelectedEvent
  | UsageRecordedEvent
  | GoalUpdatedEvent
  | WorkflowUpdatedEvent
  | TaskProgressUpdatedEvent
  | MemoryPolicyUpdatedEvent
  | ForkBoundaryEvent
  | ForkResumeUpdatedEvent;

export interface SessionStoreOptions {
  directory?: string;
  now?: () => Date;
  createId?: () => string;
  trace?: PerformanceTrace;
}

export function defaultSessionDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  if (platform === "win32") {
    const root = env.APPDATA?.trim() || path.win32.join(homeDirectory, "AppData", "Roaming");
    return path.win32.join(root, "Everpeace", "sessions");
  }

  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Everpeace", "sessions");
  }

  const root = env.XDG_STATE_HOME?.trim() || path.join(homeDirectory, ".local", "state");
  return path.join(root, "everpeace", "sessions");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isModelRef(value: unknown): value is SessionModelRef {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.model_name) &&
    isNonEmptyString(value.base_url)
    && (value.request_settings === undefined || isModelRequestSettings(value.request_settings))
    && (value.responses_profile === undefined || isResponsesProfile(value.responses_profile))
  );
}

function isSessionLineage(value: unknown): value is SessionLineage {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.parent_session_id)
    && /^[A-Za-z0-9_-]+$/u.test(value.parent_session_id)
    && isNonEmptyString(value.forked_at)
    && typeof value.source_boundary_bytes === "number"
    && Number.isSafeInteger(value.source_boundary_bytes)
    && value.source_boundary_bytes > 0
    && typeof value.source_header_sha256 === "string"
    && /^[0-9a-f]{64}$/u.test(value.source_header_sha256);
}

function cloneLineage(lineage: SessionLineage): SessionLineage {
  return { ...lineage };
}

function isTimelineKind(value: unknown): value is SessionTimelineKind {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "tool" ||
    value === "output" ||
    value === "error"
  );
}

function isTimelineEntry(value: unknown): value is StoredTimelineEntry {
  if (isRecord(value) && value.kind === "status") {
    return isStatusSnapshot(value.snapshot);
  }
  return (
    isRecord(value) &&
    isTimelineKind(value.kind) &&
    (value.command === undefined || (value.kind === "output" && isCommandRecord(value.command))) &&
    typeof value.text === "string"
  );
}

function parseEvent(value: unknown): SessionEvent {
  if (
    !isRecord(value) ||
    value.version !== SESSION_FORMAT_VERSION ||
    !isNonEmptyString(value.at) ||
    !isNonEmptyString(value.type)
  ) {
    throw new Error("Session event has an invalid or unsupported format");
  }

  const base = { version: SESSION_FORMAT_VERSION, at: value.at } as const;
  if (value.type === "performance_report") {
    if (!isTaskPerformanceReport(value.report)) throw new Error("Session performance report is invalid");
    return { ...base, type: "performance_report", report: structuredClone(value.report) };
  }
  if (value.type === "cost_estimated") {
    if (!isCostEstimate(value.estimate)) throw new Error("Session cost estimate is invalid");
    return { ...base, type: "cost_estimated", estimate: structuredClone(value.estimate) };
  }
  if (value.type === "session_created") {
    if (
      !isNonEmptyString(value.session_id) ||
      !isNonEmptyString(value.title) ||
      !isNonEmptyString(value.workspace_path) ||
      !isModelRef(value.model)
    ) {
      throw new Error("Session header is invalid");
    }
    if (value.lineage !== undefined && !isSessionLineage(value.lineage)) {
      throw new Error("Session lineage is invalid");
    }
    return {
      ...base,
      type: "session_created",
      session_id: value.session_id,
      title: value.title,
      title_pending:
        typeof value.title_pending === "boolean" ? value.title_pending : false,
      workspace_path: value.workspace_path,
      model: value.model,
      usage_tracking:
        typeof value.usage_tracking === "boolean" ? value.usage_tracking : false,
      ...(value.lineage === undefined ? {} : { lineage: cloneLineage(value.lineage) }),
    };
  }

  if (value.type === "title_updated") {
    if (!isNonEmptyString(value.title)) throw new Error("Session title is invalid");
    return { ...base, type: "title_updated", title: value.title };
  }

  if (value.type === "timeline_entry") {
    if (!isTimelineEntry(value.entry)) throw new Error("Timeline entry is invalid");
    return { ...base, type: "timeline_entry", entry: value.entry };
  }

  if (value.type === "context_append") {
    if (!Array.isArray(value.items) || !value.items.every(isRecord)) {
      throw new Error("Session context is invalid");
    }
    if (value.tool_output_attachment !== undefined && !isToolOutputAttachmentReference(value.tool_output_attachment)) {
      throw new Error("Session tool output attachment is invalid");
    }
    return {
      ...base, type: "context_append", items: value.items,
      ...(value.tool_output_attachment === undefined ? {} : { tool_output_attachment: value.tool_output_attachment }),
    };
  }

  if (value.type === "context_compacted") {
    if (
      !Array.isArray(value.items) ||
      !value.items.every(isRecord) ||
      typeof value.automatic !== "boolean" ||
      (value.usage !== null && !isTokenUsageSample(value.usage))
    ) {
      throw new Error("Session compaction event is invalid");
    }
    return {
      ...base,
      type: "context_compacted",
      items: value.items,
      automatic: value.automatic,
      usage: value.usage,
    };
  }

  if (value.type === "context_pruned") {
    if (
      !Array.isArray(value.items) ||
      !value.items.every(isRecord) ||
      !Number.isSafeInteger(value.original_bytes) ||
      Number(value.original_bytes) < 0 ||
      !Number.isSafeInteger(value.pruned_bytes) ||
      Number(value.pruned_bytes) < 0 ||
      Number(value.pruned_bytes) >= Number(value.original_bytes) ||
      !Number.isSafeInteger(value.pruned_results) ||
      Number(value.pruned_results) < 1
    ) {
      throw new Error("Session context pruning event is invalid");
    }
    return {
      ...base,
      type: "context_pruned",
      items: value.items,
      original_bytes: Number(value.original_bytes),
      pruned_bytes: Number(value.pruned_bytes),
      pruned_results: Number(value.pruned_results),
    };
  }

  if (value.type === "model_selected") {
    if (!isModelRef(value.model) || typeof value.preserve_context !== "boolean") {
      throw new Error("Session model event is invalid");
    }
    return {
      ...base,
      type: "model_selected",
      model: value.model,
      preserve_context: value.preserve_context,
    };
  }


  if (value.type === "usage_recorded") {
    if (value.usage !== null && !isTokenUsageSample(value.usage)) {
      throw new Error("Session usage event is invalid");
    }
    if (value.preserve_context !== undefined && typeof value.preserve_context !== "boolean") throw new Error("Invalid usage context scope");
    return { ...base, type: "usage_recorded", usage: value.usage, ...(value.preserve_context === true ? { preserve_context: true } : {}) };
  }

  if (value.type === "goal_updated") {
    if (!isGoal(value.goal)) throw new Error("Session goal is invalid");
    return { ...base, type: "goal_updated", goal: value.goal };
  }

  if (value.type === "team_updated") {
    if (!isRecord(value.team) || typeof value.team.teamId !== "string" || typeof value.team.state !== "string" || !Array.isArray(value.team.members) || value.team.members.length > 32 || value.team.members.some((member) => !isRecord(member) || typeof member.agentId !== "string" || typeof member.taskId !== "string" || typeof member.state !== "string" || member.sessionId !== undefined && typeof member.sessionId !== "string")) throw new Error("Invalid team reference");
    return { ...base, type: "team_updated", team: value.team as unknown as SessionTeamReference };
  }
  if (value.type === "workflow_updated") {
    if (!isWorkflow(value.workflow)) throw new Error("Session workflow is invalid");
    return {
      ...base,
      type: "workflow_updated",
      workflow: {
        ...value.workflow,
        changed_paths: [...value.workflow.changed_paths],
      },
    };
  }

  if (value.type === "task_progress_updated") {
    if (!isTaskProgress(value.progress)) throw new Error("Session task progress is invalid");
    return { ...base, type: "task_progress_updated", progress: cloneTaskProgress(value.progress) };
  }

  if (value.type === "memory_policy_updated") {
    if (!isRecord(value.policy) || typeof value.policy.readExisting !== "boolean" || typeof value.policy.captureFuture !== "boolean") {
      throw new Error("Session memory policy is invalid");
    }
    return { ...base, type: "memory_policy_updated", policy: { readExisting: value.policy.readExisting, captureFuture: value.policy.captureFuture } };
  }

  if (value.type === "fork_boundary") {
    if (!isSessionLineage(value.lineage)
      || (value.workflow !== undefined && !isWorkflow(value.workflow))
      || (value.task_progress !== undefined && !isTaskProgress(value.task_progress))
      || (value.memory_policy !== undefined && (!isRecord(value.memory_policy)
        || typeof value.memory_policy.readExisting !== "boolean"
        || typeof value.memory_policy.captureFuture !== "boolean"))) {
      throw new Error("Session fork boundary is invalid");
    }
    return {
      ...base,
      type: "fork_boundary",
      lineage: cloneLineage(value.lineage),
      ...(value.workflow === undefined ? {} : { workflow: workflowSnapshot(value.workflow) }),
      ...(value.task_progress === undefined ? {} : { task_progress: cloneTaskProgress(value.task_progress) }),
      ...(value.memory_policy === undefined ? {} : { memory_policy: {
        readExisting: value.memory_policy.readExisting as boolean,
        captureFuture: value.memory_policy.captureFuture as boolean,
      } }),
    };
  }

  if (value.type === "fork_resume_updated") {
    if (typeof value.pending !== "boolean") throw new Error("Session fork resume state is invalid");
    return { ...base, type: "fork_resume_updated", pending: value.pending };
  }

  throw new Error(`Unsupported session event type: ${value.type}`);
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "blocked" || value === "complete" || value === "budget_limited" || value === "usage_limited";
}

/** The legacy reader preserves a valid final event even when its newline was lost. */
export function isValidSessionEvent(value: unknown): boolean {
  try { parseEvent(value); return true; } catch { return false; }
}

function isGoal(value: unknown): value is SessionGoal {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.goal_id) && isNonEmptyString(value.objective) && isGoalStatus(value.status) &&
    (value.token_budget === null || (typeof value.token_budget === "number" && Number.isSafeInteger(value.token_budget) && value.token_budget > 0)) &&
    typeof value.tokens_used === "number" && Number.isSafeInteger(value.tokens_used) && value.tokens_used >= 0 &&
    typeof value.usage_complete === "boolean" && typeof value.time_used_seconds === "number" && value.time_used_seconds >= 0 &&
    (value.blocked_streak === undefined || (typeof value.blocked_streak === "number" && Number.isSafeInteger(value.blocked_streak) && value.blocked_streak >= 0)) &&
    isNonEmptyString(value.created_at) && isNonEmptyString(value.updated_at);
}

function isVerificationResult(value: unknown): value is VerificationResult {
  if (!isRecord(value) || !isRecord(value.command)) return false;
  return typeof value.command.id === "string" &&
    typeof value.command.label === "string" &&
    typeof value.command.command === "string" &&
    (value.command.tier === "fast" || value.command.tier === "full") &&
    typeof value.command.timeoutMs === "number" &&
    typeof value.passed === "boolean" &&
    (typeof value.exitCode === "number" || value.exitCode === null) &&
    typeof value.stdout === "string" && typeof value.stderr === "string" &&
    typeof value.durationMs === "number" && typeof value.timedOut === "boolean" &&
    (value.skipped === undefined || typeof value.skipped === "boolean") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.diagnostic===undefined||(isRecord(value.diagnostic)&&['environment','unknown'].includes(String(value.diagnostic.category))&&(value.diagnostic.missingTool===undefined||(typeof value.diagnostic.missingTool==='string'&&/^[A-Za-z0-9_.-]+$/u.test(value.diagnostic.missingTool)))));
}

function isVerificationSuite(value: unknown): value is VerificationSuiteResult {
  if (!isRecord(value)) return false;
  return (value.status === "passed" || value.status === "failed" || value.status === "unavailable") &&
    Array.isArray(value.results) && value.results.every(isVerificationResult) &&
    Array.isArray(value.skipped) && value.skipped.every((command) => isRecord(command) &&
      typeof command.id === "string" && typeof command.label === "string" && typeof command.command === "string" &&
      (command.tier === "fast" || command.tier === "full") && typeof command.timeoutMs === "number") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.stale === undefined || typeof value.stale === "boolean") &&
    (value.evidence === undefined || isVerificationEvidence(value.evidence));
}

function isWorkflow(value: unknown): value is WorkflowState {
  if (!isRecord(value)) return false;
  const phases: WorkflowPhase[] = ["understand", "plan", "implement", "verify_fast", "diagnose", "verify_full", "review", "done", "blocked"];
  return typeof value.task_id === "string" && phases.includes(value.phase as WorkflowPhase) &&
    (value.task_source === undefined || value.task_source === "user" || value.task_source === "goal_continuation" || value.task_source === "session_resume" || value.task_source === "benchmark" || value.task_source === "exec") &&
    typeof value.repair_attempts === "number" && Number.isSafeInteger(value.repair_attempts) && value.repair_attempts >= 0 &&
    typeof value.max_repair_attempts === "number" && Number.isSafeInteger(value.max_repair_attempts) && value.max_repair_attempts >= 0 &&
    Array.isArray(value.changed_paths) && value.changed_paths.every((item) => typeof item === "string") &&
    typeof value.checkpoint_available === "boolean" && typeof value.updated_at === "string" &&
    (value.result === undefined || value.result === "verified" || value.result === "unverified" || value.result === "failed" || value.result === "no_changes") &&
    (value.result_reason === undefined || typeof value.result_reason === "string") &&
    (value.tracking_limited === undefined || typeof value.tracking_limited === "boolean") &&
    (value.verification_retries === undefined || (typeof value.verification_retries === "number" && Number.isSafeInteger(value.verification_retries) && value.verification_retries >= 0)) &&
    (value.pending_verification === undefined || typeof value.pending_verification === "boolean") &&
    (value.workspace_revision === undefined || typeof value.workspace_revision === "string") &&
    (value.verification_revision === undefined || typeof value.verification_revision === "string") &&
    (value.prior_unverified === undefined || (isRecord(value.prior_unverified) && typeof value.prior_unverified.task_id === "string" &&
      (value.prior_unverified.result === "unverified" || value.prior_unverified.result === "failed") &&
      (value.prior_unverified.reason === undefined || typeof value.prior_unverified.reason === "string"))) &&
    (value.last_verification === undefined || isVerificationResult(value.last_verification)) &&
    (value.last_verification_suite === undefined || isVerificationSuite(value.last_verification_suite));
}

function verificationSnapshot(verification: VerificationResult): VerificationResult {
  return {
    command: { ...verification.command },
    passed: verification.passed,
    exitCode: verification.exitCode,
    stdout: "",
    stderr: "",
    durationMs: verification.durationMs,
    timedOut: verification.timedOut,
    ...(verification.skipped === undefined ? {} : { skipped: verification.skipped }),
    ...(verification.diagnostic?{diagnostic:{category:verification.diagnostic.category,...(verification.diagnostic.missingTool?{missingTool:verification.diagnostic.missingTool}:{})}}:{}),
  };
}

function workflowSnapshot(workflow: WorkflowState): WorkflowState {
  const verification = workflow.last_verification;
  const suite = workflow.last_verification_suite;
  return {
    ...workflow,
    changed_paths: [...workflow.changed_paths],
    ...(workflow.prior_unverified ? { prior_unverified: { ...workflow.prior_unverified } } : {}),
    ...(verification === undefined ? {} : { last_verification: verificationSnapshot(verification) }),
    ...(suite === undefined ? {} : {
      last_verification_suite: {
        status: suite.status,
        results: suite.results.map(verificationSnapshot),
        skipped: suite.skipped.map((command) => ({ ...command })),
        ...(suite.reason ? { reason: suite.reason } : {}),
        ...(suite.stale === undefined ? {} : { stale: suite.stale }),
        ...(suite.evidence ? { evidence: structuredClone(suite.evidence) } : {}),
      },
    }),
  };
}

/** Decode complete records only; replay retains one record, not the whole raw log. */
async function* sessionRecords(filePath: string, trace: PerformanceTrace, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await fs.open(filePath, "r");
  let input: ReturnType<typeof createReadStream> | undefined;
  try {
    const stat = await handle.stat();
    if (stat.size === 0) return;
    input = handle.createReadStream({ start: 0, end: stat.size - 1, highWaterMark: 64 * 1024, autoClose: false, ...(signal ? { signal } : {}) });
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let number = 0;
    for await (const value of input) {
      signal?.throwIfAborted();
      const chunk = value as Buffer;
      trace.increment("session_log_read_bytes", chunk.byteLength);
      let offset = 0;
      while (offset < chunk.byteLength) {
        signal?.throwIfAborted();
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.byteLength : newline;
        const part = chunk.subarray(offset, end);
        if (part.byteLength) { pending.push(part); pendingBytes += part.byteLength; }
        trace.observeMax("session_replay_max_record_bytes", pendingBytes);
        trace.observeMax("session_replay_max_input_buffer_bytes", pendingBytes + chunk.byteLength);
        if (newline < 0) break;
        const bytes = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        yield { line: bytes.toString("utf8"), number: ++number, terminated: true };
        offset = newline + 1;
      }
    }
    if (pendingBytes) yield { line: Buffer.concat(pending, pendingBytes).toString("utf8"), number: ++number, terminated: false };
  } finally {
    input?.destroy();
    await handle.close();
  }
}

async function readSession(filePath: string, trace: PerformanceTrace, summaryOnly = false): Promise<LoadedSession> {
  let header: SessionCreatedEvent | undefined;
  let title = "";
  let titlePending = false;
  let model: SessionModelRef | undefined;
  let updatedAt = "";
  const timeline: StoredTimelineEntry[] = [];
  let context: Array<Record<string, unknown>> = [];
  let usage = createEmptySessionUsage();
  const costs: CostEstimate[] = [];
  let performanceReport: TaskPerformanceReport | undefined;

  let goal: SessionGoal | undefined;
  let workflow: WorkflowState | undefined;
  let taskProgress: TaskProgress | undefined;
  let memoryPolicy: LearnedMemoryPolicy | undefined;
  let lineage: SessionLineage | undefined;
  let forkPendingResume = false;
  let team: SessionTeamReference | undefined;
  for await (const record of sessionRecords(filePath, trace)) {
    if (!record.line.trim()) continue;
    let event: SessionEvent;
    try { event = parseEvent(JSON.parse(record.line)); }
    catch (error) {
      if (!record.terminated) break;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid session JSONL at ${filePath}:${record.number}: ${reason}`);
    }
    trace.increment("session_log_records");
    if (!header) {
      if (event.type !== "session_created") throw new Error(`Session file has no valid header: ${filePath}`);
      header = event;
      title = header.title;
      titlePending = header.title_pending;
      model = header.model;
      updatedAt = header.at;
      usage = createEmptySessionUsage(header.usage_tracking);
      lineage = header.lineage === undefined ? undefined : cloneLineage(header.lineage);
      continue;
    }
    updatedAt = event.at;
    if (event.type === "cost_estimated" && !summaryOnly) costs.push(event.estimate);
    if (event.type === "performance_report" && !summaryOnly) performanceReport = event.report;
    if (event.type === "title_updated") {
      title = event.title;
      titlePending = false;
    }
    if (event.type === "timeline_entry" && !summaryOnly) timeline.push(event.entry);
    if (event.type === "context_append" && !summaryOnly) context.push(...event.items);
    if (event.type === "context_compacted") {
      if (!summaryOnly) context = event.items.map((item) => ({ ...item }));
      usage = applyCompactionUsage(usage, event.usage);
    }
    if (event.type === "context_pruned") {
      if (!summaryOnly) context = event.items.map((item) => ({ ...item }));
      // Pruning changes the effective request without adding provider usage.
      // The next response supplies a fresh measured context value.
      usage = { ...usage, context_tokens: null };
    }
    if (event.type === "model_selected") {
      model = event.model;
      if (!event.preserve_context) context = [];
      usage = resetContextUsage(usage, event.preserve_context);
    }
    if (event.type === "usage_recorded") {
      const context = usage.context_tokens;
      usage = applyUsageSample(usage, event.usage);
      if (event.preserve_context && event.usage !== null) usage.context_tokens = context;
    }
    if (event.type === "goal_updated") goal = { ...event.goal };
    if (event.type === "team_updated") team = structuredClone(event.team);
    if (event.type === "workflow_updated") workflow = { ...event.workflow, changed_paths: [...event.workflow.changed_paths] };
    if (event.type === "task_progress_updated") taskProgress = cloneTaskProgress(event.progress);
    if (event.type === "memory_policy_updated") memoryPolicy = { ...event.policy };
    if (event.type === "fork_boundary") {
      lineage = cloneLineage(event.lineage);
      usage = createEmptySessionUsage(header.usage_tracking);
      goal = undefined;
      workflow = event.workflow === undefined
        ? undefined
        : { ...event.workflow, changed_paths: [...event.workflow.changed_paths] };
      taskProgress = event.task_progress === undefined
        ? undefined
        : cloneTaskProgress(event.task_progress);
      memoryPolicy = event.memory_policy === undefined ? undefined : { ...event.memory_policy };
      forkPendingResume = true;
    }
    if (event.type === "fork_resume_updated") forkPendingResume = event.pending;
  }

  if (!header || !model) throw new Error(`Session file has no valid header: ${filePath}`);
  return {
    summary: {
      id: header.session_id,
      title,
      title_pending: titlePending,
      created_at: header.at,
      updated_at: updatedAt,
      workspace_path: header.workspace_path,
      model,
      ...(team ? { team } : {}),
      ...(goal ? { goal } : {}),
      ...(workflow ? { workflow } : {}),
      ...(taskProgress ? { task_progress: cloneTaskProgress(taskProgress) } : {}),
      ...(memoryPolicy ? { memory_policy: memoryPolicy } : {}),
      ...(lineage ? { lineage: cloneLineage(lineage) } : {}),
      ...(lineage ? { fork_pending_resume: forkPendingResume } : {}),
    },
    timeline,
    context,
    usage,
    ...(costs.length ? { costs } : {}),
    ...(performanceReport ? { performanceReport } : {}),
    ...(goal ? { goal } : {}),
    ...(workflow ? { workflow } : {}),
    ...(taskProgress ? { taskProgress: cloneTaskProgress(taskProgress) } : {}),
    ...(memoryPolicy ? { memoryPolicy } : {}),
    ...(lineage ? { lineage: cloneLineage(lineage), forkPendingResume } : {}),
  };
}

function modelRef(model: SessionModelRef): SessionModelRef {
  return {
    id: model.id,
    model_name: model.model_name,
    base_url: model.base_url,
    ...(model.request_settings ? { request_settings: { ...model.request_settings } } : {}),
    ...(model.responses_profile === undefined ? {} : { responses_profile: model.responses_profile }),
  };
}

interface SessionSearchProjection {
  summary: SessionSummary;
  messages: Array<{ kind: "user" | "assistant"; text: string; timelineIndex: number }>;
}

interface CachedSearchProjection {
  size: number;
  mtimeMs: number;
  bytes: number;
  projection: SessionSearchProjection;
}

interface OutputReferenceState {
  references: ToolOutputAttachmentReference[];
  safeToClean: boolean;
  size: number;
  mtimeMs: number;
}

const MAX_SEARCH_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_RECOVERY_TAIL_BYTES = 8 * 1024 * 1024;
const RECOVERY_CHUNK_BYTES = 64 * 1024;

/** Preserve complete legacy events; discard only the invalid, unterminated crash tail. */
async function recoverSessionTail(filePath: string): Promise<boolean> {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Session log is not a regular file");
  const handle = await fs.open(filePath, "r+");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Session log changed while opening");
    if (stat.size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, stat.size - 1);
    if (last[0] === 10) return false;
    let position = stat.size;
    let tailStart = 0;
    let scanned = 0;
    const chunks: Buffer[] = [];
    while (position > 0) {
      const count = Math.min(RECOVERY_CHUNK_BYTES, position, MAX_RECOVERY_TAIL_BYTES + 1 - scanned);
      if (count <= 0) throw new Error("Session trailing record exceeds the 8 MiB recovery limit; original log was preserved");
      const bytes = Buffer.allocUnsafe(count);
      const offset = position - count;
      const read = await handle.read(bytes, 0, count, offset);
      if (read.bytesRead !== count) throw new Error("Session log changed during tail recovery");
      const newline = bytes.lastIndexOf(10);
      scanned += count;
      if (newline >= 0) {
        tailStart = offset + newline + 1;
        chunks.unshift(bytes.subarray(newline + 1));
        break;
      }
      chunks.unshift(bytes);
      position = offset;
    }
    const tailBytes = stat.size - tailStart;
    if (tailBytes > MAX_RECOVERY_TAIL_BYTES) throw new Error("Session trailing record exceeds the 8 MiB recovery limit; original log was preserved");
    const tail = Buffer.concat(chunks, tailBytes).toString("utf8");
    let preserve = !tail.trim();
    try { preserve ||= isValidSessionEvent(JSON.parse(tail)); } catch { /* Invalid unfinished record. */ }
    const current = await handle.stat();
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw new Error("Session log changed during tail recovery");
    if (preserve) await handle.write(Buffer.from("\n"), 0, 1, stat.size);
    else await handle.truncate(tailStart);
    return true;
  } finally { await handle.close(); }
}

async function readSearchProjection(filePath: string, trace: PerformanceTrace, signal?: AbortSignal): Promise<SessionSearchProjection> {
  signal?.throwIfAborted();
  let lineNumber = 0;
  let header: SessionCreatedEvent | undefined;
  let title = "";
  let titlePending = false;
  let model: SessionModelRef | undefined;
  let updatedAt = "";
  let goal: SessionGoal | undefined;
  let workflow: WorkflowState | undefined;
  let taskProgress: TaskProgress | undefined;
  let memoryPolicy: LearnedMemoryPolicy | undefined;
  let lineage: SessionLineage | undefined;
  let forkPendingResume = false;
  let team: SessionTeamReference | undefined;
  let timelineIndex = 0;
  const messages: SessionSearchProjection["messages"] = [];

  const processLine = (line: string, allowIncomplete: boolean) => {
    lineNumber += 1;
    if (!line.trim()) return;
    let event: SessionEvent;
    try {
      event = parseEvent(JSON.parse(line));
    } catch (error) {
      if (allowIncomplete) return;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid session JSONL at ${filePath}:${lineNumber}: ${reason}`);
    }
    if (!header) {
      if (event.type !== "session_created") throw new Error(`Session file has no valid header: ${filePath}`);
      header = event;
      title = event.title;
      titlePending = event.title_pending;
      model = event.model;
      updatedAt = event.at;
      lineage = event.lineage === undefined ? undefined : cloneLineage(event.lineage);
      return;
    }
    updatedAt = event.at;
    if (event.type === "title_updated") {
      title = event.title;
      titlePending = false;
    }
    if (event.type === "timeline_entry") {
      if (event.entry.kind === "user" || event.entry.kind === "assistant") {
        messages.push({ kind: event.entry.kind, text: event.entry.text, timelineIndex });
      }
      timelineIndex += 1;
    }
    if (event.type === "model_selected") model = event.model;
    if (event.type === "goal_updated") goal = { ...event.goal };
    if (event.type === "team_updated") team = structuredClone(event.team);
    if (event.type === "workflow_updated") workflow = { ...event.workflow, changed_paths: [...event.workflow.changed_paths] };
    if (event.type === "task_progress_updated") taskProgress = cloneTaskProgress(event.progress);
    if (event.type === "memory_policy_updated") memoryPolicy = { ...event.policy };
    if (event.type === "fork_boundary") {
      lineage = cloneLineage(event.lineage);
      goal = undefined;
      workflow = event.workflow === undefined
        ? undefined
        : { ...event.workflow, changed_paths: [...event.workflow.changed_paths] };
      taskProgress = event.task_progress === undefined ? undefined : cloneTaskProgress(event.task_progress);
      memoryPolicy = event.memory_policy === undefined ? undefined : { ...event.memory_policy };
      forkPendingResume = true;
    }
    if (event.type === "fork_resume_updated") forkPendingResume = event.pending;
  };

  for await (const record of sessionRecords(filePath, trace, signal)) {
    processLine(record.line, !record.terminated);
    trace.increment("session_search_records");
  }
  if (!header || !model) throw new Error(`Session file has no valid header: ${filePath}`);
  return {
    summary: {
      id: header.session_id,
      title,
      title_pending: titlePending,
      created_at: header.at,
      updated_at: updatedAt,
      workspace_path: header.workspace_path,
      model,
      ...(team ? { team } : {}),
      ...(goal ? { goal } : {}),
      ...(workflow ? { workflow } : {}),
      ...(taskProgress ? { task_progress: cloneTaskProgress(taskProgress) } : {}),
      ...(memoryPolicy ? { memory_policy: memoryPolicy } : {}),
      ...(lineage ? { lineage: cloneLineage(lineage), fork_pending_resume: forkPendingResume } : {}),
    },
    messages,
  };
}

function searchSnippet(text: string, normalizedQuery: string): string {
  const normalizedText = text.replace(/\s+/gu, " ").trim();
  if (!normalizedQuery) return normalizedText.slice(0, 160);
  const index = normalizedText.toLocaleLowerCase().indexOf(normalizedQuery);
  const start = Math.max(0, index - 60);
  const end = Math.min(normalizedText.length, Math.max(index + normalizedQuery.length + 60, start + 160));
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${end < normalizedText.length ? "…" : ""}`;
}

export function normalizeSessionWorkspacePath(value: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(value)) {
    return path.win32.normalize(value).replace(/[\\/]+$/u, "").toLowerCase();
  }
  return normalizeWorkspacePath(value);
}

function forkWorkflowState(
  parent: WorkflowState | undefined,
  now: string,
): WorkflowState {
  const state = createWorkflowState(randomUUID(), now, "session_resume");
  if (!parent) return state;
  const changedPaths = [...parent.changed_paths];
  const currentTaskNeedsRevalidation = parent.pending_verification === true
    || parent.result === "failed"
    || parent.result === "unverified"
    || parent.tracking_limited === true
    || parent.checkpoint_available
    || changedPaths.length > 0
    || (parent.phase !== "understand" && parent.phase !== "plan" && parent.phase !== "done");
  const priorUnverified = currentTaskNeedsRevalidation
    ? {
        task_id: parent.task_id,
        result: parent.result === "failed" ? "failed" as const : "unverified" as const,
        reason: parent.result_reason ?? "Forked sessions must revalidate inherited workspace changes",
      }
    : parent.prior_unverified === undefined
      ? undefined
      : { ...parent.prior_unverified };
  return {
    ...state,
    changed_paths: changedPaths,
    ...(priorUnverified === undefined ? {} : {
      pending_verification: true,
      prior_unverified: priorUnverified,
    }),
  };
}

function forkTaskProgress(
  parent: TaskProgress | undefined,
  parentSessionId: string,
): TaskProgress | undefined {
  return parent === undefined
    ? undefined
    : {
        ...cloneTaskProgress(parent),
        inherited_from_session_id: parentSessionId,
      };
}

const FORK_COPY_EVENT_TYPES = new Set<SessionEvent["type"]>([
  "timeline_entry",
  "context_append",
  "context_compacted",
  "context_pruned",
  "model_selected",
]);

function sessionHeaderDigest(serialized: string): string {
  return createHash("sha256").update(Buffer.from(serialized, "utf8")).digest("hex");
}

export class SessionStore implements SessionStoreLike {
  readonly activity: SessionActivity;
  readonly performanceTrace: PerformanceTrace;
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #writeQueues = new Map<string, Promise<void>>();
  readonly #deletedSessionIds = new Set<string>();
  readonly #searchCache = new Map<string, CachedSearchProjection>();
  readonly #outputs: SessionOutputStorage;
  readonly #outputReferences = new Map<string, OutputReferenceState>();
  #outputStartup: Promise<void> | undefined;
  #forkStartup: Promise<void> | undefined;
  #searchCacheBytes = 0;

  constructor(options: SessionStoreOptions = {}) {
    this.performanceTrace = options.trace ?? new PerformanceTrace();
    this.#directory = options.directory ?? defaultSessionDirectory();
    this.activity = new SessionActivity(this.#directory);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#outputs = new SessionOutputStorage(this.#directory, this.performanceTrace);
  }

  get directory(): string {
    return this.#directory;
  }

  async create(input: CreateSessionInput): Promise<SessionSummary> {
    await this.#ensureOutputsInitialized();
    await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const at = this.#now().toISOString();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = this.#createId();
      this.#assertSessionId(id);
      const event: SessionCreatedEvent = {
        version: SESSION_FORMAT_VERSION,
        type: "session_created",
        at,
        session_id: id,
        title: input.title,
        title_pending: input.titlePending,
        workspace_path: input.workspacePath,
        model: modelRef(input.model),
        usage_tracking: true,
      };
      try {
        const handle = await fs.open(this.#filePath(id), "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        this.#deletedSessionIds.delete(id);
        return {
          id,
          title: input.title,
          title_pending: input.titlePending,
          created_at: at,
          updated_at: at,
          workspace_path: input.workspacePath,
          model: modelRef(input.model),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    throw new Error("Could not allocate a unique session ID");
  }

  updateTitle(sessionId: string, title: string): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "title_updated",
      at: this.#now().toISOString(),
      title,
    });
  }

  appendTimeline(sessionId: string, entry: StoredTimelineEntry): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "timeline_entry",
      at: this.#now().toISOString(),
      entry: { ...entry },
    });
  }

  appendContext(
    sessionId: string,
    items: readonly Record<string, unknown>[],
  ): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "context_append",
      at: this.#now().toISOString(),
      items: items.map((item) => ({ ...item })),
    });
  }

  commitToolResult(sessionId: string, item: Record<string, unknown>, attachment?: PreparedOutputAttachment): Promise<void> {
    const reference = attachment === undefined ? undefined : toolOutputAttachmentReference(attachment);
    const event: ContextAppendEvent = {
      version: SESSION_FORMAT_VERSION,
      type: "context_append",
      at: this.#now().toISOString(),
      items: [{ ...item }],
      ...(reference === undefined ? {} : { tool_output_attachment: reference }),
    };
    const serialized = `${JSON.stringify(event)}\n`;
    this.#dropSearchCache(this.#filePath(sessionId));
    return this.#enqueue(sessionId, async () => {
      await this.#recoverTail(sessionId);
      const state = await this.#references(sessionId);
      if (attachment) await this.#outputs.write(sessionId, attachment);
      // A failed reference append leaves an orphan; it cannot evict earlier committed outputs.
      try {
        await fs.appendFile(this.#filePath(sessionId), serialized, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        if (attachment) {
          // Keep every prior committed attachment; remove only this failed commit if possible.
          await this.#outputs.remove(sessionId, attachment.output_id).catch(() => undefined);
        }
        throw error;
      }
      if (reference) {
        state.references.push(reference);
        state.references = state.references.slice(-RETAINED_TOOL_OUTPUTS);
        if (state.safeToClean) await this.#outputs.cleanup(sessionId, state.references.map((entry) => entry.output_id));
      }
      const stat = await fs.stat(this.#filePath(sessionId));
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
    });
  }

  captureSessionBoundary(sessionId: string): Promise<number> {
    let boundary = 0;
    return this.#enqueue(sessionId, async () => {
      // Capture the committed prefix, so a later repaired append cannot enter an older step's EOF.
      await this.#recoverTail(sessionId);
      const state = await this.#references(sessionId);
      if (state.safeToClean) await this.#outputs.cleanup(sessionId, state.references.map((entry) => entry.output_id));
      boundary = (await fs.stat(this.#filePath(sessionId))).size;
    }).then(() => boundary);
  }

  async readToolOutput(sessionId: string, outputId: string): Promise<StoredToolOutput | null> {
    this.#assertSessionId(sessionId);
    if (!/^[A-Za-z0-9_-]+$/u.test(outputId) || this.#deletedSessionIds.has(sessionId)) return null;
    let output: StoredToolOutput | null = null;
    try {
      await this.#enqueue(sessionId, async () => {
        const state = await this.#references(sessionId);
        const reference = state.references.find((candidate) => candidate.output_id === outputId);
        if (reference) output = await this.#outputs.read(sessionId, reference);
      });
      return output;
    } catch (error) {
      if (this.#deletedSessionIds.has(sessionId) || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** The caller supplies an authoritative reference from its own bounded session-log scan. */
  async readReferencedToolOutput(sessionId: string, reference: ToolOutputAttachmentReference, options?: SessionOutputReadOptions): Promise<StoredToolOutput | null> {
    this.#assertSessionId(sessionId);
    if (!isToolOutputAttachmentReference(reference) || this.#deletedSessionIds.has(sessionId)) return null;
    let output: StoredToolOutput | null = null;
    try {
      await this.#enqueue(sessionId, async () => {
        if (!(await fs.lstat(this.#filePath(sessionId))).isFile()) return;
        output = await this.#outputs.read(sessionId, reference, options?.signal);
      }, false, options);
      return output;
    } catch (error) {
      if (this.#deletedSessionIds.has(sessionId) || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readReferencedToolOutputPage(sessionId: string, reference: ToolOutputAttachmentReference, arguments_: ReadToolOutputArguments, options?: SessionOutputReadOptions): Promise<StoredToolOutputRange | null> {
    this.#assertSessionId(sessionId);
    if (!isToolOutputAttachmentReference(reference) || this.#deletedSessionIds.has(sessionId)) return null;
    let output: StoredToolOutputRange | null = null;
    try {
      await this.#enqueue(sessionId, async () => {
        checkOutputReadBudget(options);
        const log = await fs.lstat(this.#filePath(sessionId));
        if (!log.isFile() || log.isSymbolicLink()) return;
        output = await this.#outputs.readRange(sessionId, reference, arguments_, options?.signal);
        checkOutputReadBudget(options);
        const current = await fs.lstat(this.#filePath(sessionId));
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== log.dev || current.ino !== log.ino) output = null;
      }, false, options);
      return output;
    } catch (error) {
      if (this.#deletedSessionIds.has(sessionId) || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  compactContext(
    sessionId: string,
    items: readonly Record<string, unknown>[],
    automatic: boolean,
    usage: TokenUsageSample | null,
  ): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "context_compacted",
      at: this.#now().toISOString(),
      items: items.map((item) => ({ ...item })),
      automatic,
      usage: usage === null ? null : { ...usage },
    });
  }

  pruneContext(
    sessionId: string,
    items: readonly Record<string, unknown>[],
    metadata: ContextPruneMetadata,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(metadata.original_bytes) || metadata.original_bytes < 0 ||
      !Number.isSafeInteger(metadata.pruned_bytes) || metadata.pruned_bytes < 0 ||
      metadata.pruned_bytes >= metadata.original_bytes ||
      !Number.isSafeInteger(metadata.pruned_results) || metadata.pruned_results < 1
    ) throw new Error("Invalid context pruning metadata");
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "context_pruned",
      at: this.#now().toISOString(),
      items: items.map((item) => ({ ...item })),
      ...metadata,
    });
  }

  appendCost(sessionId: string, estimate: CostEstimate): Promise<void> {
    if (!isCostEstimate(estimate)) throw new Error("Invalid cost estimate");
    return this.#append(sessionId, { version: SESSION_FORMAT_VERSION, type: "cost_estimated", at: this.#now().toISOString(), estimate: structuredClone(estimate) });
  }

  appendPerformance(sessionId: string, report: TaskPerformanceReport): Promise<void> {
    if (!isTaskPerformanceReport(report)) throw new Error("Invalid performance report");
    return this.#append(sessionId, { version: SESSION_FORMAT_VERSION, type: "performance_report", at: this.#now().toISOString(), report: structuredClone(report) });
  }

  appendUsage(
    sessionId: string,
    usage: TokenUsageSample | null,
    options?: { preserveContext?: boolean },
  ): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "usage_recorded",
      at: this.#now().toISOString(),
      usage: usage === null ? null : { ...usage },
      ...(options?.preserveContext ? { preserve_context: true } : {}),
    });
  }

  selectModel(
    sessionId: string,
    model: SessionModelRef,
    preserveContext: boolean,
  ): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "model_selected",
      at: this.#now().toISOString(),
      model: modelRef(model),
      preserve_context: preserveContext,
    });
  }

  setGoal(sessionId: string, goal: SessionGoal): Promise<void> {
    return this.#append(sessionId, { version: SESSION_FORMAT_VERSION, type: "goal_updated", at: this.#now().toISOString(), goal: { ...goal } });
  }

  async updateGoal(sessionId: string, patch: Partial<Pick<SessionGoal, "status" | "tokens_used" | "usage_complete" | "time_used_seconds" | "blocked_streak" | "updated_at">>): Promise<void> {
    const current = (await this.load(sessionId)).goal;
    if (!current) throw new Error("No goal exists for this session");
    await this.setGoal(sessionId, { ...current, ...patch, updated_at: patch.updated_at ?? this.#now().toISOString() });
  }

  async setTeam(sessionId: string, team: SessionTeamReference): Promise<void> {
    for (const member of team.members) if (member.sessionId) await this.activity.retainTeam(member.sessionId);
    return this.#append(sessionId, { version: SESSION_FORMAT_VERSION, type: "team_updated", at: this.#now().toISOString(), team: structuredClone(team) });
  }
  setWorkflow(sessionId: string, workflow: WorkflowState): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "workflow_updated",
      at: this.#now().toISOString(),
      workflow: workflowSnapshot(workflow),
    });
  }

  setTaskProgress(sessionId: string, progress: TaskProgress): Promise<void> {
    if (!isTaskProgress(progress)) return Promise.reject(new Error("Task progress is invalid"));
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "task_progress_updated",
      at: this.#now().toISOString(),
      progress: cloneTaskProgress(progress),
    });
  }

  setMemoryPolicy(sessionId: string, policy: LearnedMemoryPolicy): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "memory_policy_updated",
      at: this.#now().toISOString(),
      policy: { ...policy },
    });
  }

  async fork(sessionId: string, input: ForkSessionInput = {}): Promise<SessionSummary> {
    this.#assertSessionId(sessionId);
    input.signal?.throwIfAborted();
    await this.#ensureOutputsInitialized();
    let created: SessionSummary | undefined;
    await this.#enqueue(sessionId, async () => {
      input.signal?.throwIfAborted();
      await this.#recoverTail(sessionId);
      const sourcePath = this.#filePath(sessionId);
      const boundary = (await fs.stat(sourcePath)).size;
      if (boundary <= 0) throw new Error("Cannot fork an empty Session log");
      const references = (await this.#references(sessionId)).references.slice(-RETAINED_TOOL_OUTPUTS);
      const transaction = await this.#createForkTransaction(sessionId);
      let outputsPublished = false;
      let logPublished = false;
      try {
        const copiedPath = path.join(transaction.directory, "copied-events.jsonl");
        const copiedHandle = await fs.open(copiedPath, "wx", 0o600);
        let header: SessionCreatedEvent | undefined;
        let sourceTitle = "";
        let sourceModel: SessionModelRef | undefined;
        let sourceWorkflow: WorkflowState | undefined;
        let sourceTaskProgress: TaskProgress | undefined;
        let sourceMemoryPolicy: LearnedMemoryPolicy | undefined;
        let sourceHeaderSha256 = "";
        let lineNumber = 0;
        const stream = createReadStream(sourcePath, {
          encoding: "utf8",
          start: 0,
          end: boundary - 1,
        });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            input.signal?.throwIfAborted();
            lineNumber += 1;
            if (!line.trim()) continue;
            let event: SessionEvent;
            try {
              event = parseEvent(JSON.parse(line));
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              throw new Error(`Invalid session JSONL at ${sourcePath}:${lineNumber}: ${reason}`);
            }
            if (!header) {
              if (event.type !== "session_created" || event.session_id !== sessionId) {
                throw new Error(`Session file has no valid header: ${sourcePath}`);
              }
              header = event;
              sourceTitle = event.title;
              sourceModel = modelRef(event.model);
              sourceHeaderSha256 = sessionHeaderDigest(line);
              continue;
            }
            if (event.type === "title_updated") sourceTitle = event.title;
            if (event.type === "model_selected") sourceModel = modelRef(event.model);
            if (event.type === "workflow_updated") sourceWorkflow = workflowSnapshot(event.workflow);
            if (event.type === "task_progress_updated") sourceTaskProgress = cloneTaskProgress(event.progress);
            if (event.type === "memory_policy_updated") sourceMemoryPolicy = { ...event.policy };
            if (event.type === "fork_boundary") {
              sourceWorkflow = event.workflow === undefined ? undefined : workflowSnapshot(event.workflow);
              sourceTaskProgress = event.task_progress === undefined ? undefined : cloneTaskProgress(event.task_progress);
              sourceMemoryPolicy = event.memory_policy === undefined ? undefined : { ...event.memory_policy };
            }
            if (FORK_COPY_EVENT_TYPES.has(event.type)) {
              await copiedHandle.writeFile(`${line}\n`, "utf8");
            }
          }
          await copiedHandle.sync();
        } finally {
          lines.close();
          stream.destroy();
          await copiedHandle.close();
        }
        if (!header || !sourceModel || !sourceHeaderSha256) {
          throw new Error(`Session file has no valid header: ${sourcePath}`);
        }

        const at = this.#now().toISOString();
        const requestedTitle = input.title?.trim();
        if (input.title !== undefined && !requestedTitle) throw new Error("Fork title must not be empty");
        const title = requestedTitle ?? `${sourceTitle} (fork)`;
        const lineage: SessionLineage = {
          parent_session_id: sessionId,
          forked_at: at,
          source_boundary_bytes: boundary,
          source_header_sha256: sourceHeaderSha256,
        };
        const workflow = forkWorkflowState(sourceWorkflow, at);
        const taskProgress = forkTaskProgress(sourceTaskProgress, sessionId);
        const childHeader: SessionCreatedEvent = {
          version: SESSION_FORMAT_VERSION,
          type: "session_created",
          at,
          session_id: transaction.sessionId,
          title,
          title_pending: false,
          workspace_path: header.workspace_path,
          model: modelRef(sourceModel),
          usage_tracking: true,
          lineage,
        };
        const boundaryEvent: ForkBoundaryEvent = {
          version: SESSION_FORMAT_VERSION,
          type: "fork_boundary",
          at,
          lineage,
          workflow,
          ...(taskProgress === undefined ? {} : { task_progress: taskProgress }),
          ...(sourceMemoryPolicy === undefined ? {} : { memory_policy: { ...sourceMemoryPolicy } }),
        };
        const stagedLogPath = path.join(transaction.directory, "session.jsonl");
        const stagedLog = await fs.open(stagedLogPath, "wx", 0o600);
        try {
          await stagedLog.writeFile(`${JSON.stringify(childHeader)}\n`, "utf8");
          const copiedStream = createReadStream(copiedPath);
          try {
            for await (const chunk of copiedStream) {
              input.signal?.throwIfAborted();
              await stagedLog.write(chunk as Buffer);
            }
          } finally {
            copiedStream.destroy();
          }
          await stagedLog.writeFile(`${JSON.stringify(boundaryEvent)}\n`, "utf8");
          await stagedLog.sync();
        } finally {
          await stagedLog.close();
        }

        const stagedOutputs = path.join(transaction.directory, "outputs");
        await this.#outputs.stageFork(sessionId, stagedOutputs, references, input.signal);
        input.signal?.throwIfAborted();
        await this.#outputs.publishFork(transaction.sessionId, stagedOutputs);
        outputsPublished = true;
        input.signal?.throwIfAborted();
        await fs.rename(stagedLogPath, this.#filePath(transaction.sessionId));
        logPublished = true;
        this.#deletedSessionIds.delete(transaction.sessionId);
        created = {
          id: transaction.sessionId,
          title,
          title_pending: false,
          created_at: at,
          updated_at: at,
          workspace_path: header.workspace_path,
          model: modelRef(sourceModel),
          workflow: workflowSnapshot(workflow),
          ...(taskProgress === undefined ? {} : { task_progress: cloneTaskProgress(taskProgress) }),
          ...(sourceMemoryPolicy === undefined ? {} : { memory_policy: { ...sourceMemoryPolicy } }),
          lineage: cloneLineage(lineage),
          fork_pending_resume: true,
        };
      } catch (error) {
        if (outputsPublished && !logPublished) {
          await this.#outputs.deleteSession(transaction.sessionId).catch(() => undefined);
        }
        throw error;
      } finally {
        await transaction.release().catch(() => undefined);
        await fs.rm(transaction.directory, { recursive: true, force: true }).catch(() => undefined);
      }
    });
    if (!created) throw new Error("Session fork did not publish a child Session");
    return created;
  }

  setForkPendingResume(sessionId: string, pending: boolean): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "fork_resume_updated",
      at: this.#now().toISOString(),
      pending,
    });
  }

  async list(): Promise<SessionListResult> {
    await this.#ensureOutputsInitialized();
    await Promise.all(
      [...this.#writeQueues.values()].map((pending) => pending.catch(() => undefined)),
    );
    let entries;
    try {
      entries = await fs.readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: [], skipped: 0 };
      }
      throw error;
    }

    const sessions: SessionSummary[] = [];
    let skipped = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        sessions.push((await readSession(path.join(this.#directory, entry.name), this.performanceTrace, true)).summary);
      } catch {
        skipped += 1;
      }
    }

    sessions.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return { sessions, skipped };
  }

  async search(options: SessionSearchOptions): Promise<SessionSearchResult> {
    await this.#ensureOutputsInitialized();
    await Promise.all(
      [...this.#writeQueues.values()].map((pending) => pending.catch(() => undefined)),
    );
    options.signal?.throwIfAborted();
    let entries;
    try {
      entries = await fs.readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { matches: [], total: 0, skipped: 0 };
      throw error;
    }
    const normalizedQuery = options.query.trim().toLocaleLowerCase();
    const workspace = options.workspacePath === undefined
      ? undefined
      : normalizeSessionWorkspacePath(options.workspacePath);
    const matches: SessionSearchMatch[] = [];
    let skipped = 0;
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const projection = await this.#searchProjection(path.join(this.#directory, entry.name), options.signal);
        if (workspace !== undefined && normalizeSessionWorkspacePath(projection.summary.workspace_path) !== workspace) continue;
        let match: SessionSearchMatch["match"];
        if (normalizedQuery && projection.summary.title.toLocaleLowerCase().includes(normalizedQuery)) {
          match = { kind: "title", snippet: searchSnippet(projection.summary.title, normalizedQuery) };
        } else if (normalizedQuery) {
          const message = [...projection.messages].reverse().find((candidate) => candidate.text.toLocaleLowerCase().includes(normalizedQuery));
          if (!message) continue;
          match = {
            kind: message.kind,
            snippet: searchSnippet(message.text, normalizedQuery),
            timelineIndex: message.timelineIndex,
          };
        }
        const matchedMessage = match?.timelineIndex === undefined
          ? undefined
          : projection.messages.findIndex((message) => message.timelineIndex === match.timelineIndex);
        const previewStart = matchedMessage === undefined || matchedMessage < 0
          ? Math.max(0, projection.messages.length - 3)
          : Math.max(0, matchedMessage - 1);
        const preview = projection.messages
          .slice(previewStart, previewStart + 3)
          .map((message) => ({ kind: message.kind, snippet: searchSnippet(message.text, normalizedQuery) }));
        matches.push({
          // Returned snapshots belong to the caller, not the cached recovery projection.
          summary: structuredClone(projection.summary),
          ...(match === undefined ? {} : { match }),
          ...(preview.length === 0 ? {} : { preview }),
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        skipped += 1;
      }
    }
    matches.sort((left, right) =>
      right.summary.updated_at.localeCompare(left.summary.updated_at) ||
      left.summary.id.localeCompare(right.summary.id));
    const total = matches.length;
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 50)));
    return { matches: matches.slice(offset, offset + limit), total, skipped };
  }

  async deleteMany(sessionIds: readonly string[], expectedActivity?: Readonly<Record<string, string>>): Promise<void> {
    const uniqueIds = [...new Set(sessionIds)];
    uniqueIds.forEach((sessionId) => this.#assertSessionId(sessionId));
    await Promise.all(uniqueIds.map((sessionId) => {
      const previous = this.#writeQueues.get(sessionId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          await this.#ensureOutputsInitialized();
          await this.activity.withInactive(sessionId, () => this.#withSessionLock(sessionId, async () => {
            if (expectedActivity?.[sessionId] !== undefined) {
              const loaded = await readSession(this.#filePath(sessionId), this.performanceTrace, true);
              const stat = await fs.lstat(this.#filePath(sessionId));
              const fingerprint = `${loaded.summary.updated_at}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
              if (fingerprint !== expectedActivity[sessionId] || loaded.summary.team) throw new Error("Session cleanup preview changed or has retained team ownership");
            }
            this.#deletedSessionIds.add(sessionId);
            this.#dropSearchCache(this.#filePath(sessionId));
            try {
              await this.#outputs.deleteSession(sessionId);
              const { InputHistory } = await import('./input-history.js');
              await new InputHistory(path.join(path.dirname(this.#directory), 'input-history.json')).removeSessions([sessionId]);
              await fs.rm(this.#filePath(sessionId), { force: true });
            } catch (error) { this.#deletedSessionIds.delete(sessionId); throw error; }
            this.#outputReferences.delete(sessionId);
          }), expectedActivity?.[sessionId] !== undefined);
        });
      this.#writeQueues.set(sessionId, next);
      void next.finally(() => {
        if (this.#writeQueues.get(sessionId) === next) this.#writeQueues.delete(sessionId);
      }).catch(() => undefined);
      return next;
    }));
  }

  async load(sessionId: string): Promise<LoadedSession> {
    this.#assertSessionId(sessionId);
    await this.#ensureOutputsInitialized();
    const pending = this.#writeQueues.get(sessionId);
    if (pending) await pending;
    const started = performance.now();
    try { return await readSession(this.#filePath(sessionId), this.performanceTrace); }
    finally { this.performanceTrace.record("session_load", performance.now() - started); }
  }

  #append(sessionId: string, event: SessionEvent): Promise<void> {
    const serialized = `${JSON.stringify(event)}\n`;
    this.#dropSearchCache(this.#filePath(sessionId));
    return this.#enqueue(sessionId, async () => {
      await this.#recoverTail(sessionId);
      const cached = this.#outputReferences.get(sessionId);
      const before = await fs.stat(this.#filePath(sessionId));
      await fs.appendFile(this.#filePath(sessionId), serialized, { encoding: "utf8", mode: 0o600 });
      // Ordinary events cannot change attachment refs. Avoid rescanning the entire long task
      // after each usage/timeline append; an external writer still invalidates this cache.
      if (cached && before.size === cached.size && before.mtimeMs === cached.mtimeMs) {
        const after = await fs.stat(this.#filePath(sessionId));
        cached.size = after.size;
        cached.mtimeMs = after.mtimeMs;
      }
    });
  }

  #enqueue(sessionId: string, operation: () => Promise<void>, initializeOutputs = true, readOptions?: SessionOutputReadOptions): Promise<void> {
    this.#assertSessionId(sessionId);
    if (this.#deletedSessionIds.has(sessionId)) return Promise.reject(new Error("Session has been deleted"));
    const previous = this.#writeQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (initializeOutputs) await this.#ensureOutputsInitialized();
        await this.#withSessionLock(sessionId, operation, readOptions);
      });
    this.#writeQueues.set(sessionId, next);
    void next.finally(() => {
      if (this.#writeQueues.get(sessionId) === next) this.#writeQueues.delete(sessionId);
    }).catch(() => undefined);
    return withinOutputReadBudget(next, readOptions);
  }

  async #withSessionLock(sessionId: string, operation: () => Promise<void>, readOptions?: SessionOutputReadOptions): Promise<void> {
    checkOutputReadBudget(readOptions);
    let release: () => Promise<void>;
    while (true) {
      checkOutputReadBudget(readOptions);
      try {
        release = await lockfile.lock(this.#filePath(sessionId), {
          realpath: false,
          retries: readOptions ? 0 : { retries: 100, minTimeout: 20, maxTimeout: 100 },
        });
        break;
      } catch (error) {
        if (!readOptions || (error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        await withinOutputReadBudget(new Promise<void>((resolve) => setTimeout(resolve, 20)), readOptions);
      }
    }
    try {
      checkOutputReadBudget(readOptions);
      await operation();
      checkOutputReadBudget(readOptions);
    } finally {
      await release();
    }
  }

  async #createForkTransaction(sourceSessionId: string): Promise<{
    sessionId: string;
    directory: string;
    release: () => Promise<void>;
  }> {
    await this.#ensureForkStagingInitialized();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sessionId = this.#createId();
      this.#assertSessionId(sessionId);
      if (sessionId === sourceSessionId) continue;
      try {
        await fs.access(this.#filePath(sessionId));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const directory = path.join(this.#forkStagingDirectory(), sessionId);
      try {
        await fs.mkdir(directory, { recursive: false, mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const leasePath = path.join(directory, "lease");
      try {
        const lease = await fs.open(leasePath, "wx", 0o600);
        await lease.close();
        const release = await lockfile.lock(leasePath, { realpath: false, retries: 0 });
        return { sessionId, directory, release };
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    throw new Error("Could not allocate a unique fork Session ID");
  }

  #forkStagingDirectory(): string {
    return path.join(this.#directory, ".fork-staging");
  }

  #ensureForkStagingInitialized(): Promise<void> {
    this.#forkStartup ??= (async () => {
      await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const root = this.#forkStagingDirectory();
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error("Session fork staging is not a regular directory");
      }
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error("Session fork staging cannot contain symbolic links");
        const directory = path.join(root, entry.name);
        if (!entry.isDirectory()) {
          await fs.rm(directory, { force: true });
          continue;
        }
        const leasePath = path.join(directory, "lease");
        let release: (() => Promise<void>) | undefined;
        try {
          await fs.access(leasePath);
          release = await lockfile.lock(leasePath, { realpath: false, retries: 0 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ELOCKED") continue;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await release?.().catch(() => undefined);
        await fs.rm(directory, { recursive: true, force: true });
      }
    })();
    return this.#forkStartup;
  }

  async #forkTransactionActive(sessionId: string): Promise<boolean> {
    const leasePath = path.join(this.#forkStagingDirectory(), sessionId, "lease");
    let release: (() => Promise<void>) | undefined;
    try {
      await fs.access(leasePath);
      release = await lockfile.lock(leasePath, { realpath: false, retries: 0 });
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") return true;
      throw error;
    } finally {
      await release?.().catch(() => undefined);
    }
  }

  #ensureOutputsInitialized(): Promise<void> {
    this.#outputStartup ??= (async () => {
      await this.#ensureForkStagingInitialized();
      for (const sessionId of await this.#outputs.sessions()) {
        if (await this.#forkTransactionActive(sessionId)) continue;
        await this.#withSessionLock(sessionId, async () => {
          let state: OutputReferenceState;
          try {
            state = await this.#references(sessionId);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await this.#outputs.deleteSession(sessionId);
            return;
          }
          if (state.safeToClean) await this.#outputs.cleanup(sessionId, state.references.map((entry) => entry.output_id));
        });
      }
    })();
    return this.#outputStartup;
  }

  async #references(sessionId: string): Promise<OutputReferenceState> {
    const stat = await fs.stat(this.#filePath(sessionId));
    const cached = this.#outputReferences.get(sessionId);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    const state = { ...await readToolOutputReferences(this.#filePath(sessionId), sessionId, isValidSessionEvent, this.performanceTrace), size: stat.size, mtimeMs: stat.mtimeMs };
    this.#outputReferences.set(sessionId, state);
    return state;
  }

  async #recoverTail(sessionId: string): Promise<void> {
    if (!await recoverSessionTail(this.#filePath(sessionId))) return;
    this.#outputReferences.delete(sessionId);
    this.#dropSearchCache(this.#filePath(sessionId));
  }

  #filePath(sessionId: string): string {
    return path.join(this.#directory, `${sessionId}.jsonl`);
  }

  async #searchProjection(filePath: string, signal?: AbortSignal): Promise<SessionSearchProjection> {
    const stat = await fs.stat(filePath);
    const cached = this.#searchCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      this.#searchCache.delete(filePath);
      this.#searchCache.set(filePath, cached);
      this.performanceTrace.increment("session_search_cache_hit");
      return cached.projection;
    }
    if (cached) this.#dropSearchCache(filePath);
    this.performanceTrace.increment("session_search_cache_miss");
    const projection = await readSearchProjection(filePath, this.performanceTrace, signal);
    signal?.throwIfAborted();
    const finalStat = await fs.stat(filePath);
    const bytes = Buffer.byteLength(JSON.stringify(projection), "utf8");
    if (bytes <= MAX_SEARCH_CACHE_BYTES && finalStat.size === stat.size && finalStat.mtimeMs === stat.mtimeMs) {
      const value = { size: finalStat.size, mtimeMs: finalStat.mtimeMs, bytes, projection };
      this.#searchCache.set(filePath, value);
      this.#searchCacheBytes += bytes;
      while (this.#searchCacheBytes > MAX_SEARCH_CACHE_BYTES) {
        const oldest = this.#searchCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#dropSearchCache(oldest);
      }
    }
    return projection;
  }

  #dropSearchCache(filePath: string): void {
    const cached = this.#searchCache.get(filePath);
    if (!cached) return;
    this.#searchCache.delete(filePath);
    this.#searchCacheBytes = Math.max(0, this.#searchCacheBytes - cached.bytes);
  }

  #assertSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error("Invalid session ID");
    }
  }
}
