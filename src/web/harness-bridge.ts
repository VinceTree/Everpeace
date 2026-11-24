import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { isInputImageReference } from "../agent/input-images.js";
import { parseGoalCommand, validGoalRoundLimit } from "../goal/runtime.js";
import type { UiLanguage } from "../localization/language.js";
import { uiText } from "../localization/messages.js";
import { MAX_WEB_INPUT_TEXT } from "../storage/web-inbox.js";
import { isWebPermissionMode, webPermissionMode, type WebPermissionMode } from "../permissions/policy.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";
import type { WebInboxMessage, WebMessage, WebModel, WebSession, WebSessionActivity, WebState, WebTurn } from "./protocol.js";
import { emptySidebar, isSettingsNamespace, settingChange, SettingsRevisionConflict, type HarnessPreferences, type WorkspaceSidebar } from "./harness-preferences.js";
import { HarnessFiles, workspaceFileEndpoints } from "./harness-files.js";
import { DEFAULT_GOAL_ROUNDS, goalActivation, goalProjection, goalView } from "./harness-goals.js";
import { HarnessInput } from "./harness-input.js";
import { harnessCommandNames, WebRequestError, type WebGoalAction, type WebGoalRef, type WebWorkbench } from "./workbench.js";
import { sensitivePath } from "../permissions/sensitive-access.js";
import { HarnessSchedule } from "./harness-schedule.js";
import { HarnessPluginManager } from "./harness-plugins.js";
import path from "node:path";

type WireRecord = {
  type: "event";
  event: { seq: number; time: number; type: string; data: object; surfaceOp?: "append" };
};

const planReviewId = "plan-review";
const approvePlan = "Approve";
const keepPlanning = "Keep planning";
const permissionModes = ["read-only", "ask", "workspace-write"] as const;

type TurnEndReason = { kind: "completed" | "blocked" } |
  { kind: "aborted"; reason: { kind: "user" } } |
  { kind: "error"; error: { code: string; message: string } };

function turnEndReason(outcome: WebMessage["webTurnOutcome"], recordedStart: boolean, language: UiLanguage): TurnEndReason {
  switch (outcome) {
    case "verified":
    case "no_changes":
    case "plan": return { kind: "completed" };
    case "cancelled": return { kind: "aborted", reason: { kind: "user" } };
    case undefined:
      if (!recordedStart) return { kind: "blocked" };
      break;
  }
  const code = outcome ?? "outcome_unknown";
  return {
    kind: "error",
    error: { code: code.toUpperCase(), message: uiText(`web.turn.${code}`, {}, language) },
  };
}

export function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebRequestError(400, "Expected an object");
  return value as Record<string, unknown>;
}

function wireArguments(payload: unknown): unknown[] {
  const { args } = inputRecord(payload);
  return Array.isArray(args) ? args : args === undefined ? [] : [args];
}

export function requestArguments(payload: unknown): Record<string, unknown> {
  const args = inputRecord(wireArguments(payload)[0] ?? {});
  return args.request === undefined ? args : inputRecord(args.request);
}

export function stringValue(request: Record<string, unknown>, property: string): string {
  const value = request[property];
  if (typeof value !== "string" || !value) throw new WebRequestError(400, `Expected ${property}`);
  return value;
}

function selection(model: WebModel) {
  return { provider: model.provider, model: model.id };
}

function selectionFor(state: WebState, session: WebSession, teamEnabled = false) {
  const model = state.models.find(item => item.id === session.modelId);
  const inbox = { "next-turn": [] as object[], "next-step": [] as object[] };
  for (const item of state.inboxes[session.id] ?? []) {
    inbox[item.placement].push({
      id: item.id, role: "user", source: { kind: "user", rpcId: item.requestId },
      content: userContent(item.text, item.files),
    });
  }
  const teamTasks = (session.team?.members ?? []).map((member, index) => ({
    id: member.taskId,
    revision: 1,
    subject: member.goal?.split(/\r?\n/u)[0]?.slice(0, 240) || `${member.role ?? "Team"} member ${index + 1}`,
    description: [member.acceptance, member.summary, member.verification].filter(Boolean).join("\n\n").slice(0, 16 * 1024),
    status: member.state === "completed" || member.state === "integrated" ? "completed" : member.state === "failed" || member.state === "cancelled" ? "deleted" : member.state === "running" ? "in_progress" : "pending",
    blockedBy: member.dependencies ?? [],
    writeScopes: member.paths ?? [],
    ownerId: member.agentId,
    ready: member.state === "queued" && (member.dependencies?.length ?? 0) === 0,
    writeScopeWarnings: [],
    ...(member.sessionId ? { sessionId: member.sessionId } : {}),
  }));
  return {
    modelSelection: model ? { next: selection(model) } : {},
    title: session.blank ? null : session.title,
    plan: { active: state.planSessions.includes(session.id), pending: false },
    permissions: { currentValue: webPermissionMode(state.permissionCap, session.permissionMode) },
    agentTeam: { enabled: teamEnabled || session.team !== undefined, tasks: teamTasks },
    goal: session.goal ? goalProjection(session.goal, session.goalRevision ?? 1, state.language) : null,
    inbox,
  };
}

function userContent(text: string, files: WebInboxMessage["files"] = []) {
  return [{ type: "text", text }, ...files.map(attachment => ({ type: isInputImageReference(attachment) ? "image" : "file", attachment }))];
}

function sessionSummary(session: WebSession, state: WebState) {
  return {
    sessionId: session.id,
    title: session.title || undefined,
    createdAt: Date.parse(session.createdAt),
    updatedAt: Date.parse(session.updatedAt),
    running: !!state.turns[session.id],
    blank: session.blank,
    cwd: state.workspace,
    agentAvailable: true,
  };
}

function workspaceView(state: WebState, sidebar: WorkspaceSidebar, workspaceId: string, registeredAt: string) {
  const known = new Set(state.sessions.map(session => session.id));
  const ordered = new Set(sidebar.orderedSessionIds.filter(id => known.has(id)));
  return {
    workspaceId, path: state.workspace, title: sidebar.title ?? (basename(state.workspace) || state.workspace),
    sessionIds: [...[...known].filter(id => !ordered.has(id)), ...ordered],
    createdAt: registeredAt,
    updatedAt: state.sessions[0]?.updatedAt ?? registeredAt,
  };
}

function modelCatalog(state: WebState, defaultModelId: string | null) {
  const groups = new Map<string, Array<{ id: string; name: string }>>();
  for (const model of state.models) {
    const item = { id: model.id, name: model.name };
    const group = groups.get(model.provider);
    if (group) group.push(item);
    else groups.set(model.provider, [item]);
  }
  const model = state.models.find(item => item.id === defaultModelId);
  return {
    default: model ? selection(model) : { provider: "Everpeace", model: "unconfigured" },
    routableProviders: [...groups.keys()],
    groups: [...groups].map(([id, models]) => ({ id, name: id, models })),
    failures: [],
  };
}

