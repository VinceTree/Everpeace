import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCommandRecord, type CommandRecord } from "../tools/command-record.js";
import {
  applyUsageSample,
  createEmptySessionUsage,
  isStatusSnapshot,
  isTokenUsageSample,
  resetContextUsage,
  type SessionUsage,
  type StatusSnapshot,
  type TokenUsageSample,
} from "../status/model-status.js";

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
}

export interface LoadedSession {
  summary: SessionSummary;
  timeline: StoredTimelineEntry[];
  context: Array<Record<string, unknown>>;
  usage: SessionUsage;
  goal?: SessionGoal;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  skipped: number;
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
  load(sessionId: string): Promise<LoadedSession>;
  setGoal(sessionId: string, goal: SessionGoal): Promise<void>;
  updateGoal(sessionId: string, patch: Partial<Pick<SessionGoal, "status" | "tokens_used" | "usage_complete" | "time_used_seconds" | "blocked_streak" | "updated_at">>): Promise<void>;
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

type SessionEvent =
  | SessionCreatedEvent
  | TitleUpdatedEvent
  | TimelineEntryEvent
  | ContextAppendEvent
  | ModelSelectedEvent
  | UsageRecordedEvent
  | GoalUpdatedEvent;

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
    const root = env.APPDATA?.trim() || path.join(homeDirectory, "AppData", "Roaming");
    return path.join(root, "Everpeace", "sessions");
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
  for (const event of events.slice(1)) {
    updatedAt = event.at;
    if (event.type === "title_updated") {
      title = event.title;
      titlePending = false;
    }
    if (event.type === "timeline_entry") timeline.push(event.entry);
    if (event.type === "context_append") context.push(...event.items);
    if (event.type === "model_selected") {
      model = event.model;
      if (!event.preserve_context) context = [];
      usage = resetContextUsage(usage, event.preserve_context);
    }
    if (event.type === "usage_recorded") {
      usage = applyUsageSample(usage, event.usage);
    }
    if (event.type === "goal_updated") goal = { ...event.goal };
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
    },
    timeline,
    context,
    usage,
    ...(goal ? { goal } : {}),
  };
}

function modelRef(model: SessionModelRef): SessionModelRef {
  return { id: model.id, model_name: model.model_name, base_url: model.base_url };
}

export class SessionStore implements SessionStoreLike {
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #writeQueues = new Map<string, Promise<void>>();

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
    const serialized = `${JSON.stringify(event)}\n`;
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

  #assertSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error("Invalid session ID");
    }
  }
}
