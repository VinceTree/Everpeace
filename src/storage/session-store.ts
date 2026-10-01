import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
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
import type { VerificationSuiteResult, WorkflowPhase, WorkflowState, VerificationResult } from "../workflow/types.js";
import type { LearnedMemoryPolicy } from "../memory/learned-memory.js";
import { isModelRequestSettings, type ModelRequestSettings } from "../providers/capabilities.js";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";
import { cloneTaskProgress, isTaskProgress, type TaskProgress } from "../workflow/task-progress.js";

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

export interface SessionSummary {
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
}

export interface LoadedSession {
  summary: SessionSummary;
  timeline: StoredTimelineEntry[];
  context: Array<Record<string, unknown>>;
  usage: SessionUsage;
  goal?: SessionGoal;
  workflow?: WorkflowState;
  taskProgress?: TaskProgress;
  memoryPolicy?: LearnedMemoryPolicy;
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

export interface SessionStoreLike {
  create(input: CreateSessionInput): Promise<SessionSummary>;
  updateTitle(sessionId: string, title: string): Promise<void>;
  appendTimeline(sessionId: string, entry: StoredTimelineEntry): Promise<void>;
  appendContext(
    sessionId: string,
    items: readonly Record<string, unknown>[],
  ): Promise<void>;
  compactContext(
    sessionId: string,
    items: readonly Record<string, unknown>[],
    automatic: boolean,
    usage: TokenUsageSample | null,
  ): Promise<void>;
  appendUsage(
    sessionId: string,
    usage: TokenUsageSample | null,
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
  setWorkflow?(sessionId: string, workflow: WorkflowState): Promise<void>;
  setTaskProgress?(sessionId: string, progress: TaskProgress): Promise<void>;
  setMemoryPolicy?(sessionId: string, policy: LearnedMemoryPolicy): Promise<void>;
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
}

interface ContextCompactedEvent extends EventBase {
  type: "context_compacted";
  items: Array<Record<string, unknown>>;
  automatic: boolean;
  usage: TokenUsageSample | null;
}

interface ModelSelectedEvent extends EventBase {
  type: "model_selected";
  model: SessionModelRef;
  preserve_context: boolean;
}

interface UsageRecordedEvent extends EventBase {
  type: "usage_recorded";
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

type SessionEvent =
  | SessionCreatedEvent
  | TitleUpdatedEvent
  | TimelineEntryEvent
  | ContextAppendEvent
  | ContextCompactedEvent
  | ModelSelectedEvent
  | UsageRecordedEvent
  | GoalUpdatedEvent
  | WorkflowUpdatedEvent
  | TaskProgressUpdatedEvent
  | MemoryPolicyUpdatedEvent;

export interface SessionStoreOptions {
  directory?: string;
  now?: () => Date;
  createId?: () => string;
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
  );
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
  if (value.type === "session_created") {
    if (
      !isNonEmptyString(value.session_id) ||
      !isNonEmptyString(value.title) ||
      !isNonEmptyString(value.workspace_path) ||
      !isModelRef(value.model)
    ) {
      throw new Error("Session header is invalid");
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
    return { ...base, type: "context_append", items: value.items };
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
    return { ...base, type: "usage_recorded", usage: value.usage };
  }

  if (value.type === "goal_updated") {
    if (!isGoal(value.goal)) throw new Error("Session goal is invalid");
    return { ...base, type: "goal_updated", goal: value.goal };
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

  throw new Error(`Unsupported session event type: ${value.type}`);
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "blocked" || value === "complete" || value === "budget_limited" || value === "usage_limited";
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
    (value.error === undefined || typeof value.error === "string");
}

function isVerificationSuite(value: unknown): value is VerificationSuiteResult {
  if (!isRecord(value)) return false;
  return (value.status === "passed" || value.status === "failed" || value.status === "unavailable") &&
    Array.isArray(value.results) && value.results.every(isVerificationResult) &&
    Array.isArray(value.skipped) && value.skipped.every((command) => isRecord(command) &&
      typeof command.id === "string" && typeof command.label === "string" && typeof command.command === "string" &&
      (command.tier === "fast" || command.tier === "full") && typeof command.timeoutMs === "number") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.stale === undefined || typeof value.stale === "boolean");
}

function isWorkflow(value: unknown): value is WorkflowState {
  if (!isRecord(value)) return false;
  const phases: WorkflowPhase[] = ["understand", "plan", "implement", "verify_fast", "diagnose", "verify_full", "review", "done", "blocked"];
  return typeof value.task_id === "string" && phases.includes(value.phase as WorkflowPhase) &&
    (value.task_source === undefined || value.task_source === "user" || value.task_source === "goal_continuation" || value.task_source === "session_resume" || value.task_source === "benchmark") &&
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
      },
    }),
  };
}

