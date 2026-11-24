import { randomUUID } from "node:crypto";
import { hasPromptImages } from "../agent/file-attachments.js";
import { isInputImageReference, sameInputImage, type InputImageReference } from "../agent/input-images.js";
import { deterministicExecTitle, InteractivePermissionChangeError, runInteractiveTask, selectExecModel, type InteractivePromptData } from "../exec/runtime.js";
import type { ExecDependencies, ExecResult } from "../exec/types.js";
import { GoalRuntime, type GoalCreateInput } from "../goal/runtime.js";
import type { UiLanguage } from "../localization/language.js";
import { uiText } from "../localization/messages.js";
import { normalizeWorkspacePath } from "../memory/learned-memory.js";
import { loadPermissionPolicy, webPermissionMode, type WebPermissionMode } from "../permissions/policy.js";
import { normalizePlanReview, type PlanReviewDecision } from "../plan/runtime.js";
import { defaultModelRequestSettings, providerKind, resolveProviderCapabilities } from "../providers/capabilities.js";
import { getProviderDefinition, openCodeGoModelsUrl, supportsResponsesImages } from "../providers/openai-compatible.js";
import { SkillCatalog } from "../skills/catalog.js";
import { PersistenceError } from "../storage/persistence-error.js";
import { nextGoalRevision, SessionStore, type SessionGoal, type SessionSummary, type StoredTextTimelineEntry } from "../storage/session-store.js";
import { MAX_WEB_INBOX_ITEMS, MAX_WEB_INPUT_TEXT, type WebInbox, type WebInboxItem } from "../storage/web-inbox.js";
import { redactSecretsPreservingLayout } from "../util/redact-secrets.js";
import type { WebInboxMessage, WebInteraction, WebMessage, WebSession, WebSessionActivity, WebState, WebTurn, WorkbenchEvent } from "./protocol.js";
import { HarnessJobs } from "./harness-jobs.js";
import type { TeamOptions } from "../team/types.js";

export class WebRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "everpeace/request-refused",
    readonly details: Readonly<Record<string, unknown>> = {},
  ) { super(message); }
}

export const harnessCommandNames: ReadonlySet<string> = new Set(["plan", "permission", "goal"]);
const skillName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function visible(text: string): string {
  return redactSecretsPreservingLayout(text).slice(0, 64_000);
}

function failure(error: unknown): string {
  return visible(error instanceof Error ? error.message : String(error));
}

function sessionView(session: SessionSummary): WebSession {
  return {
    id: session.id,
    title: visible(session.title),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    modelId: session.model.id,
    blank: session.title_pending,
    ...(session.web_permission_mode === undefined ? {} : { permissionMode: session.web_permission_mode }),
    ...(session.goal ? { goal: { ...session.goal, objective: visible(session.goal.objective) }, goalRevision: session.goal_revision ?? 1 } : {}),
    ...(session.team ? { team: structuredClone(session.team) } : {}),
  };
}

function messageView(entry: StoredTextTimelineEntry): WebMessage {
  return {
    kind: entry.kind, text: visible(entry.text),
    ...(entry.input_files === undefined ? {} : { files: entry.input_files.map(file => ({ ...file, name: visible(file.name) })) }),
    ...(entry.plan === undefined ? {} : { plan: { ...entry.plan } }),
    ...(entry.web_turn_started ? { webTurnStarted: true } : {}),
    ...(entry.web_turn_outcome === undefined ? {} : { webTurnOutcome: entry.web_turn_outcome }),
    ...(entry.web_skill_name === undefined ? {} : { webSkillName: entry.web_skill_name }),
    ...(entry.web_input ? { webInput: { id: entry.web_input.id, requestId: entry.web_input.requestId } } : {}),
  };
}

type InteractionBody =
  | Omit<Extract<WebInteraction, { kind: "approval" }>, "id">
  | Omit<Extract<WebInteraction, { kind: "question" }>, "id">
  | Omit<Extract<WebInteraction, { kind: "plan" }>, "id">;

type InteractionAnswer = boolean | Record<string, string>;
interface PendingInteraction {
  view: WebInteraction;
  signal: AbortSignal;
  settle(value: InteractionAnswer): void;
}

interface ActiveTurn {
  sessionId: string | null;
  modelId: string;
  history?: WebMessage[];
  view: WebTurn;
  controller: AbortController;
  pending: Map<string, PendingInteraction>;
  settling?: boolean;
  inboxItem?: string;
  steering: Set<string>;
  offerSteering?: (item: WebInboxItem) => boolean;
  resumeInbox?: boolean;
  done?: Promise<void>;
  flushTimer?: ReturnType<typeof setTimeout>;
}

export interface WebGoalRef { id: string; revision: number }
export type WebGoalAction =
  | ({ kind: "create" } & GoalCreateInput)
  | { kind: "edit"; objective?: string; maxGoalRounds?: number }
  | { kind: "pause" | "resume" | "clear" };

export class WebWorkbench {
  readonly jobs: HarnessJobs;
  readonly #store: SessionStore;
  readonly #dependencies: ExecDependencies;
  readonly #state: Omit<WebState, "turn" | "turns" | "inboxes">;
  readonly #listeners = new Set<(event: WorkbenchEvent) => void>();
  readonly #inboxes = new Map<string, WebInbox>();
  readonly #inboxHolds = new Set<string>();
  readonly #active = new Map<string | null, ActiveTurn>();
  readonly #teamSessions = new Set<string>();
  #inboxOperation: Promise<unknown> = Promise.resolve();
  #preferredNewSessionModelId: string | undefined;
  #defaultModelId: string | null = null;
  #pendingOperation: Promise<unknown> | undefined;
  #sessionRefresh: Promise<void> = Promise.resolve();
  #sessionRevision = 0;
  #closing = false;