class SessionJournal {
  readonly records: WireRecord[] = [];
  readonly forkAnchors = new Map<number, number>();
  turn = -1;
  step = 0;
  #turnOpen = false;
  #stepOpen = false;
  #position = 0;
  #wasRunning = false;
  #recordedStart = false;

  constructor(readonly session: WebSession, readonly language: UiLanguage) {}

  get cursor() { return this.records.length - 1; }

  #message(type: string, data: object, time: number, append = false) {
    this.records.push({
      type: "event",
      event: { seq: this.records.length, time, type, data, ...(append ? { surfaceOp: "append" } : {}) },
    });
  }

  #startTurn(time: number, recordedStart = false) {
    this.turn += 1;
    this.step = 0;
    this.#turnOpen = true;
    this.#recordedStart = recordedStart;
    this.#message("turn/start", { turn: this.turn }, time);
  }

  #startStep(time: number) {
    if (!this.#turnOpen) this.#startTurn(time);
    if (this.#stepOpen) return;
    this.#stepOpen = true;
    this.#message("step/start", { turn: this.turn, step: this.step }, time);
  }

  #endStep(time: number) {
    if (!this.#stepOpen) return;
    this.#message("step/end", { turn: this.turn, step: this.step++ }, time);
    this.#stepOpen = false;
  }

  #endTurn(time: number, outcome?: WebMessage["webTurnOutcome"]) {
    if (!this.#turnOpen) return;
    this.#endStep(time);
    const reason = turnEndReason(outcome, this.#recordedStart, this.language);
    this.#message("turn/end", { turn: this.turn, reason }, time);
    this.forkAnchors.set(this.cursor, outcome === undefined ? this.#position - 1 : this.#position);
    this.#turnOpen = false;
  }

  ingest(timeline: readonly WebMessage[], turn: WebTurn | null): WireRecord[] {
    const from = this.records.length;
    const time = turn || this.#wasRunning ? Date.now() : Date.parse(this.session.updatedAt);
    this.#wasRunning = !!turn;
    for (; this.#position < timeline.length; this.#position += 1) {
      const entry = timeline[this.#position]!;
      const id = `${this.session.id}:${String(this.#position)}`;
      const content = [{ type: "text", text: entry.text }];
      if (entry.webTurnOutcome) {
        // Admission stays busy until the workbench has refreshed its durable picker.
        if (turn && this.#position >= timeline.length - turn.entries.length) break;
        this.#endTurn(time, entry.webTurnOutcome);
      } else if (entry.webSkillName && this.#turnOpen) {
        this.#message("user/message", {
          id, role: "user", source: { kind: "skill-invocation", name: entry.webSkillName, form: "instructions" },
          content: [{ type: "text", text: entry.webSkillName }],
        }, time, true);
      } else if (entry.kind === "user") {
        if (!entry.webInput || entry.webTurnStarted || !this.#turnOpen) {
          this.#endTurn(time);
          this.#startTurn(time, entry.webTurnStarted);
        } else this.#endStep(time);
        this.#startStep(time);
        const source = { kind: "user", ...(entry.webInput ? { rpcId: entry.webInput.requestId } : {}) };
        this.#message("user/message", {
          id: entry.webInput?.id ?? id, role: "user", source, content: userContent(entry.text, entry.files),
        }, time, true);
      } else if (entry.kind === "assistant") {
        this.#startStep(time);
        this.#message("assistant/message", {
          turn: this.turn, step: this.step,
          message: { id, role: "assistant", content, source: { kind: "model", provider: "Everpeace", model: this.session.modelId } },
          stream: [{ type: "chunk", time, chunk: { type: "finish", reason: { kind: "stop" } } }],
        }, time, true);
        this.#endStep(time);
      } else if (entry.plan) {
        this.#startStep(time);
        const { callId, phase } = entry.plan;
        if (phase === "submitted") {
          this.#message("tool/call", {
            turn: this.turn, step: this.step, callId, name: "exit_plan_mode",
            arguments: JSON.stringify({ plan: entry.text }),
          }, time);
        } else {
          this.#message("tool/result", {
            turn: this.turn, step: this.step,
            message: {
              id: `${callId}:result`, role: "tool", toolCallId: callId,
              source: { kind: "tool", callId }, content,
            },
          }, time, true);
          this.#endStep(time);
        }
      } else if (entry.kind === "tool") {
        this.#startStep(time);
        const separator = entry.text.indexOf("\n");
        const name = separator < 0 ? entry.text : entry.text.slice(0, separator);
        const output = separator < 0 ? "" : entry.text.slice(separator + 1);
        this.#message("tool/call", { turn: this.turn, step: this.step, callId: id, name, arguments: "{}" }, time);
        this.#message("tool/result", {
          turn: this.turn, step: this.step,
          message: {
            id: `${id}:result`, role: "tool", toolCallId: id,
            source: { kind: "tool", callId: id }, content: [{ type: "text", text: output }],
          },
        }, time, true);
        this.#endStep(time);
      }
    }
    if (turn?.delta && this.#turnOpen) this.#startStep(time);
    if (!turn) this.#endTurn(time);
    return this.records.slice(from);
  }
}

class AssistantDelivery {
  #revision = 0;
  #active: { id: string; count: number; text: string } | undefined;

  constructor(readonly write: (frame: unknown) => void) {}

  #emit(type: string, attemptId: string, details: object) {
    this.write({ type: "assistant-stream", frame: { type, attemptId, revision: ++this.#revision, ...details } });
  }

  update(state: WebTurn | null, journal: SessionJournal, committed: WireRecord | undefined): void {
    let active = this.#active;
    const delta = state?.delta ?? "";
    if (active && (!delta || !delta.startsWith(active.text) || committed)) {
      this.#emit("end", active.id, {
        index: active.count,
        outcome: committed
          ? { kind: "committed", eventType: "assistant/message", seq: committed.event.seq }
          : { kind: "abandoned" },
      });
      active = this.#active = undefined;
    }
    if (!delta || delta === active?.text) return;
    if (!active) {
      if (journal.turn < 0) return;
      active = this.#active = { id: randomUUID(), count: 0, text: "" };
      this.#emit("start", active.id, { startedAfterSeq: journal.cursor, turn: journal.turn, step: journal.step });
      this.#emit("chunk", active.id, {
        index: active.count++, time: Date.now(), chunk: { type: "block-start", index: 0, blockType: "text" },
      });
    }
    this.#emit("chunk", active.id, {
      index: active.count++, time: Date.now(), chunk: { type: "text-delta", index: 0, text: delta.slice(active.text.length) },
    });
    active.text = delta;
  }
}