function parseSession(contents: string, filePath: string): LoadedSession {
  const hasIncompleteTail = contents.length > 0 && !contents.endsWith("\n");
  const rawLines = contents.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();

  const events: SessionEvent[] = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index]!;
    if (!line.trim()) continue;
    try {
      events.push(parseEvent(JSON.parse(line)));
    } catch (error) {
      if (hasIncompleteTail && index === rawLines.length - 1) break;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid session JSONL at ${filePath}:${index + 1}: ${reason}`);
    }
  }

  const header = events[0];
  if (header?.type !== "session_created") {
    throw new Error(`Session file has no valid header: ${filePath}`);
  }

  let title = header.title;
  let titlePending = header.title_pending;
  let model = header.model;
  let updatedAt = header.at;
  const timeline: StoredTimelineEntry[] = [];
  let context: Array<Record<string, unknown>> = [];
  let usage = createEmptySessionUsage(header.usage_tracking);

  let goal: SessionGoal | undefined;
  let workflow: WorkflowState | undefined;
  let taskProgress: TaskProgress | undefined;
  let memoryPolicy: LearnedMemoryPolicy | undefined;
  for (const event of events.slice(1)) {
    updatedAt = event.at;
    if (event.type === "title_updated") {
      title = event.title;
      titlePending = false;
    }
    if (event.type === "timeline_entry") timeline.push(event.entry);
    if (event.type === "context_append") context.push(...event.items);
    if (event.type === "context_compacted") {
      context = event.items.map((item) => ({ ...item }));
      usage = applyCompactionUsage(usage, event.usage);
    }
    if (event.type === "model_selected") {
      model = event.model;
      if (!event.preserve_context) context = [];
      usage = resetContextUsage(usage, event.preserve_context);
    }
    if (event.type === "usage_recorded") {
      usage = applyUsageSample(usage, event.usage);
    }
    if (event.type === "goal_updated") goal = { ...event.goal };
    if (event.type === "workflow_updated") workflow = { ...event.workflow, changed_paths: [...event.workflow.changed_paths] };
    if (event.type === "task_progress_updated") taskProgress = cloneTaskProgress(event.progress);
    if (event.type === "memory_policy_updated") memoryPolicy = { ...event.policy };
  }

  return {
    summary: {
      id: header.session_id,
      title,
      title_pending: titlePending,
      created_at: header.at,
      updated_at: updatedAt,
      workspace_path: header.workspace_path,
      model,
      ...(goal ? { goal } : {}),
      ...(workflow ? { workflow } : {}),
      ...(taskProgress ? { task_progress: cloneTaskProgress(taskProgress) } : {}),
      ...(memoryPolicy ? { memory_policy: memoryPolicy } : {}),
    },
    timeline,
    context,
    usage,
    ...(goal ? { goal } : {}),
    ...(workflow ? { workflow } : {}),
    ...(taskProgress ? { taskProgress: cloneTaskProgress(taskProgress) } : {}),
    ...(memoryPolicy ? { memoryPolicy } : {}),
  };
}

function modelRef(model: SessionModelRef): SessionModelRef {
  return {
    id: model.id,
    model_name: model.model_name,
    base_url: model.base_url,
    ...(model.request_settings ? { request_settings: { ...model.request_settings } } : {}),
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

const MAX_SEARCH_CACHE_BYTES = 16 * 1024 * 1024;

async function fileEndsWithNewline(filePath: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  const handle = await fs.open(filePath, "r");
  try {
    const value = Buffer.alloc(1);
    await handle.read(value, 0, 1, size - 1);
    return value[0] === 10;
  } finally {
    await handle.close();
  }
}

async function readSearchProjection(filePath: string, signal?: AbortSignal): Promise<SessionSearchProjection> {
  signal?.throwIfAborted();
  const stat = await fs.stat(filePath);
  const terminated = await fileEndsWithNewline(filePath, stat.size);
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let pending: string | undefined;
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
    if (event.type === "workflow_updated") workflow = { ...event.workflow, changed_paths: [...event.workflow.changed_paths] };
    if (event.type === "task_progress_updated") taskProgress = cloneTaskProgress(event.progress);
    if (event.type === "memory_policy_updated") memoryPolicy = { ...event.policy };
  };

  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      if (pending !== undefined) processLine(pending, false);
      pending = line;
    }
    if (pending !== undefined) processLine(pending, !terminated);
  } finally {
    lines.close();
    input.destroy();
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
      ...(goal ? { goal } : {}),
      ...(workflow ? { workflow } : {}),
      ...(taskProgress ? { task_progress: cloneTaskProgress(taskProgress) } : {}),
      ...(memoryPolicy ? { memory_policy: memoryPolicy } : {}),
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

function normalizeSessionWorkspacePath(value: string): string {
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(value)) {
    return path.win32.normalize(value).replace(/[\\/]+$/u, "").toLowerCase();
  }
  return normalizeWorkspacePath(value);
}

export class SessionStore implements SessionStoreLike {
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #writeQueues = new Map<string, Promise<void>>();
  readonly #deletedSessionIds = new Set<string>();
  readonly #searchCache = new Map<string, CachedSearchProjection>();
  #searchCacheBytes = 0;

  constructor(options: SessionStoreOptions = {}) {
    this.#directory = options.directory ?? defaultSessionDirectory();
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  get directory(): string {
    return this.#directory;
  }

  async create(input: CreateSessionInput): Promise<SessionSummary> {
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

  appendUsage(
    sessionId: string,
    usage: TokenUsageSample | null,
  ): Promise<void> {
    return this.#append(sessionId, {
      version: SESSION_FORMAT_VERSION,
      type: "usage_recorded",
      at: this.#now().toISOString(),
      usage: usage === null ? null : { ...usage },
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

  async list(): Promise<SessionListResult> {
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
        const contents = await fs.readFile(path.join(this.#directory, entry.name), "utf8");
        sessions.push(parseSession(contents, entry.name).summary);
      } catch {
        skipped += 1;
      }
    }

    sessions.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return { sessions, skipped };
  }

  async search(options: SessionSearchOptions): Promise<SessionSearchResult> {
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
          summary: projection.summary,
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

  async deleteMany(sessionIds: readonly string[]): Promise<void> {
    const uniqueIds = [...new Set(sessionIds)];
    uniqueIds.forEach((sessionId) => this.#assertSessionId(sessionId));
    uniqueIds.forEach((sessionId) => {
      this.#deletedSessionIds.add(sessionId);
      this.#dropSearchCache(this.#filePath(sessionId));
    });
    await Promise.all(uniqueIds.map((sessionId) => {
      const previous = this.#writeQueues.get(sessionId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() => fs.rm(this.#filePath(sessionId), { force: true }));
      this.#writeQueues.set(sessionId, next);
      void next.finally(() => {
        if (this.#writeQueues.get(sessionId) === next) this.#writeQueues.delete(sessionId);
      }).catch(() => undefined);
      return next;
    }));
  }

  async load(sessionId: string): Promise<LoadedSession> {
    this.#assertSessionId(sessionId);
    const pending = this.#writeQueues.get(sessionId);
    if (pending) await pending;
    return parseSession(
      await fs.readFile(this.#filePath(sessionId), "utf8"),
      this.#filePath(sessionId),
    );
  }

  #append(sessionId: string, event: SessionEvent): Promise<void> {
    this.#assertSessionId(sessionId);
    if (this.#deletedSessionIds.has(sessionId)) {
      return Promise.reject(new Error("Session has been deleted"));
    }
    const serialized = `${JSON.stringify(event)}\n`;
    this.#dropSearchCache(this.#filePath(sessionId));
    const previous = this.#writeQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => fs.appendFile(this.#filePath(sessionId), serialized, {
        encoding: "utf8",
        mode: 0o600,
      }));
    this.#writeQueues.set(sessionId, next);
    void next.finally(() => {
      if (this.#writeQueues.get(sessionId) === next) this.#writeQueues.delete(sessionId);
    }).catch(() => undefined);
    return next;
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
      return cached.projection;
    }
    if (cached) this.#dropSearchCache(filePath);
    const projection = await readSearchProjection(filePath, signal);
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