  constructor(workspace: string, language: UiLanguage, dependencies: ExecDependencies, private readonly skills = new SkillCatalog(workspace)) {
    this.jobs = new HarnessJobs(language);
    this.#store = dependencies.sessionStore ?? new SessionStore();
    this.#dependencies = dependencies;
    this.#state = {
      workspace, language, sessions: [], sessionId: null, modelId: null,
      models: [], timeline: [], error: null, blocked: false, planSessions: [], permissionCap: "read-only",
    };
  }

  async initialize(initialModel?: string): Promise<void> {
    const [, models] = await Promise.all([this.#refreshSessions(), this.#refreshModels(), this.refreshPermissionCap()]);
    this.#preferredNewSessionModelId = initialModel === undefined ? undefined : selectExecModel(models, initialModel).model.id;
    this.#defaultModelId = this.#preferredNewSessionModelId ?? this.#state.models[0]?.id ?? null;
    this.#state.modelId = this.#defaultModelId;
  }

  subscribe(listener: (event: WorkbenchEvent) => void): () => void {
    listener({ state: this.#publicState() });
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  snapshot(): WebState {
    return this.#publicState();
  }

  get workspace(): string { return this.#state.workspace; }

  get defaultModelId(): string | null { return this.#defaultModelId; }

  forWorkspace(workspace: string, verify: () => Promise<void>): WebWorkbench {
    const readPolicy = this.#dependencies.loadPermissionPolicy ?? loadPermissionPolicy;
    return new WebWorkbench(workspace, this.#state.language, {
      ...this.#dependencies, sessionStore: this.#store,
      async loadPermissionPolicy(path) { await verify(); return readPolicy(path); },
    });
  }

  hasSession(id: string): boolean {
    return this.#state.sessions.some(session => session.id === id);
  }

  async readSession(id: string): Promise<{ session: WebSession; timeline: WebMessage[] }> {
    this.requireSession(id);
    const loaded = await this.#store.load(id);
    this.#assertWorkspace(loaded.summary);
    if (!this.#inboxes.has(id)) this.#inboxes.set(id, loaded.webInbox ?? { pending: [], accepted: [] });
    return {
      session: {
        ...sessionView(loaded.summary),
        blank: loaded.summary.title_pending && !loaded.timeline.some(entry => entry.kind === "user"),
      },
      timeline: loaded.timeline.flatMap(entry => entry.kind === "status" ? [] : [messageView(entry)]),
    };
  }

  async inspectSession(id: string): Promise<{ session: WebSession; activity: WebSessionActivity }> {
    const { session, timeline } = await this.readSession(id);
    const active = this.#active.get(id);
    return { session, activity: active?.history ? this.#activity(active) : { sessionId: id, timeline, turn: null } };
  }

  requireSession(id: string): WebSession {
    const session = this.#state.sessions.find(item => item.id === id);
    if (!session) throw new WebRequestError(404, "Session is unavailable in this workspace");
    return session;
  }

  async setTeamEnabled(sessionId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    this.requireSession(sessionId);
    if (enabled) this.#teamSessions.add(sessionId);
    else this.#teamSessions.delete(sessionId);
    this.#stateChanged();
    return { enabled };
  }

  teamEnabled(sessionId: string): boolean { return this.#teamSessions.has(sessionId); }

  #imageModelError(): WebRequestError {
    return new WebRequestError(409, uiText("web.image.modelUnsupported", {}, this.#state.language),
      "session/attachment-invalid", { reason: "IMAGE_MODEL_UNSUPPORTED" });
  }

  #modelSupportsImages(id: string): boolean {
    return this.#state.models.some(model => model.id === id && model.supportsImages);
  }

  requireImageModel(sessionId: string): void {
    if (!this.#modelSupportsImages(this.requireSession(sessionId).modelId)) throw this.#imageModelError();
  }

  async saveInputImage(sessionId: string, ref: InputImageReference, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.requireImageModel(sessionId);
    await this.#store.saveInputImage(sessionId, ref, bytes, signal);
  }

  async readInputImage(sessionId: string, ref: unknown, signal?: AbortSignal) {
    this.requireSession(sessionId);
    const loaded = await this.#store.load(sessionId);
    this.#assertWorkspace(loaded.summary);
    signal?.throwIfAborted();
    if (isInputImageReference(ref)) {
      const matches = (file: unknown) => isInputImageReference(file) && sameInputImage(file, ref);
      if (loaded.timeline.some(entry => entry.kind === "user" && entry.input_files?.some(matches)) ||
          loaded.webInbox?.pending.some(item => item.uploadedFiles?.some(matches))) {
        const bytes = await this.#store.readInputImage(sessionId, ref, signal);
        return { attachment: ref, data: Buffer.from(bytes).toString("base64") };
      }
    }
    throw new WebRequestError(404, uiText("web.image.unavailable", {}, this.#state.language),
      "session/attachment-invalid", { reason: "ATTACHMENT_NOT_FOUND" });
  }

  async availableSkills(sessionId: string, signal?: AbortSignal) {
    this.requireSession(sessionId);
    signal?.throwIfAborted();
    const { skills, conflictedNames } = await this.skills.refresh();
    signal?.throwIfAborted();
    const conflicts = new Set(conflictedNames);
    return skills.filter(skill => skillName.test(skill.name) && !conflicts.has(skill.name) && !harnessCommandNames.has(skill.name));
  }

  async searchSessions(query: string, signal?: AbortSignal) {
    if (query.length > 512 || !query.trim()) throw new WebRequestError(400, "Enter a session search query");
    const limit = 20;
    const { matches, total } = await this.#store.search({
      workspacePath: this.#state.workspace, query, limit, ...(signal ? { signal } : {}),
    });
    return {
      items: matches.flatMap(({ summary, match }) => match ? [{
        sessionId: summary.id, snippet: [...visible(match.snippet)].slice(0, 240).join(""),
      }] : []),
      hasMore: total > limit,
    };
  }

  async renameSession(id: string, title: string): Promise<string> {
    const normalized = visible(title).trim().replace(/\s+/gu, " ");
    if (!normalized || normalized.length > 240) throw new WebRequestError(400, "Enter a session title up to 240 characters");
    await this.#withSessionQuiesced(id, undefined, () => this.#store.updateTitle(id, normalized));
    await this.#refreshSessions();
    this.#stateChanged();
    return normalized;
  }

  async forkSession(id: string, throughTimelineIndex?: number): Promise<string> {
    const fork = await this.#withSessionQuiesced(id, undefined, () => this.#store.fork(id,
      throughTimelineIndex === undefined ? {} : { throughTimelineIndex }));
    await this.#refreshSessions();
    this.#stateChanged();
    return fork.id;
  }

  async whileSessionIdle<T>(id: string, stopActivity: boolean, operation: () => Promise<T>): Promise<T> {
    return this.#withSessionQuiesced(id, stopActivity ? new Error("Turn cancelled") : undefined, operation);
  }

  async #withSessionQuiesced<T>(id: string, reason: Error | undefined, operation: () => Promise<T>): Promise<T> {
    this.requireSession(id);
    const active = this.#active.get(id);
    if (active && !reason) throw this.#sessionActive(id);
    if (this.#closing || this.#inboxHolds.has(id)) throw this.#sessionActive(id);
    this.#inboxHolds.add(id);
    try {
      if (active && reason) {
        this.#stop(active, reason);
        await active.done;
        if (this.#state.blocked) throw new WebRequestError(409, "The task could not release its resources");
      }
      return await this.#withInactiveSession(id, operation);
    } finally { this.#inboxHolds.delete(id); }
  }

  async createSession(defaultPermission?: WebPermissionMode): Promise<string> {
    let sessionId!: string;
    await this.#operation(async () => {
      const models = await this.#refreshModels();
      const model = selectExecModel(models, this.defaultModelId ?? undefined).model;
      const permission = webPermissionMode(await this.refreshPermissionCap(), defaultPermission);
      const summary = await this.#store.create({
        workspacePath: this.#state.workspace, title: "New Session", titlePending: true, model,
        webPermissionMode: permission,
      });
      sessionId = summary.id;
      await this.#refreshSessions();
    });
    return sessionId;
  }

  async refreshPermissionCap(): Promise<WebPermissionMode> {
    const policy = await (this.#dependencies.loadPermissionPolicy ?? loadPermissionPolicy)(this.#state.workspace);
    const cap = webPermissionMode(policy.mode);
    if (this.#state.permissionCap !== cap) {
      this.#state.permissionCap = cap;
      this.#stateChanged();
    }
    return cap;
  }

  async selectPermissionMode(sessionId: string, mode: WebPermissionMode, signal?: AbortSignal): Promise<WebPermissionMode> {
    const check = async () => {
      const cap = await this.refreshPermissionCap();
      signal?.throwIfAborted();
      if (this.#closing) throw this.#sessionActive(sessionId);
      if (webPermissionMode(cap, mode) !== mode) {
        throw new WebRequestError(403, "The workspace policy limits this permission preset", "permission/preset-unavailable");
      }
      return cap;
    };
    this.requireSession(sessionId);
    if (this.#closing || this.#inboxHolds.has(sessionId)) throw this.#sessionActive(sessionId);
    const cap = await check();
    if ((this.requireSession(sessionId).permissionMode ?? cap) === mode) return mode;
    await this.#withSessionQuiesced(sessionId, new InteractivePermissionChangeError(), async () => {
      await check();
      await this.#store.setWebPermissionMode(sessionId, mode);
      await this.#refreshSessions();
      this.#stateChanged();
    });
    return mode;
  }

  async changeGoal(sessionId: string, action: WebGoalAction, ref?: WebGoalRef, data?: InteractivePromptData, signal?: AbortSignal) {
    const { modelId } = this.requireSession(sessionId);
    if ("objective" in action && action.objective !== undefined && action.objective.length > 4_000) {
      throw new WebRequestError(400, "The Goal objective may contain up to 4000 characters");
    }
    const active = this.#active.get(sessionId);
    const shouldStart = action.kind === "create" || action.kind === "resume" ||
      action.kind === "edit" && !!active && !this.#state.planSessions.includes(sessionId);
    if (this.#closing || this.#inboxHolds.has(sessionId)) throw this.#sessionActive(sessionId);
    if (shouldStart && (this.#state.blocked || !this.#state.models.some(item => item.id === modelId))) {
      throw new WebRequestError(409, "Select an available model before starting the Goal");
    }
    const initial = await this.#store.load(sessionId);
    const expected = ref ?? (initial.goal ? { id: initial.goal.goal_id, revision: initial.summary.goal_revision ?? 0 } : undefined);
    const assertCurrent = (goal: SessionGoal | undefined, revision: number) => {
      if (action.kind === "create") {
        if (goal && goal.status !== "complete") throw new WebRequestError(409, "Edit or clear the current Goal first", "goal/invalid-transition");
      } else if (!goal || expected?.id !== goal.goal_id || expected.revision !== revision) {
        throw new WebRequestError(409, "The Goal has changed. Read its current state and try again.", "goal/stale-revision");
      }
      if (action.kind === "pause" && goal?.status !== "active" ||
          action.kind === "resume" && (goal?.status !== "paused" && goal?.status !== "blocked" && (goal?.status !== "active" || active)) ||
          action.kind === "edit" && goal?.status === "complete") {
        throw new WebRequestError(409, "The Goal cannot perform this action in its current state", "goal/invalid-transition");
      }
      if (action.kind === "edit" && action.maxGoalRounds !== undefined && action.maxGoalRounds < (goal?.rounds_started ?? 0)
        || action.kind === "resume" && goal?.max_goal_rounds !== undefined && (goal.rounds_started ?? 0) >= goal.max_goal_rounds) {
        throw new WebRequestError(409, "Increase the Goal round limit before continuing", "goal/round-limit");
      }
    };
    assertCurrent(initial.goal, initial.summary.goal_revision ?? 0);
    signal?.throwIfAborted();
    const outcome = await this.#withSessionQuiesced(sessionId, new Error("Goal changed by the user"), async () => {
      const loaded = await this.#store.load(sessionId);
      let goal = loaded.goal;
      let revision = loaded.summary.goal_revision ?? 0;
      assertCurrent(goal, revision);
      signal?.throwIfAborted();
      if (this.#closing) throw this.#sessionActive(sessionId);
      if (hasPromptImages(data?.attachments)) this.requireImageModel(sessionId);
      const runtime = new GoalRuntime({
        getGoal: async () => goal,
        setGoal: async next => {
          await this.#store.setGoal(sessionId, next);
          revision = nextGoalRevision(goal, next, revision);
          goal = next;
        },
      });
      if (action.kind === "clear") {
        await this.#store.clearGoal(sessionId);
        const id = goal!.goal_id;
        revision += 1;
        this.#publishGoal(sessionId, undefined, revision);
        return { goal: undefined, revision, id };
      }
      try {
        if (action.kind === "create") await runtime.create({ ...action, objective: visible(action.objective) });
        else if (action.kind === "edit") await runtime.edit({
          ...(action.objective === undefined ? {} : { objective: visible(action.objective) }),
          ...(action.maxGoalRounds === undefined ? {} : { maxGoalRounds: action.maxGoalRounds }),
        });
        else if (action.kind === "pause") await runtime.update("paused");
        else if (goal?.status !== "active") await runtime.resume();
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new WebRequestError(409, failure(error), "goal/invalid-transition");
      }
      this.#publishGoal(sessionId, goal, revision);
      return { goal, revision, id: goal!.goal_id };
    });
    if (shouldStart && outcome.goal?.status === "active") {
      this.#setPlanMode(sessionId, false);
      const text = action.kind === "create" ? outcome.goal.objective
        : "Continue the current session Goal. Read get_goal, make concrete progress, and verify the outcome.";
      this.startSession(sessionId, text, { ...data, ...(action.kind === "create" ? {} : { resumeGoal: true }) });
    }
    return outcome;
  }

  #publishGoal(sessionId: string, goal: SessionGoal | undefined, revision: number): void {
    this.#sessionRevision++;
    this.#state.sessions = this.#state.sessions.map(session => {
      if (session.id !== sessionId) return session;
      const next = { ...session };
      if (goal) {
        next.goal = { ...goal, objective: visible(goal.objective) };
        next.goalRevision = revision;
      } else {
        delete next.goal;
        delete next.goalRevision;
      }
      return next;
    });
    this.#stateChanged();
  }

  async close(): Promise<void> {
    this.#closing = true;
    const active = [...this.#active.values()];
    for (const turn of active) this.#stop(turn, new Error("Workbench closed"));
    await Promise.allSettled([...active.map(turn => turn.done), this.#pendingOperation, this.#inboxOperation]);
    this.#listeners.clear();
  }

  async selectSession(id: string | null): Promise<void> {
    return this.#operation(async () => {
      await this.#refreshSessions();
      await this.#refreshModels();
      this.#state.error = null;
      if (id === null) {
        this.#state.timeline = [];
        this.#state.sessionId = null;
        this.#state.modelId = this.#preferredNewSessionModelId ?? this.#state.models.find(model => model.id === this.#defaultModelId)?.id
          ?? this.#state.models[0]?.id ?? null;
        return;
      }
      const loaded = await this.readSession(id);
      this.#state.sessionId = id;
      this.#state.modelId = loaded.session.modelId;
      this.#state.timeline = loaded.timeline;
    });
  }

  async selectModel(id: string, expectedSession: string | null): Promise<void> {
    return this.#operation(async () => {
      if (expectedSession !== this.#state.sessionId) throw new WebRequestError(409, "The selected session changed");
      if (expectedSession) return this.selectSessionModel(expectedSession, id);
      if (this.#active.has(null)) throw new WebRequestError(409, "The workbench is busy");
      if (!(await this.#refreshModels()).available.some(model => model.id === id)) throw new WebRequestError(404, "Model is unavailable");
      this.#defaultModelId = this.#state.modelId = id;
      this.#state.error = null;
      if (this.#preferredNewSessionModelId !== undefined) this.#preferredNewSessionModelId = id;
    });
  }

  async selectSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.#withSessionQuiesced(sessionId, undefined, async () => {
      const model = (await this.#refreshModels()).available.find(item => item.id === modelId);
      if (!model) throw new WebRequestError(404, "Model is unavailable");
      const { summary, webInbox } = await this.#store.load(sessionId);
      const { id, model_name, base_url, responses_profile } = model;
      if (!this.#modelSupportsImages(id) && webInbox?.pending.some(item => hasPromptImages(item.attachments))) {
        throw this.#imageModelError();
      }
      if (summary.model.id !== id || summary.model.base_url !== base_url || summary.model.model_name !== model_name || summary.model.responses_profile !== responses_profile) {
        await this.#store.selectModel(sessionId, {
          id, model_name, base_url,
          request_settings: defaultModelRequestSettings(resolveProviderCapabilities(base_url, model_name, responses_profile), model.request_settings),
          ...(responses_profile ? { responses_profile } : {}),
        }, true);
      }
      await this.#refreshSessions();
      if (this.#state.sessionId === sessionId) this.#state.modelId = modelId;
    });
    this.#stateChanged();
  }

  setPlanMode(sessionId: string, enabled: boolean): void {
    this.requireSession(sessionId);
    this.#assertSessionIdle(sessionId);
    this.#setPlanMode(sessionId, enabled);
    this.#stateChanged();
  }

  #setPlanMode(sessionId: string, enabled: boolean): void {
    const selected = this.#state.planSessions;
    if (selected.includes(sessionId) === enabled) return;
    this.#state.planSessions = enabled ? [...selected, sessionId] : selected.filter(id => id !== sessionId);
  }

  start(prompt: string, expectedSession: string | null, expectedModel: string, data: InteractivePromptData = {}, enterPlan = false): void {
    if (this.#pendingOperation || expectedSession !== this.#state.sessionId || expectedModel !== this.#state.modelId) {
      throw new WebRequestError(409, "The selected session or model changed");
    }
    this.#start(expectedSession, expectedModel, prompt, data, enterPlan);
  }

  startSession(id: string, prompt: string, data: InteractivePromptData = {}, enterPlan = false): void {
    this.#start(id, this.requireSession(id).modelId, prompt, data, enterPlan);
  }

  #start(sessionId: string | null, modelId: string, prompt: string, data: InteractivePromptData, enterPlan: boolean): void {
    this.#assertSessionIdle(sessionId);
    if (!prompt.trim() && !data.attachments?.length) throw new WebRequestError(400, uiText("web.input.empty", {}, this.#state.language));
    if (!this.#state.models.some(model => model.id === modelId)) throw new WebRequestError(409, "Select a registered model");
    if (hasPromptImages(data.attachments) && (!sessionId || !this.#modelSupportsImages(modelId))) throw this.#imageModelError();
    if (enterPlan && sessionId) this.#setPlanMode(sessionId, true);
    const plan = sessionId !== null && this.#state.planSessions.includes(sessionId);
    const safePrompt = redactSecretsPreservingLayout(prompt);
    const active: ActiveTurn = {
      sessionId, modelId,
      view: { id: randomUUID(), stopping: false, entries: [], delta: "", tools: [], interaction: null },
      controller: new AbortController(),
      pending: new Map(),
      steering: new Set(),
      ...(data.inboxItem ? { inboxItem: data.inboxItem.id } : {}),
    };
    this.#active.set(sessionId, active);
    if (sessionId === this.#state.sessionId) this.#state.error = null;
    const team: TeamOptions | undefined = sessionId && this.#teamSessions.has(sessionId) ? { enabled: true } : undefined;
    active.done = this.#run(active, safePrompt, { ...data, ...(team ? { team } : {}) }, plan);
    this.#stateChanged();
  }

  async hasAcceptedPrompt(sessionId: string, requestId: string): Promise<boolean> {
    if (!this.#inboxes.has(sessionId)) await this.readSession(sessionId);
    return this.#inboxes.get(sessionId)?.accepted.includes(requestId) ?? false;
  }

  submit(sessionId: string, requestId: string, prompt: string, data: InteractivePromptData, steer: boolean): Promise<void> {
    if (!prompt.trim() && !data.attachments?.length) throw new WebRequestError(400, uiText("web.input.empty", {}, this.#state.language));
    if (prompt.length > MAX_WEB_INPUT_TEXT) throw new WebRequestError(413, "Message exceeds 64000 characters");
    const item: WebInboxItem = {
      id: randomUUID(), requestId, revision: 0, text: visible(prompt),
      ...(data.attachments?.length ? { attachments: data.attachments } : {}),
      ...(data.uploadedFiles?.length ? { uploadedFiles: data.uploadedFiles } : {}),
      ...(data.referenceContext ? { referenceContext: visible(data.referenceContext) } : {}),
    };
    return this.#serializeInbox(async () => {
      const { modelId } = this.requireSession(sessionId);
      if (this.#cannotStartInSession(sessionId)) {
        throw new WebRequestError(409, "The session is unavailable for new work");
      }
      if (!this.#state.models.some(model => model.id === modelId)) throw new WebRequestError(409, "Select a registered model");
      if (hasPromptImages(item.attachments)) this.requireImageModel(sessionId);
      let admitted = false;
      const inbox = await this.#store.updateWebInbox(sessionId, current => {
        if (current.accepted.includes(requestId)) return;
        if (current.pending.length >= MAX_WEB_INBOX_ITEMS) throw new WebRequestError(429, "The session input queue is full");
        admitted = true;
        return { kind: "put", item };
      });
      this.#inboxes.set(sessionId, inbox);
      if (admitted) {
        const active = this.#active.get(sessionId);
        if (active?.view.stopping) active.resumeInbox = true;
        if (steer && active) this.#offerSteering(active, item);
      }
      this.#stateChanged();
      if (admitted) this.#startPending(sessionId);
    });
  }

  updateQueue(
    sessionId: string, itemId: string,
    action: { kind: "remove" | "steer" } | { kind: "edit"; text: string; referenceContext?: string },
  ): Promise<void> {
    return this.#serializeInbox(async () => {
      this.requireSession(sessionId);
      if (this.#closing || this.#inboxHolds.has(sessionId)) throw this.#sessionActive(sessionId);
      const active = this.#active.get(sessionId);
      const missing = () => new WebRequestError(404, "The input is no longer queued", "session/queue-item-not-found", { itemId });
      if (active?.inboxItem === itemId || active?.steering.has(itemId)) throw missing();
      let target!: WebInboxItem;
      const inbox = await this.#store.updateWebInbox(sessionId, current => {
        const found = current.pending.find(item => item.id === itemId);
        if (!found) throw missing();
        target = found;
        if (action.kind === "remove") return { kind: "remove", id: itemId };
        if (action.kind === "edit") {
          if (target.attachments?.length) {
            throw new WebRequestError(400, uiText("web.input.queueAttachmentEdit", {}, this.#state.language),
              "session/attachment-invalid", { reason: "QUEUE_EDIT_NON_TEXT" });
          }
          const { id, requestId, revision } = target;
          return { kind: "put", item: {
            id, requestId, revision: revision + 1, text: visible(action.text),
            ...(action.referenceContext ? { referenceContext: visible(action.referenceContext) } : {}),
          } };
        }
      });
      this.#inboxes.set(sessionId, inbox);
      if (action.kind === "steer" && (!active || this.#active.get(sessionId) !== active || !this.#offerSteering(active, target))) {
        throw new WebRequestError(409, "The active turn cannot accept steering", "session/steer-unavailable", { itemId });
      }
      this.#stateChanged();
    });
  }

  #serializeInbox<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#inboxOperation.then(action, action);
    this.#inboxOperation = next;
    return next;
  }

  #offerSteering(active: ActiveTurn, item: WebInboxItem): boolean {
    if (hasPromptImages(item.attachments) && !this.#modelSupportsImages(active.modelId)) return false;
    if (active.settling || active.controller.signal.aborted || !active.offerSteering?.(item)) return false;
    active.steering.add(item.id);
    const interaction = active.view.interaction;
    if (interaction?.kind === "approval") active.pending.get(interaction.id)?.settle(false);
    return true;
  }

  #startPending(sessionId: string): void {
    if (this.#active.has(sessionId) || this.#cannotStartInSession(sessionId)) return;
    const { modelId } = this.requireSession(sessionId);
    if (!this.#state.models.some(model => model.id === modelId)) return;
    const item = this.#inboxes.get(sessionId)?.pending[0];
    if (!item) return;
    if (hasPromptImages(item.attachments) && !this.#modelSupportsImages(modelId)) return;
    const { id, requestId, revision, ...data } = item;
    this.#start(sessionId, modelId, item.text, { ...data, inboxItem: { id, requestId, revision } }, false);
  }

  #cannotStartInSession(sessionId: string): boolean {
    return this.#closing || this.#state.blocked || this.#inboxHolds.has(sessionId);
  }

  stop(id: string): boolean {
    const active = this.#requireTurn(id);
    return this.#stop(active, new Error("Turn cancelled"));
  }

  stopSession(id: string): boolean {
    this.requireSession(id);
    const active = this.#active.get(id);
    return !!active && this.#stop(active, new Error("Turn cancelled"));
  }

  #stop(active: ActiveTurn, reason: Error): boolean {
    if (active.settling || active.controller.signal.aborted) return false;
    active.view.stopping = true;
    active.controller.abort(reason);
    this.#turnChanged(active);
    this.#stateChanged();
    return true;
  }

  answer(turnId: string, requestId: string, answer: unknown): void {
    const active = this.#requireTurn(turnId);
    const pending = active.pending.get(requestId);
    if (!pending || active.view.interaction?.id !== requestId || pending.signal.aborted || active.controller.signal.aborted) {
      throw new WebRequestError(409, "This request is no longer pending");
    }
    if (pending.view.kind === "approval") {
      if (typeof answer !== "boolean") throw new WebRequestError(400, "Expected an approval decision");
      pending.settle(answer);
      return;
    }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new WebRequestError(400, "Expected answers to the questions");
    const fields = answer as Record<string, unknown>;
    if (pending.view.kind === "plan") {
      const { decision, feedback } = fields;
      if (decision !== "approve" && decision !== "continue" && decision !== "cancel" ||
          feedback !== undefined && (decision !== "continue" || typeof feedback !== "string" || !feedback.trim() || feedback.length > 4096)) {
        throw new WebRequestError(400, "Invalid plan decision");
      }
      pending.settle({ decision, ...(typeof feedback === "string" ? { feedback: visible(feedback) } : {}) });
      return;
    }
    const answers: Record<string, string> = {};
    for (const { id } of pending.view.questions) {
      const value = Object.hasOwn(fields, id) ? fields[id] : undefined;
      if (typeof value !== "string" || !value.trim() || value.length > 4_096) throw new WebRequestError(400, "Answer each question");
      Object.defineProperty(answers, id, { value: visible(value), enumerable: true });
    }
    pending.settle(answers);
  }

  async #run(active: ActiveTurn, prompt: string, data: InteractivePromptData, plan: boolean): Promise<void> {
    const { sessionId, modelId } = active;
    const titleInput = prompt.trim() || data.uploadedFiles?.[0]?.name || "";
    let continueQueue = false;
    let proceedWithoutUntrustedMcp = false;
    try {
      if (sessionId === null) active.history = [];
      const result = await runInteractiveTask({
        ...data,
        plan,
        prompt, workspacePath: this.#state.workspace, signal: active.controller.signal,
        ...(sessionId ? { resume: sessionId } : {}),
        ...(modelId ? { model: modelId } : {}),
        onEvent: event => {
          if (event.type === "team_updated" || event.type === "agent_updated" || event.type === "agent_integrated" || event.type === "team_usage") {
            void this.#refreshSessions().then(() => this.#stateChanged()).catch(error => {
              if (this.#state.sessionId === active.sessionId) this.#state.error ??= failure(error);
            });
            return;
          }
          if (event.type !== "session_started" || active.sessionId !== null) return;
          this.#adoptSession(active, event.sessionId);
          const firstLine = titleInput.split(/\r?\n/u)[0]!;
          const now = new Date().toISOString();
          this.#sessionRevision++;
          this.#state.sessions.unshift({
            id: event.sessionId, title: visible(firstLine).slice(0, 54),
            createdAt: now, updatedAt: now, modelId: event.modelId, blank: false,
          });
          this.#stateChanged();
        },
      }, this.#dependencies, {
        backgroundJobs: this.jobs.observer(() => active.sessionId),
        confirm: async (_kind, tool, text, signal) => (await this.#ask(active, { kind: "approval", tool, prompt: text }, signal)) === true,
        skillInput: text => {
          const name = /^\/([^\s]+)/u.exec(text.trimStart())?.[1];
          return name && skillName.test(name) && !harnessCommandNames.has(name) ? { text, slashName: name } : { text };
        },
        confirmWithoutUntrustedMcp: async signal => {
          if (proceedWithoutUntrustedMcp) return true;
          const language = this.#state.language;
          const proceed = uiText("web.mcp.continue", {}, language);
          const answer = await this.#ask(active, { kind: "question", questions: [{
            id: "mcp_startup", header: "MCP", question: uiText("web.mcp.pendingTrust", {}, language),
            options: [
              { label: proceed, description: uiText("web.mcp.continue.detail", {}, language) },
              { label: uiText("web.mcp.stop", {}, language), description: uiText("web.mcp.stop.detail", {}, language) },
            ],
          }] }, signal);
          proceedWithoutUntrustedMcp = typeof answer !== "boolean" && answer.mcp_startup === proceed;
          return proceedWithoutUntrustedMcp;
        },
        ask: async ({ questions }, signal) => {
          const view = questions.map(question => ({
            ...question, question: visible(question.question), header: visible(question.header),
            options: question.options.map(option => ({ label: visible(option.label), description: visible(option.description) })),
          }));
          const answer = await this.#ask(active, { kind: "question", questions: view }, signal);
          return typeof answer === "boolean" ? {} : answer;
        },
        reviewPlan: async (submitted, callId, signal) => {
          const answer = await this.#ask(active, { kind: "plan", submitted, callId }, signal);
          if (typeof answer === "boolean") throw new Error("Invalid plan decision");
          return normalizePlanReview({
            decision: answer.decision as PlanReviewDecision,
            ...(answer.feedback === undefined ? {} : { feedback: answer.feedback }),
          });
        },
        onPlanImplementation: () => {
          if (sessionId) this.#setPlanMode(sessionId, false);
          this.#stateChanged();
        },
        onSettlement: () => { active.settling = true; },
        onGoal: (id, goal, revision) => this.#publishGoal(id, goal, revision),
        onSteeringReady: offer => { active.offerSteering = offer; },
        onHistoryLoaded: entries => {
          active.history = entries.flatMap(entry => entry.kind === "status" ? [] : [messageView(entry)]);
        },
        onTimeline: entry => {
          if (entry.kind === "assistant" || entry.plan || entry.web_input) active.view.delta = "";
          active.view.entries.push(messageView(entry));
          if (entry.web_input && sessionId) {
            const inbox = this.#inboxes.get(sessionId);
            if (inbox) inbox.pending = inbox.pending.filter(item => item.id !== entry.web_input?.id);
            active.steering.delete(entry.web_input.id);
            this.#stateChanged();
          }
          this.#turnChanged(active);
        },
        onDelta: text => {
          active.view.delta = (active.view.delta + text).slice(-64_000);
          this.#turnChanged(active);
        },
        onTool: (id, name, output) => {
          if (output === undefined) active.view.tools.push({ id, name });
          else active.view.tools = active.view.tools.filter(tool => tool.id !== id);
          this.#turnChanged(active);
        },
      });
      if (result.sessionId && active.sessionId === null) this.#adoptSession(active, result.sessionId);
      this.#settle(active, result);
      continueQueue = result.classification === "success" || (result.classification === "cancelled" && active.resumeInbox === true);
      if (sessionId && active.view.entries.some(entry => entry.kind === "user")) {
        await this.#store.activity.withInactive(sessionId, async () => {
          const { summary } = await this.#store.load(sessionId);
          if (summary.title_pending) await this.#store.updateTitle(sessionId, deterministicExecTitle(titleInput).slice(6));
        });
      }
    } catch (error) {
      if (this.#state.sessionId === active.sessionId) this.#state.error ??= failure(error);
    } finally {
      active.controller.abort();
      // Keep admission occupied while synchronizing the durable session picker.
      await Promise.all([this.#refreshSessions(), this.refreshPermissionCap()]).catch(error => {
        if (this.#state.sessionId === active.sessionId) this.#state.error ??= failure(error);
      });
      clearTimeout(active.flushTimer);
      const activity = this.#activity(active, true);
      this.#active.delete(active.sessionId);
      if (this.#state.sessionId === active.sessionId && active.history) this.#state.timeline = [...activity.timeline];
      for (const listener of this.#listeners) listener({ activity });
      this.#stateChanged();
      if (continueQueue && sessionId) void this.#serializeInbox(async () => { this.#startPending(sessionId); }).catch(() => undefined);
    }
  }

  #adoptSession(active: ActiveTurn, id: string): void {
    this.#active.delete(null);
    active.sessionId = id;
    this.#active.set(id, active);
    if (this.#state.sessionId === null) this.#state.sessionId = id;
  }

  #settle(active: ActiveTurn, result: ExecResult): void {
    if (result.status === "cleanup_failed") {
      this.#state.blocked = true;
      for (const sibling of this.#active.values()) {
        if (sibling !== active) this.#stop(sibling, new Error("Another task could not confirm workspace resource cleanup"));
      }
    }
    if (result.classification === "success" || this.#state.sessionId !== active.sessionId) return;
    this.#state.error = result.error ?? result.classification;
    if (result.classification === "cancelled") this.#state.error = "cancelled";
  }

  #ask(active: ActiveTurn, body: InteractionBody, signal?: AbortSignal): Promise<InteractionAnswer> {
    const tiedSignal = signal ? AbortSignal.any([signal, active.controller.signal]) : active.controller.signal;
    tiedSignal.throwIfAborted();
    const view: WebInteraction = { ...body, id: randomUUID() };
    return new Promise((resolve, reject) => {
      const remove = () => {
        tiedSignal.removeEventListener("abort", abort);
        active.pending.delete(view.id);
        active.view.interaction = active.pending.values().next().value?.view ?? null;
        this.#turnChanged(active);
      };
      const abort = () => { remove(); reject(tiedSignal.reason); };
      active.pending.set(view.id, { view, signal: tiedSignal, settle(value) { remove(); resolve(value); } });
      tiedSignal.addEventListener("abort", abort, { once: true });
      active.view.interaction ??= view;
      this.#turnChanged(active);
    });
  }

  #requireTurn(id: string): ActiveTurn {
    const active = [...this.#active.values()].find(turn => turn.view.id === id);
    if (this.#closing || !active) throw new WebRequestError(409, "This turn is no longer running");
    return active;
  }

  #assertSessionIdle(id: string | null): void {
    if (id && (this.#active.has(id) || this.#inboxHolds.has(id))) throw this.#sessionActive(id);
    if (this.#active.has(id) || this.#closing) throw new WebRequestError(409, "The workbench is busy");
    if (this.#state.blocked) throw new WebRequestError(409, "Restart the workbench after checking the cleanup error");
  }

  #assertWorkspace(session: SessionSummary): void {
    if (normalizeWorkspacePath(session.workspace_path) !== normalizeWorkspacePath(this.#state.workspace)) {
      throw new WebRequestError(404, "Session is unavailable in this workspace");
    }
  }

  #sessionActive(id: string): WebRequestError {
    return new WebRequestError(409, "The session still has active work", "workspace/session-active", {
      sessionId: id, activity: [{ kind: "turn" }],
    });
  }

  async #withInactiveSession<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.requireSession(id);
    try {
      return await this.#store.activity.withInactive(id, async () => {
        const { summary } = await this.#store.load(id);
        this.#assertWorkspace(summary);
        return operation();
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw this.#sessionActive(id);
      throw error;
    }
  }

  async #operation<T>(update: () => Promise<T>): Promise<T> {
    if (this.#closing) throw new WebRequestError(409, "The workbench is busy");
    const pending = Promise.resolve(this.#pendingOperation).catch(() => undefined).then(() => {
      if (this.#closing) throw new WebRequestError(409, "The workbench is busy");
      return update();
    });
    this.#pendingOperation = pending;
    try { return await pending; }
    finally { if (this.#pendingOperation === pending) this.#pendingOperation = undefined; this.#stateChanged(); }
  }

  #refreshSessions(): Promise<void> {
    const refresh = async () => {
      const workspace = normalizeWorkspacePath(this.#state.workspace);
      for (;;) {
        const before = this.#sessionRevision;
        const { sessions } = await this.#store.list();
        if (before !== this.#sessionRevision) continue;
        this.#state.sessions = sessions.filter(item => normalizeWorkspacePath(item.workspace_path) === workspace).map(sessionView);
        return;
      }
    };
    return this.#sessionRefresh = this.#sessionRefresh.then(refresh, refresh);
  }

  async #refreshModels() {
    const models = await this.#dependencies.registry.resolveAll();
    this.#state.models = models.available.map(model => {
      const provider = openCodeGoModelsUrl(model.base_url) ? "opencode-go" : providerKind(model.base_url);
      return {
        id: model.id,
        name: model.model_name,
        supportsImages: supportsResponsesImages(model.base_url, model.model_name),
        provider: provider === "compatible"
          ? URL.parse(model.base_url)?.hostname || "OpenAI-compatible"
          : getProviderDefinition(provider).displayName,
      };
    });
    return models;
  }

  #stateChanged(): void {
    const state = this.#publicState();
    for (const listener of this.#listeners) listener({ state });
  }

  #publicState(): WebState {
    const inboxes = Object.fromEntries([...this.#inboxes].map(([id, inbox]) => {
      const active = this.#active.get(id);
      const messages: WebInboxMessage[] = inbox.pending.map(item => ({
        id: item.id, requestId: item.requestId, text: visible(item.text),
        placement: active?.inboxItem === item.id || active?.steering.has(item.id) ? "next-step" : "next-turn",
        ...(item.uploadedFiles ? { files: item.uploadedFiles } : {}),
      }));
      return [id, messages];
    }));
    const active = this.#active.get(this.#state.sessionId);
    return {
      ...this.#state, sessions: [...this.#state.sessions], timeline: [...(active?.history ?? this.#state.timeline)],
      turn: active ? this.#publicTurn(active.view) : null,
      turns: Object.fromEntries([...this.#active.values()].flatMap(({ sessionId, view: { id, stopping, interaction } }) =>
        sessionId ? [[sessionId, { id, stopping, interaction }]] : [])),
      inboxes,
    };
  }

  #publicTurn(turn: WebTurn): WebTurn {
    return { ...turn, entries: [...turn.entries], tools: [...turn.tools], delta: visible(turn.delta) };
  }

  #activity(active: ActiveTurn, settled = false): WebSessionActivity {
    return { sessionId: active.sessionId, timeline: [...active.history ?? [], ...active.view.entries], turn: settled ? null : this.#publicTurn(active.view) };
  }

  #turnChanged(active: ActiveTurn): void {
    if (active.flushTimer) return;
    active.flushTimer = setTimeout(() => {
      delete active.flushTimer;
      if (this.#active.get(active.sessionId) !== active || !active.history) return;
      const activity = this.#activity(active);
      for (const listener of this.#listeners) listener({ activity });
    }, 40);
  }
}