/** Decode the published upstream client's logical RPC calls into Everpeace operations. */
export class HarnessBridge {
  readonly #submissions = new Map<string, Promise<void>>();
  readonly #eventClients = new Map<string, { signal: AbortSignal; delivered: Map<string, string> }>();
  readonly #settingsListeners = new Set<() => void>();
  readonly #workspaceListeners = new Set<() => void>();
  readonly #journals = new WeakMap<AbortSignal, Set<SessionJournal>>();
  readonly #files: HarnessFiles;
  readonly #input: HarnessInput;
  readonly #schedule: HarnessSchedule;
  readonly #plugins: HarnessPluginManager;
  #sidebar = emptySidebar();
  constructor(
    readonly workbench: WebWorkbench,
    readonly preferences: HarnessPreferences,
    public workspaceId: string,
    public registeredAt: string,
    private readonly projection: { cursor: number },
    private readonly settingsCap: () => Promise<WebPermissionMode>,
  ) {
    this.#files = new HarnessFiles(workbench);
    this.#input = new HarnessInput(workbench);
    this.#schedule = new HarnessSchedule({
      hasSession: id => workbench.hasSession(id),
      startSession: (id, prompt) => workbench.startSession(id, prompt),
      enqueueSession: (id, prompt) => workbench.submit(id, randomUUID(), prompt, {}, false),
    }, path.dirname(preferences.sidebar.path), workbench.workspace);
    this.#plugins = new HarnessPluginManager(path.dirname(preferences.sidebar.path), workbench.workspace);
  }

  async initialize() { this.#sidebar = await this.preferences.sidebar.read(); await this.#schedule.initialize(); }

  close(): void { this.#schedule.close(); }

  async #scheduleCall<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { throw new WebRequestError(400, error instanceof Error ? error.message : "Invalid automation task", "schedule/input-invalid"); }
  }

  async #pluginCall<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { throw new WebRequestError(400, error instanceof Error ? error.message : "Invalid plugin operation", "plugin/input-invalid"); }
  }

  workspaceState() {
    const workspace = workspaceView(this.workbench.snapshot(), this.#sidebar, this.workspaceId, this.registeredAt);
    const known = new Set(workspace.sessionIds);
    return {
      workspace,
      archivedSessionIds: this.#sidebar.archivedSessionIds.filter(id => known.has(id)),
      pinnedSessionIds: this.#sidebar.pinnedSessionIds.filter(id => known.has(id)),
    };
  }

  sessionSummaries() {
    const state = this.workbench.snapshot();
    return state.sessions.map(session => sessionSummary(session, state));
  }

  hasPendingEvent(id: string): boolean {
    return Object.values(this.workbench.snapshot().turns).some(turn => turn.interaction?.id === id);
  }

  watchWorkspace(publish: () => void): () => void {
    const unsubscribe = this.workbench.subscribe(event => { if ("state" in event) publish(); });
    this.#workspaceListeners.add(publish);
    return () => { this.#workspaceListeners.delete(publish); unsubscribe(); };
  }

  watchSettings(publish: () => void): () => void {
    this.#settingsListeners.add(publish);
    return () => { this.#settingsListeners.delete(publish); };
  }

  uploadFile(params: URLSearchParams, bytes: Uint8Array, signal?: AbortSignal) {
    const sessionId = params.get("sessionId");
    if (typeof sessionId === "string") this.#requireUnarchived(sessionId);
    return this.#input.stage(sessionId, params.get("name") ?? undefined, bytes, params.get("mediaType") ?? undefined, signal);
  }

  #requireUnarchived(sessionId: string) {
    if (this.#sidebar.archivedSessionIds.includes(sessionId)) throw new WebRequestError(409, "Restore the archived session first");
  }

  async #updateSidebar(change: (current: WorkspaceSidebar) => WorkspaceSidebar): Promise<WorkspaceSidebar> {
    this.#sidebar = await this.preferences.sidebar.update(change);
    for (const notify of this.#workspaceListeners) notify();
    return this.#sidebar;
  }

  async #setSessionMembership(sessionId: string, member: "pinnedSessionIds" | "archivedSessionIds", include: boolean) {
    this.workbench.requireSession(sessionId);
    const next = await this.#updateSidebar(current => {
      const rest = current[member].filter(id => id !== sessionId);
      return { ...current, [member]: include ? [sessionId, ...rest] : rest };
    });
    return { [member]: next[member] };
  }

  async #mutateSettings(payload: unknown) {
    const [first, positionalOps, positionalRevision] = wireArguments(payload);
    const { ns: namespace, ops: operations, expectedRevision: revision } = typeof first === "string"
      ? { ns: first, ops: positionalOps, expectedRevision: positionalRevision }
      : requestArguments(payload);
    if (!isSettingsNamespace(namespace) || !Array.isArray(operations) || operations.length === 0 || operations.length > 12 ||
        revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
      throw new WebRequestError(400, "Invalid browser settings update");
    }
    const changes = operations.map(operation => {
      const change = settingChange(namespace, operation);
      if (!change) throw new WebRequestError(400, "Unsupported setting or value");
      return change;
    });
    const cap = namespace === "permission" ? await this.settingsCap() : this.workbench.snapshot().permissionCap;
    if (namespace === "permission" && changes.some(change => change.operation === "set"
      && isWebPermissionMode(change.value) && webPermissionMode(cap, change.value) !== change.value)) {
      throw new WebRequestError(403, "The workspace policy limits this permission preset", "permission/preset-unavailable");
    }
    const result = await this.preferences.mutate(namespace, changes, cap, revision).catch(error => {
      if (error instanceof SettingsRevisionConflict) throw new WebRequestError(409, "Settings changed");
      throw error;
    });
    for (const notify of this.#settingsListeners) notify();
    return result;
  }

  async #executeCommand(args: Record<string, unknown>, signal?: AbortSignal) {
    const match = /^\/([^\s]+)(?:\s+(.*))?$/su.exec(stringValue(args, "line").trim());
    if (!match?.[1] || !harnessCommandNames.has(match[1])) return undefined;
    const sessionId = stringValue(args, "agentId");
    this.#requireUnarchived(sessionId);
    const message = match[2]?.trim() ?? "";
    const attachments = args.submittedAttachments ?? [];
    if (!Array.isArray(attachments)) throw new WebRequestError(400, "Invalid command attachments");
    const commandId = randomUUID();
    if (match[1] === "goal") {
      const result = await this.#executeGoalCommand(sessionId, message, attachments, signal);
      return { commandId, result };
    }
    if (match[1] === "permission") {
      if (attachments.length) throw new WebRequestError(400, "Permission selection does not accept attachments");
      if (message) await this.#selectPermission(sessionId, message, signal);
      return { commandId, result: { kind: "success" } };
    }
    if (message === "off" && attachments.length) {
      return { commandId, result: { kind: "error", text: "Remove attachments before leaving plan mode." } };
    }
    if (message === "off" || message === "" && !attachments.length) {
      signal?.throwIfAborted();
      this.workbench.setPlanMode(sessionId, message !== "off");
    } else {
      const { prompt, data, accept } = await this.#input.prepare(sessionId, [{ type: "text", text: message }, ...attachments], signal);
      this.#requireUnarchived(sessionId);
      signal?.throwIfAborted();
      await accept(() => this.workbench.startSession(sessionId, prompt, data, true));
    }
    return { commandId, result: { kind: "success" } };
  }

  async #executeGoalCommand(sessionId: string, text: string, attachments: unknown[], signal?: AbortSignal) {
    const language = this.workbench.snapshot().language;
    const roundOption = /(?:^|\s)--rounds\s+(\d+)\s*$/iu.exec(text);
    const maxGoalRounds = roundOption ? Number(roundOption[1]) : undefined;
    if (maxGoalRounds !== undefined && !validGoalRoundLimit(maxGoalRounds)) throw new WebRequestError(400, "Invalid Goal round limit");
    const line = roundOption ? text.slice(0, roundOption.index).trim() : text;
    if (/^edit(?:\s|$)/iu.test(line)) {
      const objective = line.slice(4).trim();
      if ((!objective && maxGoalRounds === undefined) || attachments.length) throw new WebRequestError(400, "Enter a new Goal objective or round limit");
      await this.workbench.changeGoal(sessionId, {
        kind: "edit", ...(objective ? { objective } : {}), ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
      }, undefined, undefined, signal);
      return { kind: "success" };
    }
    if (line.toLowerCase() === "clear") {
      if (attachments.length || maxGoalRounds !== undefined) throw new WebRequestError(400, "Goal clear takes no arguments");
      const { session } = await this.workbench.readSession(sessionId);
      if (session.goal) await this.workbench.changeGoal(sessionId, { kind: "clear" }, undefined, undefined, signal);
      return { kind: "success" };
    }
    const command = parseGoalCommand(line);
    if (command.action !== "create" && maxGoalRounds !== undefined) throw new WebRequestError(400, "The round limit accompanies a new or edited Goal");
    if (command.action !== "create" && attachments.length) throw new WebRequestError(400, "Goal attachments accompany a new objective");
    if (command.action === "status") {
      const { session } = await this.workbench.readSession(sessionId);
      const goal = goalView(this.workbench.snapshot(), session);
      return { kind: "success", text: goal
        ? uiText("web.goal.status", { p0: goal.objective, p1: goal.roundsStarted, p2: goal.maxGoalRounds }, language)
        : uiText("web.goal.empty", {}, language) };
    }
    if (command.action === "pause" || command.action === "resume") {
      await this.workbench.changeGoal(sessionId, { kind: command.action }, undefined, undefined, signal);
      return { kind: "success" };
    }
    if (command.action !== "create") throw new WebRequestError(400, "Invalid Goal command");
    const { data, accept } = await this.#input.prepare(sessionId, [{ type: "text", text: command.objective }, ...attachments], signal);
    this.#requireUnarchived(sessionId);
    await accept(async () => {
      await this.workbench.changeGoal(sessionId, {
        kind: "create", objective: command.objective,
        maxGoalRounds: maxGoalRounds ?? DEFAULT_GOAL_ROUNDS,
        ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
      }, undefined, data, signal);
    });
    return { kind: "success" };
  }

  async #goalCall(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const sessionId = stringValue(args, "agentId");
    if (endpoint === "goals/get") {
      const { session } = await this.workbench.readSession(sessionId);
      return goalView(this.workbench.snapshot(), session);
    }
    this.#requireUnarchived(sessionId);
    let action: WebGoalAction;
    let ref: WebGoalRef | undefined;
    if (endpoint === "goals/create" || endpoint === "goals/edit") {
      const request = inputRecord(args.request);
      const { objective, maxGoalRounds } = request;
      if (objective !== undefined && (typeof objective !== "string" || !objective.trim() || objective.length > 4000) ||
          maxGoalRounds !== undefined && !validGoalRoundLimit(maxGoalRounds)) {
        throw new WebRequestError(400, "Invalid Goal objective or round limit");
      }
      if (endpoint === "goals/create") {
        action = { kind: "create", objective: stringValue(request, "objective"), maxGoalRounds: maxGoalRounds ?? DEFAULT_GOAL_ROUNDS };
      } else {
        if (objective === undefined && maxGoalRounds === undefined) throw new WebRequestError(400, "Enter a Goal change");
        action = { kind: "edit", ...(objective === undefined ? {} : { objective }), ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }) };
      }
    } else {
      const kind = endpoint.slice("goals/".length);
      if (kind !== "pause" && kind !== "resume" && kind !== "clear") throw new WebRequestError(404, "Unsupported Goal action");
      action = { kind };
    }
    if (action.kind !== "create") {
      const raw = inputRecord(args.ref);
      if (!validGoalRoundLimit(raw.revision)) throw new WebRequestError(400, "Invalid Goal revision");
      ref = { id: stringValue(raw, "id"), revision: raw.revision };
    }
    signal?.throwIfAborted();
    const result = await this.workbench.changeGoal(sessionId, action, ref, undefined, signal);
    const current = { id: result.id, revision: result.revision };
    if (action.kind === "create") return { ref: current };
    if (action.kind === "clear") return current;
    return goalView(this.workbench.snapshot(), this.workbench.requireSession(sessionId));
  }

  async #selectPermission(sessionId: string, preset: unknown, signal?: AbortSignal) {
    this.#requireUnarchived(sessionId);
    if (!isWebPermissionMode(preset)) throw new WebRequestError(400, "Unknown web permission preset", "permission/preset-unavailable");
    return { currentValue: await this.workbench.selectPermissionMode(sessionId, preset, signal) };
  }

  async #permissionCatalog() {
    const cap = await this.settingsCap();
    const { language } = this.workbench.snapshot();
    const options = permissionModes.filter(mode => webPermissionMode(cap, mode) === mode).map(value => ({
      value, name: uiText(`web.permission.${value}`, {}, language),
      description: uiText(`web.permission.${value}.detail`, {}, language),
    }));
    return { options, defaultOptions: options, defaultPreset: await this.preferences.permissionDefault(cap) };
  }

  async #submitPrompt(args: Record<string, unknown>, signal?: AbortSignal) {
    const sessionId = stringValue(args, "sessionId");
    this.#requireUnarchived(sessionId);
    const requestId = stringValue(args, "requestId");
    if (requestId.length > 128) throw new WebRequestError(400, "Invalid request ID");
    if (args.mode !== undefined && args.mode !== "queue" && args.mode !== "steer") throw new WebRequestError(400, "Invalid prompt mode");
    const key = JSON.stringify([sessionId, requestId]);
    let pending = this.#submissions.get(key);
    if (!pending) {
      pending = (async () => {
        if (await this.workbench.hasAcceptedPrompt(sessionId, requestId)) return;
        const { prompt, data, accept } = await this.#input.prepare(sessionId, args.content, signal);
        this.#requireUnarchived(sessionId);
        signal?.throwIfAborted();
        await accept(() => this.workbench.submit(sessionId, requestId, prompt, data, args.mode === "steer"));
      })();
      this.#submissions.set(key, pending);
    }
    try { await pending; }
    finally { if (this.#submissions.get(key) === pending) this.#submissions.delete(key); }
    return { accepted: true };
  }

  async #readEvents(args: Record<string, unknown>) {
    const address = inputRecord(args.address);
    if (address.kind !== "session") throw new WebRequestError(404, "Session history is unavailable");
    const id = stringValue(address, "sessionId");
    const { session, activity } = await this.workbench.inspectSession(id);
    const state = this.workbench.snapshot();
    const journal = new SessionJournal(session, state.language);
    journal.ingest(activity.timeline, activity.turn);
    const { throughSeq = journal.cursor, beforeSeq = journal.cursor + 1 } = args;
    if (typeof throughSeq !== "number" || !Number.isSafeInteger(throughSeq) || throughSeq < -1 ||
        typeof beforeSeq !== "number" || !Number.isSafeInteger(beforeSeq) || beforeSeq < 0) {
      throw new WebRequestError(400, "Invalid history page boundary");
    }
    const cursor = Math.min(throughSeq, journal.cursor);
    const end = Math.min(cursor + 1, beforeSeq);
    const start = Math.max(0, end - 128);
    return { cursor, records: journal.records.slice(start, end), hasMore: start > 0 };
  }

  async call(endpoint: string, payload: unknown, signal?: AbortSignal, connection?: AbortSignal): Promise<unknown> {
    const state = this.workbench.snapshot();
    if (endpoint === "settings/mutate") return this.#mutateSettings(payload);
    if (endpoint.startsWith("goals/")) return this.#goalCall(endpoint, inputRecord(wireArguments(payload)[0]), signal);
    if (workspaceFileEndpoints.has(endpoint)) return this.#files.call(endpoint, inputRecord(inputRecord(payload).args), signal);
    if (endpoint === "fileReferences/list" || endpoint === "sessionReferenceResolver/candidates" || endpoint === "fileUploads/upload") {
      const { agentId, query, request } = inputRecord(inputRecord(payload).args);
      if (endpoint === "fileReferences/list") return this.#files.references(agentId, query ?? "", signal);
      if (endpoint === "sessionReferenceResolver/candidates") return this.#input.sessionCandidates(agentId, query ?? "", signal);
      if (typeof agentId === "string") this.#requireUnarchived(agentId);
      return this.#input.stageEncoded(agentId, request);
    }
    const args = requestArguments(payload);
    switch (endpoint) {
      case "$events/result": {
        const clientId = stringValue(args, "clientId");
        const eventId = stringValue(args, "eventId");
        const client = this.#eventClients.get(clientId);
        const [sessionId, turn] = Object.entries(state.turns).find(([, turn]) => turn.interaction?.id === eventId) ?? [];
        const interaction = turn?.interaction;
        if (!sessionId || !turn || !interaction || client?.delivered.get(sessionId) !== eventId || connection !== client.signal) {
          throw new WebRequestError(409, "This request is no longer pending");
        }
        const outcome = inputRecord(args.outcome);
        if (outcome.kind === "next") return undefined;
        if (interaction.kind === "approval") {
          if (outcome.kind !== "result" || (outcome.value !== "allowed-once" && outcome.value !== "rejected")) {
            throw new WebRequestError(400, "Expected an approval decision");
          }
          this.workbench.answer(turn.id, interaction.id, outcome.value === "allowed-once");
        } else if (interaction.kind === "plan") {
          if (outcome.kind === "rejected" && inputRecord(outcome.error).code === "ASK_CANCELLED") {
            this.workbench.answer(turn.id, interaction.id, { decision: "cancel" });
            return undefined;
          }
          const { answers } = inputRecord(outcome.value);
          if (outcome.kind !== "result" || !Array.isArray(answers) || answers.length !== 1) throw new WebRequestError(400, "Expected a plan decision");
          const { id, selected, custom } = inputRecord(answers[0]);
          if (id !== planReviewId || !Array.isArray(selected) ||
              selected.length > 1 || selected.some(value => value !== approvePlan && value !== keepPlanning) ||
              selected[0] === approvePlan && custom !== undefined || !selected.length && typeof custom !== "string") {
            throw new WebRequestError(400, "Invalid plan decision");
          }
          this.workbench.answer(turn.id, interaction.id, {
            decision: selected[0] === approvePlan ? "approve" : "continue",
            ...(custom === undefined ? {} : { feedback: custom }),
          });
        } else {
          if (outcome.kind === "rejected" && inputRecord(outcome.error).code === "ASK_CANCELLED") {
            this.workbench.stop(turn.id);
            return undefined;
          }
          const { answers } = inputRecord(outcome.value);
          if (outcome.kind !== "result" || !Array.isArray(answers)) throw new WebRequestError(400, "Expected question answers");
          const values = new Map<string, string>();
          for (const answer of answers) {
            const { id, custom, selected } = inputRecord(answer);
            const value = typeof custom === "string" && custom.trim() ? custom : Array.isArray(selected) ? selected[0] : undefined;
            if (typeof id !== "string" || typeof value !== "string") throw new WebRequestError(400, "Invalid question answer");
            values.set(id, value);
          }
          this.workbench.answer(turn.id, interaction.id, Object.fromEntries(values));
        }
        return undefined;
      }
      case "workspace/rename": {
        const title = redactSecretsPreservingLayout(stringValue(args, "title")).trim().replace(/\s+/gu, " ");
        if (!title || title.length > 240) throw new WebRequestError(400, "Enter a workspace name up to 240 characters");
        const sidebar = await this.#updateSidebar(current => ({ ...current, title }));
        return { workspace: workspaceView(this.workbench.snapshot(), sidebar, this.workspaceId, this.registeredAt) };
      }
      case "workspace/pinSession":
      case "workspace/unpinSession":
        return this.#setSessionMembership(stringValue(args, "sessionId"), "pinnedSessionIds", endpoint === "workspace/pinSession");
      case "workspace/archiveSession": {
        const id = stringValue(args, "sessionId");
        return this.workbench.whileSessionIdle(id, args.stopActivity === true,
          () => this.#setSessionMembership(id, "archivedSessionIds", true));
      }
      case "workspace/unarchiveSession":
        return this.#setSessionMembership(stringValue(args, "sessionId"), "archivedSessionIds", false);
      case "workspace/insertSessionBefore": {
        const id = stringValue(args, "sessionId");
        const before = args.beforeSessionId === undefined ? undefined : stringValue(args, "beforeSessionId");
        this.workbench.requireSession(id);
        if (before !== undefined) this.workbench.requireSession(before);
        const sidebar = await this.#updateSidebar(current => {
          if (id === before) return current;
          const order = workspaceView(this.workbench.snapshot(), current, this.workspaceId, this.registeredAt).sessionIds.filter(item => item !== id);
          const index = before === undefined ? -1 : order.indexOf(before);
          order.splice(index < 0 ? order.length : index, 0, id);
          return { ...current, orderedSessionIds: order };
        });
        return { workspace: workspaceView(this.workbench.snapshot(), sidebar, this.workspaceId, this.registeredAt) };
      }
      case "settings/describe": return this.preferences.describe(await this.settingsCap());
      case "credentials/describe": return {};
      case "dynamicCordisRunner/syncInspectManifest": return null;
      case "dynamicCordisRunner/inventory": return [];
      case "permissionPresets/catalog": return this.#permissionCatalog();
      case "permissionPresets/set": return this.#selectPermission(stringValue(args, "sessionId"), args.preset, signal);
      case "agentTeams/setEnabled": {
        const sessionId = stringValue(args, "agentId");
        this.#requireUnarchived(sessionId);
        if (typeof args.enabled !== "boolean") throw new WebRequestError(400, "Expected enabled");
        await this.workbench.setTeamEnabled(sessionId, args.enabled);
        return undefined;
      }
      case "web/listProviders": return { search: [], fetch: [] };
      case "account/getProfile":
      case "account/getBalance":
      case "account/getNotifications": return null;
      case "schedule/catalog": return this.#scheduleCall(() => this.#schedule.catalog());
      case "schedule/list": return this.#scheduleCall(() => this.#schedule.list(args));
      case "schedule/view": return this.#scheduleCall(() => this.#schedule.view(stringValue(args, "id")));
      case "schedule/create": return this.#scheduleCall(() => this.#schedule.create(inputRecord(args.request ?? args)));
      case "schedule/edit": return this.#scheduleCall(() => this.#schedule.edit(inputRecord(args.request ?? args)));
      case "schedule/run": return this.#scheduleCall(() => this.#schedule.run(stringValue(args, "id")));
      case "schedule/deleteInactive": return this.#scheduleCall(() => this.#schedule.deleteInactive());
      case "schedule/deliveryLimits": return { newSessionIntervalSeconds: 0 };
      case "terminal/list": return [];
      case "pluginManager/listBundles": return this.#pluginCall(() => this.#plugins.listBundles());
      case "pluginManager/listPlugins": return this.#pluginCall(() => this.#plugins.listPlugins());
      case "pluginManager/setPluginEnabled": return this.#pluginCall(() => this.#plugins.setPluginEnabled(stringValue(args, "id"), args.enabled === true));
      case "pluginManager/setBundleEnabled": return this.#pluginCall(() => this.#plugins.setBundleEnabled(stringValue(args, "name"), args.enabled === true));
      case "pluginManager/removeBundle": return this.#pluginCall(() => this.#plugins.removeBundle(stringValue(args, "name")));
      case "pluginManager/inspect": return this.#pluginCall(() => this.#plugins.inspect(stringValue(args, "spec")));
      case "pluginManager/installBundle": return this.#pluginCall(() => this.#plugins.installBundle(stringValue(args, "spec"), args.options === undefined ? undefined : inputRecord(args.options)));
      case "pluginManager/readBundleDetail": return this.#pluginCall(() => this.#plugins.readBundleDetail(stringValue(args, "name")));
      case "pluginManager/updateBundle": return this.#pluginCall(() => this.#plugins.updateBundle(stringValue(args, "name")));
      case "pluginManager/setVersionExemption": return this.#pluginCall(() => this.#plugins.setVersionExemption(stringValue(args, "packageVersion"), stringValue(args, "runtimeVersion"), args.enabled === true, args.acceptRisk === true));
      case "pluginManager/cancelInstall": return this.#pluginCall(() => this.#plugins.cancelInstall());
      case "pluginManager/waitForInstall": return this.#pluginCall(() => this.#plugins.waitForInstall());
      case "pluginManager/listVersions": return [];
      case "pluginMarket/listIndexes": return this.#pluginCall(() => this.#plugins.listIndexes());
      case "pluginMarket/setIndexes": return this.#pluginCall(() => this.#plugins.setIndexes(args.indexes));
      case "pluginMarket/search": return this.#pluginCall(() => this.#plugins.searchMarket(stringValue(args, "url"), inputRecord(args.query)));
      case "pluginMarket/readEntryDetail": return this.#pluginCall(() => this.#plugins.readEntryDetail(stringValue(args, "url"), stringValue(args, "name")));
      case "pluginManager/registries": return this.#pluginCall(() => this.#plugins.registries());
      case "pluginManager/listVersionExemptions": return this.#pluginCall(() => this.#plugins.listVersionExemptions());
      case "pluginInventory/list": return this.#pluginCall(() => this.#plugins.inventory());
      case "agentPresets/list": return { presets: [] };
      case "job/kill": {
        signal?.throwIfAborted();
        const job = this.#job(args);
        return { outcome: job.requestStop?.() ? "requested" : "already-finished" };
      }
      case "skills/list": {
        const skills = await this.workbench.availableSkills(stringValue(args, "sessionId"), signal);
        return { skills: skills.map(({ name, path, description }) => ({
          name, description: redactSecretsPreservingLayout(description).slice(0, 1_024), modelInvocable: true,
          ...(!sensitivePath(path) && path === redactSecretsPreservingLayout(path) ? { path } : {}),
        })) };
      }
      case "commands/list":
        this.workbench.requireSession(stringValue(args, "agentId"));
        return [
          { definitionId: "@deepseek-ai/dsh-plan-mode", name: "plan", description: "Enter or leave plan mode", input: { hint: "[off|message]", attachments: true } },
          { definitionId: "@deepseek-ai/dsh-permission-presets", name: "permission", description: uiText("web.permission.command", {}, state.language), input: { hint: "[preset]", attachments: false } },
          { definitionId: "@deepseek-ai/dsh-command-goal", name: "goal", description: uiText("web.goal.command", {}, state.language), input: { hint: "[objective]", attachments: true } },
        ];
      case "commands/execute": return this.#executeCommand(args, signal);
      case "session/search": return this.workbench.searchSessions(stringValue(args, "query"), signal);
      case "session/rename": {
        const title = await this.workbench.renameSession(stringValue(args, "sessionId"), stringValue(args, "title"));
        return { title, seq: ++this.projection.cursor };
      }
      case "session/fork": {
        const sessionId = stringValue(args, "sessionId");
        if (args.atSeq === undefined) return { sessionId: await this.workbench.forkSession(sessionId) };
        if (typeof args.atSeq !== "number" || !Number.isSafeInteger(args.atSeq) || args.atSeq < 0) {
          throw new WebRequestError(400, "Expected a non-negative event sequence");
        }
        // Stream-only steps can shift sequence numbers. Resolve the footer
        // in the browser's own projection instead of replaying a new one.
        const journals = connection && this.#journals.get(connection);
        const matches = new Set<number>();
        for (const journal of journals ?? []) {
          if (journal.session.id !== sessionId) continue;
          const anchor = journal.forkAnchors.get(args.atSeq);
          if (anchor !== undefined) matches.add(anchor);
        }
        const [anchor] = matches;
        if (matches.size !== 1 || anchor === undefined || anchor < 0) {
          throw new WebRequestError(409, "This turn is no longer available. Reopen the session and try again.", "session/fork-unavailable");
        }
        return { sessionId: await this.workbench.forkSession(sessionId, anchor) };
      }
      case "session/modelCatalog": return modelCatalog(state, this.workbench.defaultModelId);
      case "session/events":
      case "session/page": return this.#readEvents(args);
      case "session/projections": {
        const [{ session, activity }] = await Promise.all([
          this.workbench.inspectSession(stringValue(args, "sessionId")), this.workbench.refreshPermissionCap(),
        ]);
        const current = this.workbench.snapshot();
        const journal = new SessionJournal(session, current.language);
        journal.ingest(activity.timeline, activity.turn);
        return { asOfSeq: Math.max(this.projection.cursor, journal.cursor), values: selectionFor(current, session, this.workbench.teamEnabled(session.id)) };
      }
      case "session/create": {
        if (typeof args.sessionId === "string") {
          const { session } = await this.workbench.readSession(args.sessionId);
          if (session.blank && !state.turns[session.id] && !this.#sidebar.archivedSessionIds.includes(session.id)) return { sessionId: session.id };
        }
        const cap = await this.workbench.refreshPermissionCap();
        return { sessionId: await this.workbench.createSession(await this.preferences.permissionDefault(cap)) };
      }
      case "session/selectModel": {
        const sessionId = stringValue(args, "sessionId");
        this.#requireUnarchived(sessionId);
        const modelId = stringValue(args, "model");
        if (!state.models.some(model => model.id === modelId && model.provider === args.provider)) {
          throw new WebRequestError(404, "Model is unavailable");
        }
        await this.workbench.selectSessionModel(sessionId, modelId);
        return { selected: { provider: args.provider, model: modelId } };
      }
      case "session/prompt": return this.#submitPrompt(args, signal);
      case "session/attachment": return this.workbench.readInputImage(stringValue(args, "sessionId"), args.attachment, signal);
      case "session/updateQueue": {
        const sessionId = stringValue(args, "sessionId");
        const itemId = stringValue(args, "itemId");
        this.#requireUnarchived(sessionId);
        const action = inputRecord(args.action);
        if (action.kind === "edit") {
          if (!Array.isArray(action.content) || action.content.some(part => inputRecord(part).type !== "text")) {
            throw new WebRequestError(400, "Queue edits accept text only", "session/attachment-invalid", { reason: "QUEUE_EDIT_NON_TEXT" });
          }
          const { prompt, data } = await this.#input.prepare(sessionId, action.content, signal);
          if (!prompt.trim() || prompt.length > MAX_WEB_INPUT_TEXT) throw new WebRequestError(400, "Enter non-empty queue text up to 64000 characters");
          this.#requireUnarchived(sessionId);
          signal?.throwIfAborted();
          await this.workbench.updateQueue(sessionId, itemId, {
            kind: "edit", text: prompt, ...(data.referenceContext ? { referenceContext: data.referenceContext } : {}),
          });
        } else if (action.kind === "remove" || action.kind === "steer") {
          await this.workbench.updateQueue(sessionId, itemId, { kind: action.kind });
        } else throw new WebRequestError(400, "Invalid queue action");
        return { accepted: true };
      }
      case "session/cancel": return { accepted: this.workbench.stopSession(stringValue(args, "sessionId")) };
      default: throw new WebRequestError(404, `Unsupported Harness operation: ${endpoint}`);
    }
  }

  #job(args: Record<string, unknown>) {
    const sessionId = stringValue(args, "sessionId");
    const jobId = stringValue(args, "jobId");
    this.workbench.requireSession(sessionId);
    const job = this.workbench.jobs.get(sessionId, jobId);
    if (!job) throw new WebRequestError(404, "Background job is unavailable in this session", "job/not-found", { sessionId, jobId });
    return job;
  }

  watchEvents(clientId: string, signal: AbortSignal, write: (frame: unknown) => void, announceSessions: boolean): () => void {
    const delivered = new Map<string, string>();
    this.#eventClients.set(clientId, { signal, delivered });
    const settingsChanged = () => write({ type: "emit", event: "settings/document-updated", args: [] });
    let previous = this.workbench.snapshot();
    if (announceSessions) {
      for (const session of previous.sessions) {
        write({ type: "emit", event: "api-session/added", args: [sessionSummary(session, previous)] });
      }
    }
    const deliverInteraction = (sessionId: string, interaction: WebTurn["interaction"] | undefined) => {
      const prior = delivered.get(sessionId);
      if (prior === interaction?.id) return;
      if (prior) write({ type: "cancel", eventId: prior });
      if (!interaction) { delivered.delete(sessionId); return; }
      delivered.set(sessionId, interaction.id);
      if (interaction.kind === "approval") {
        write({
          type: "waterfall", event: "approval/request", eventId: interaction.id, agentId: sessionId,
          request: { toolName: interaction.tool, reason: interaction.prompt },
        });
      } else if (interaction.kind === "plan") {
        write({
          type: "waterfall", event: "user-questions/request", eventId: interaction.id, agentId: sessionId,
          request: { questions: [{
            id: planReviewId, header: "Plan review", question: "Approve the plan and start implementation?",
            detail: interaction.submitted.plan,
            options: [
              { label: approvePlan, description: "Approve this plan and start implementation." },
              { label: keepPlanning, description: "Stay in plan mode and revise the plan." },
            ],
            intent: { kind: "plan-review", approve: approvePlan, callId: interaction.callId },
          }] },
        });
      } else {
        write({
          type: "waterfall", event: "user-questions/request", eventId: interaction.id, agentId: sessionId,
          request: { questions: interaction.questions },
        });
      }
    };
    const unsubscribe = this.workbench.subscribe(event => {
      if ("state" in event) {
        const current = event.state;
        if (previous.permissionCap !== current.permissionCap) {
          write({ type: "emit", event: "permission-presets/catalog-changed", args: [] });
          settingsChanged();
        }
        const known = new Map(previous.sessions.map(session => [session.id, session]));
        for (const session of current.sessions) {
          const before = known.get(session.id);
          const activation = goalActivation(current, session);
          if (JSON.stringify(activation) !== JSON.stringify(before && goalActivation(previous, before))) {
            write({ type: "emit", event: "goal/activation-changed", args: [{ sessionId: session.id, ...(activation ? { goal: activation } : {}) }] });
          }
          if (!before || before.blank !== session.blank) {
            write({ type: "emit", event: "api-session/added", args: [sessionSummary(session, current)] });
          } else if (before.updatedAt !== session.updatedAt) {
            write({ type: "emit", event: "api-session/activity", args: [session.id, Date.parse(session.updatedAt)] });
          }
          const running = !!current.turns[session.id];
          if (running !== !!previous.turns[session.id]) {
            write({ type: "emit", event: "api-session/status", args: [session.id, running] });
          }
          deliverInteraction(session.id, current.turns[session.id]?.interaction);
        }
        previous = current;
      } else if (event.activity.sessionId) {
        deliverInteraction(event.activity.sessionId, event.activity.turn?.interaction);
      }
    });
    return () => {
      this.#eventClients.delete(clientId);
      unsubscribe();
    };
  }

  controlSnapshot() {
    const state = this.workbench.snapshot();
    return Object.fromEntries(state.sessions.map(session => [
      session.id, { asOfSeq: this.projection.cursor, values: selectionFor(state, session, this.workbench.teamEnabled(session.id)) },
    ]));
  }

  watchControl(write: (frame: unknown) => void, projectInitial: boolean): () => void {
    const state = this.workbench.snapshot();
    const previous = new Map(projectInitial ? [] : state.sessions.map(session => [session.id, selectionFor(state, session, this.workbench.teamEnabled(session.id))]));
    return this.workbench.subscribe(event => {
      if (!("state" in event)) return;
      for (const session of event.state.sessions) {
        const values = selectionFor(event.state, session, this.workbench.teamEnabled(session.id));
        const before = previous.get(session.id);
        const changes = Object.entries(values).filter(([key, value]) =>
          JSON.stringify(before?.[key as keyof typeof values]) !== JSON.stringify(value),
        );
        if (changes.length === 0) continue;
        previous.set(session.id, values);
        write({
          type: "projection", sessionId: session.id, seq: ++this.projection.cursor,
          changes: changes.map(([key, val]) => ({ key, val })),
        });
      }
    });
  }

  async subscribe(endpoint: string, payload: unknown, write: (frame: unknown) => void, signal: AbortSignal, finish: () => void): Promise<() => void> {
    if (endpoint === "workspaceFiles/changes") return this.#files.watch(inputRecord(inputRecord(payload).args), write, signal);
    const args = requestArguments(payload);
    switch (endpoint) {
      case "session/follow": {
        const address = typeof args.address === "object" ? inputRecord(args.address) : args;
        const id = stringValue(address, "sessionId");
        let latest: WebSessionActivity | undefined;
        let publish: ((activity: WebSessionActivity) => void) | undefined;
        const unsubscribe = this.workbench.subscribe(event => {
          if (!("activity" in event) || event.activity.sessionId !== id) return;
          if (publish) publish(event.activity);
          else latest = event.activity;
        });
        try {
          const [{ session, activity }] = await Promise.all([
            this.workbench.inspectSession(id), this.workbench.refreshPermissionCap(),
          ]);
          signal.throwIfAborted();
          const state = this.workbench.snapshot();
          const journal = new SessionJournal(session, state.language);
          let journals = this.#journals.get(signal);
          if (!journals) this.#journals.set(signal, journals = new Set());
          const opening = latest ?? activity;
          journal.ingest(opening.timeline, opening.turn);
          this.projection.cursor = Math.max(this.projection.cursor, journal.cursor);
          write({
            type: "snapshot",
            header: { version: 3, id, createdAt: Date.parse(session.createdAt), cwd: state.workspace, isSeeded: false },
            cursor: journal.cursor, records: journal.records, hasMore: false,
            projections: { asOfSeq: this.projection.cursor, values: selectionFor(state, session, this.workbench.teamEnabled(session.id)) },
            assistantStream: { revision: 0 },
          });
          const assistant = new AssistantDelivery(write);
          publish = ({ timeline, turn }) => {
            const appended = journal.ingest(timeline, turn);
            this.projection.cursor = Math.max(this.projection.cursor, journal.cursor);
            for (const record of appended) {
              if (record.event.type === "user/message") assistant.update(null, journal, undefined);
              write(record);
              if (record.event.type === "assistant/message") assistant.update(null, journal, record);
            }
            assistant.update(turn, journal, undefined);
          };
          publish(opening);
          journals.add(journal);
          return () => { journals.delete(journal); unsubscribe(); };
        } catch (error) { unsubscribe(); throw error; }
      }
      case "remoteAccess/follow": write({ type: "baseline", owner: true }); break;
      case "sessionStatus/follow": write({ type: "baseline", items: [] }); break;
      case "terminal/watch": write([]); break;
      case "job/list": {
        const sessionId = stringValue(args, "sessionId");
        this.workbench.requireSession(sessionId);
        return this.workbench.jobs.rows(sessionId, write);
      }
      case "job/follow": {
        const job = this.#job(args);
        const from = args.from;
        if (from !== undefined && (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0 || from > job.output.total)) {
          throw new WebRequestError(400, "Invalid background job output offset");
        }
        return this.workbench.jobs.follow(job, from, write, finish);
      }
      case "connectorAccounts/watch": write({ accounts: [] }); break;
      case "account/watch":
        write({ type: "snapshot", state: { status: "signed-out", attempt: null, links: {} } });
        break;
      case "pluginEvents/follow": write({ type: "baseline", plugins: [] }); break;
      default: throw new WebRequestError(404, `Unsupported Harness subscription: ${endpoint}`);
    }
    return () => {};
  }
}
