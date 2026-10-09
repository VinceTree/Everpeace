import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { render as renderInk } from "ink-testing-library";
import React, { act } from "react";
import type { AgentIO } from "../../../src/agent/react-agent.js";
import { LoopStoppedError } from "../../../src/agent/agent-loop.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
  StoredModelRegistration,
} from "../../../src/storage/model-registry.js";
import type {
  CreateSessionInput,
  LoadedSession,
  SessionModelRef,
  SessionStoreLike,
  SessionSummary,
  StoredTimelineEntry,
} from "../../../src/storage/session-store.js";
import type { BashResult } from "../../../src/tools/bash.js";
import {
  applyUsageSample,
  applyCompactionUsage,
  createEmptySessionUsage,
  resetContextUsage,
  type TokenUsageSample,
} from "../../../src/status/model-status.js";
import {
  EverpeaceApp,
  formatElapsed,
  RESIZE_REDRAW_DEBOUNCE_MS,
} from "../../../src/tui/app/app.js";
import {
  SLASH_COMMANDS,
  type SlashCommand,
} from "../../../src/tui/commands/slash-commands.js";
import { textWidth } from "../../../src/tui/rendering/text-width.js";
import { cloneTaskProgress, type TaskProgress } from "../../../src/workflow/task-progress.js";
import { normalizePlanReview } from "../../../src/plan/runtime.js";

const renderedViews = new Set<ReturnType<typeof renderInk>>();

function render(tree: Parameters<typeof renderInk>[0]): ReturnType<typeof renderInk> {
  const view = renderInk(tree);
  renderedViews.add(view);
  return view;
}

afterEach(() => {
  for (const view of renderedViews) {
    view.cleanup();
    // The testing library retains its renderers after unmount; release captured
    // output only after each test has finished all frame and privacy assertions.
    view.frames.length = 0;
    view.stderr.frames.length = 0;
  }
  renderedViews.clear();
});

test("formats active turn elapsed time with useful units", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(59), "59s");
  assert.equal(formatElapsed(60), "1m 0s");
  assert.equal(formatElapsed(65), "1m 5s");
  assert.equal(formatElapsed(3600), "1h 0m 0s");
  assert.equal(formatElapsed(3723), "1h 2m 3s");
});
import type {
  AgentRestoreOptions,
  AgentSession,
  TuiDependencies,
  TuiModelRegistry,
} from "../../../src/tui/app/types.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for TUI update");
}

function visibleSlashCommandLines(frame: string): SlashCommand[] {
  const commands = new Set<string>(SLASH_COMMANDS);
  return frame
    .split("\n")
    .map((line) => line.trim().replace(/^›\s+/u, ""))
    .filter((line): line is SlashCommand => commands.has(line));
}

function lastBorderedSurface(frame: string): string {
  const lines = frame.split("\n");
  let bottom = lines.length - 1;
  while (bottom >= 0 && !lines[bottom]!.trimStart().startsWith("╰")) bottom -= 1;
  assert.ok(bottom >= 0, "expected a bordered command surface");
  let top = bottom;
  while (top >= 0 && !lines[top]!.trimStart().startsWith("╭")) top -= 1;
  assert.ok(top >= 0, "expected the command surface top border");
  return lines.slice(top, bottom + 1).join("\n");
}

function timelineText(entries: readonly StoredTimelineEntry[]): string {
  return entries.map((entry) => "text" in entry ? entry.text : "").join("\n");
}

function stored(model: RegisteredModel): StoredModelRegistration {
  return {
    id: model.id,
    model_name: model.model_name,
    base_url: model.base_url,
    auth_ref: `model:${model.id}`,
    created_at: "2026-09-14T00:00:00.000Z",
    updated_at: "2026-09-14T00:00:00.000Z",
  };
}

function status(model: RegisteredModel): RegisteredModelStatus {
  return { ...stored(model), credential_status: "ready" };
}

interface MemorySessionStore extends SessionStoreLike {
  readonly sessions: Map<string, LoadedSession>;
}

function createMemorySessionStore(): MemorySessionStore {
  const sessions = new Map<string, LoadedSession>();
  let nextSessionId = 0;
  let clock = 0;
  const timestamp = () => `2026-09-16T00:00:${String(clock++).padStart(2, "0")}.000Z`;
  const requireSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    assert.ok(session);
    return session;
  };
  return {
    sessions,
    async create(input: CreateSessionInput) {
      const at = timestamp();
      const summary: SessionSummary = {
        id: `session-${++nextSessionId}`,
        title: input.title,
        title_pending: input.titlePending,
        created_at: at,
        updated_at: at,
        workspace_path: input.workspacePath,
        model: { ...input.model },
      };
      sessions.set(summary.id, {
        summary,
        timeline: [],
        context: [],
        usage: createEmptySessionUsage(),
      });
      return { ...summary, model: { ...summary.model } };
    },
    async updateTitle(sessionId, title) {
      const session = requireSession(sessionId);
      session.summary.title = title;
      session.summary.title_pending = false;
      session.summary.updated_at = timestamp();
    },
    async appendTimeline(sessionId, entry: StoredTimelineEntry) {
      const session = requireSession(sessionId);
      session.timeline.push({ ...entry });
      session.summary.updated_at = timestamp();
    },
    async appendContext(sessionId, items) {
      const session = requireSession(sessionId);
      session.context.push(...items.map((item) => ({ ...item })));
      session.summary.updated_at = timestamp();
    },
    async compactContext(sessionId, items, _automatic, usage) {
      const session = requireSession(sessionId);
      session.context = items.map((item) => ({ ...item }));
      session.usage = applyCompactionUsage(session.usage, usage);
      session.summary.updated_at = timestamp();
    },
    async appendUsage(sessionId, usage: TokenUsageSample | null) {
      const session = requireSession(sessionId);
      session.usage = applyUsageSample(session.usage, usage);
      session.summary.updated_at = timestamp();
    },
    async selectModel(
      sessionId: string,
      model: SessionModelRef,
      preserveContext: boolean,
    ) {
      const session = requireSession(sessionId);
      session.summary.model = { ...model };
      if (!preserveContext) session.context = [];
      session.usage = resetContextUsage(session.usage, preserveContext);
      session.summary.updated_at = timestamp();
    },
    async setTaskProgress(sessionId: string, progress: TaskProgress) {
      const session = requireSession(sessionId);
      session.taskProgress = cloneTaskProgress(progress);
      session.summary.task_progress = cloneTaskProgress(progress);
      session.summary.updated_at = timestamp();
    },
    async setGoal(sessionId, goal) {
      const session = requireSession(sessionId);
      session.goal = { ...goal };
      session.summary.goal = { ...goal };
      session.summary.updated_at = timestamp();
    },
    async updateGoal(sessionId, patch) {
      const session = requireSession(sessionId);
      assert.ok(session.goal);
      session.goal = { ...session.goal, ...patch };
      session.summary.goal = { ...session.goal };
      session.summary.updated_at = timestamp();
    },
    async setWorkflow(sessionId, workflow) {
      const session = requireSession(sessionId);
      session.workflow = structuredClone(workflow);
      session.summary.workflow = structuredClone(workflow);
      session.summary.updated_at = timestamp();
    },
    async setMemoryPolicy(sessionId, policy) {
      const session = requireSession(sessionId);
      session.memoryPolicy = { ...policy };
      session.summary.memory_policy = { ...policy };
      session.summary.updated_at = timestamp();
    },
    async fork(sessionId, input = {}) {
      input.signal?.throwIfAborted();
      const parent = requireSession(sessionId);
      const at = timestamp();
      const id = `session-${++nextSessionId}`;
      const lineage = {
        parent_session_id: sessionId,
        forked_at: at,
        source_boundary_bytes: parent.timeline.length,
        source_header_sha256: `header-${sessionId}`,
      };
      const title = input.title?.trim() || `${parent.summary.title} (fork)`;
      const summary: SessionSummary = {
        id,
        title,
        title_pending: false,
        created_at: at,
        updated_at: at,
        workspace_path: parent.summary.workspace_path,
        model: { ...parent.summary.model },
        ...(parent.workflow ? { workflow: structuredClone(parent.workflow) } : {}),
        ...(parent.taskProgress ? {
          task_progress: {
            ...cloneTaskProgress(parent.taskProgress),
            inherited_from_session_id: sessionId,
          },
        } : {}),
        ...(parent.memoryPolicy ? { memory_policy: { ...parent.memoryPolicy } } : {}),
        lineage,
        fork_pending_resume: true,
      };
      const taskProgress = summary.task_progress === undefined
        ? undefined
        : cloneTaskProgress(summary.task_progress);
      sessions.set(id, {
        summary,
        timeline: parent.timeline.map((entry) => ({ ...entry })),
        context: parent.context.map((item) => ({ ...item })),
        usage: createEmptySessionUsage(),
        ...(parent.workflow ? { workflow: structuredClone(parent.workflow) } : {}),
        ...(taskProgress ? { taskProgress } : {}),
        ...(parent.memoryPolicy ? { memoryPolicy: { ...parent.memoryPolicy } } : {}),
        lineage,
        forkPendingResume: true,
      });
      return { ...summary, model: { ...summary.model } };
    },
    async setForkPendingResume(sessionId, pending) {
      const session = requireSession(sessionId);
      session.forkPendingResume = pending;
      session.summary.fork_pending_resume = pending;
      session.summary.updated_at = timestamp();
    },
    async list() {
      return {
        sessions: [...sessions.values()]
          .map(({ summary }) => ({ ...summary, model: { ...summary.model } }))
          .sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
        skipped: 0,
      };
    },
    async deleteMany(sessionIds) {
      for (const sessionId of sessionIds) sessions.delete(sessionId);
    },
    async load(sessionId) {
      const session = requireSession(sessionId);
      return {
        summary: {
          ...session.summary,
          model: { ...session.summary.model },
          ...(session.summary.task_progress ? { task_progress: cloneTaskProgress(session.summary.task_progress) } : {}),
        },
        timeline: session.timeline.map((entry) => ({ ...entry })),
        context: session.context.map((item) => ({ ...item })),
        usage: { ...session.usage },
        ...(session.goal ? { goal: { ...session.goal } } : {}),
        ...(session.workflow ? { workflow: structuredClone(session.workflow) } : {}),
        ...(session.taskProgress ? { taskProgress: cloneTaskProgress(session.taskProgress) } : {}),
        ...(session.memoryPolicy ? { memoryPolicy: { ...session.memoryPolicy } } : {}),
        ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
        ...(session.forkPendingResume === undefined ? {} : { forkPendingResume: session.forkPendingResume }),
      };
    },
  };
}

function createFixture(options?: {
  initial?: RegisteredModel[];
  createAgent?: (
    model: RegisteredModel,
    io: AgentIO,
    restore?: AgentRestoreOptions,
  ) => AgentSession;
}) {
  let available = options?.initial ?? [];
  const registry: TuiModelRegistry = {
    async resolveAll(): Promise<ResolvedModels> {
      return { available, missing: [] };
    },
    async listStatuses() {
      return available.map(status);
    },
    async registerMany(baseUrl, modelNames, apiKey) {
      const registrations = modelNames.map((modelName, index) => {
        const model: RegisteredModel = {
          id: `registered-${index}`,
          model_name: modelName,
          base_url: baseUrl,
          api_key: apiKey,
        };
        available = [model];
        return stored(model);
      });
      return registrations;
    },
    async removeMany(ids) {
      const removed = available.filter((model) => ids.includes(model.id)).map(stored);
      available = available.filter((model) => !ids.includes(model.id));
      return removed;
    },
  };
  const sessionStore = createMemorySessionStore();
  const dependencies: TuiDependencies = {
    registry,
    version: "0.1.19",
    workspacePath: "C:\\workspace",
    sessionStore,
    async listModels() {
      return ["deepseek-flash"];
    },
    createAgent:
      options?.createAgent ??
      ((_model, io, restore) => ({
        async runTurn(input) {
          await restore?.onContextAppend?.([{ role: "user", content: input }]);
          io.writeAssistant(`echo: ${input}`);
          await restore?.onContextAppend?.([
            { type: "message", role: "assistant", content: `echo: ${input}` },
          ]);
          return {};
        },
      })),
    async generateSessionTitle(_model, firstQuestion) {
      return firstQuestion;
    },
    async changeWorkspace(workspacePath) {
      return workspacePath;
    },
    async runBash() {
      return { stdout: "ok\n", stderr: "", exitCode: 0, signal: null };
    },
    async runTerminalCommand() {
      return { stdout: "", stderr: "", exitCode: 0, signal: null };
    },
  };
  return { dependencies, registry, sessionStore };
}

const planModel: RegisteredModel = { id: "plan-test", model_name: "offline", base_url: "https://example.com/v1", api_key: "fixture" };
const approvedBody = "Inspect src/value.ts\n\nKeep the user's changes.\nUse exact replacement and run all checks.\n\nEND_OF_APPROVED_PLAN";

function createPlanFixture(options: { endTask?: () => Promise<void>; coding?: (signal?: AbortSignal) => Promise<void> } = {}) {
  const inputs: Array<{ text: string; mode: string }> = [];
  const starts: Array<{ mode: string; source: string }> = [];
  let interaction!: AgentIO;
  const fixture = createFixture({ initial: [planModel], createAgent: (_model, io, restore) => {
    interaction = io;
    return {
      beginTask(input) { starts.push({ mode: input.mode, source: input.source }); },
      async runTurn(text, signal, input) {
        inputs.push({ text, mode: input?.mode ?? "default" });
        if (input?.mode === "plan") {
          const review = normalizePlanReview(await io.reviewPlan!({ title: "Approved offline plan", plan: approvedBody }, signal));
          return { planDecision: review.decision, ...(review.decision === "approve" ? { approvedPlan: approvedBody, approvedPlanTitle: "Approved offline plan" } : {}) };
        }
        await options.coding?.(signal);
        io.writeAssistant("Explicit execution finished");
        return {};
      },
      async compact() {
        const items = [{ role: "assistant", content: "A summary without the approved plan body" }];
        await restore?.onContextCompacted?.(items, false, null);
        return { items, usage: null };
      },
      async endTask() { await options.endTask?.(); },
    };
  } });
  return { ...fixture, inputs, starts, interaction: () => interaction };
}

async function submitInput(view: ReturnType<typeof render>, text: string): Promise<void> {
  view.stdin.write(text);
  await tick();
  view.stdin.write("\r");
}

async function approvePlan(view: ReturnType<typeof render>): Promise<void> {
  await submitInput(view, "/plan inspect the implementation");
  await waitFor(() => (view.lastFrame() ?? "").includes("Approve plan"));
  await tick();
  view.stdin.write("\r");
  try {
    await waitFor(() => (view.lastFrame() ?? "").includes("Plan approved. Run /plan execute to start."));
  } catch { assert.fail(view.lastFrame()); }
}

test("an approved plan waits, survives compaction, and executes its full body only once", async () => {
  const fixture = createPlanFixture();
  let commands = 0;
  fixture.dependencies.runBash = async () => { commands++; return { stdout: "", stderr: "", exitCode: 0, signal: null }; };
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    await approvePlan(view);
    assert.equal(fixture.inputs.length, 1);
    assert.equal(commands, 0);
    assert.equal(fixture.sessionStore.sessions.get("session-1")?.workflow, undefined);
    await submitInput(view, "/plan show");
    await waitFor(() => (view.lastFrame() ?? "").includes("/plan show · Approved offline plan"));
    assert.match(view.lastFrame() ?? "", /END_OF_APPROVED_PLAN/u);
    assert.equal(fixture.inputs.length, 1);
    view.stdin.write("\u001b");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
    await submitInput(view, "/compact");
    await waitFor(() => (view.lastFrame() ?? "").includes("Context compacted;"));
    await submitInput(view, "/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("Explicit execution finished"));
    assert.equal(fixture.inputs.length, 2);
    assert.equal(fixture.inputs[1]?.mode, "default");
    assert.ok(fixture.inputs[1]?.text.endsWith(approvedBody));
    assert.match(fixture.inputs[1]?.text ?? "", /Approved offline plan/u);
    await submitInput(view, "/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("No approved plan is available"));
    assert.equal(fixture.inputs.length, 2);
  } finally { view.unmount(); }
});

test("discussion, exit, new, clear, fork, and Agent replacement invalidate approval", async (context) => {
  for (const action of ["discussion", "/plan exit", "/new", "/clear", "/fork child", "/model"]) await context.test(action, async () => {
    const fixture = createPlanFixture();
    const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
    try {
      await tick();
      await approvePlan(view);
      await submitInput(view, action);
      if (action === "discussion") {
        await waitFor(() => fixture.inputs.length === 2 && (view.lastFrame() ?? "").includes("Approve plan"));
        assert.equal(fixture.inputs[1]?.mode, "plan");
        await tick();
        view.stdin.write("\u001b");
        await waitFor(() => (view.lastFrame() ?? "").includes("Plan mode cancelled"));
      } else if (action === "/model") {
        await waitFor(() => (view.lastFrame() ?? "").includes("Enter confirm"));
        await tick();
        view.stdin.write("\r");
        await waitFor(() => (view.lastFrame() ?? "").includes("conversation context was reset"));
      } else {
        await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace") && (action !== "/new" || fixture.sessionStore.sessions.size === 2) && (action !== "/fork child" || fixture.sessionStore.sessions.size === 2));
      }
      await submitInput(view, "/plan execute");
      await waitFor(() => (view.lastFrame() ?? "").includes("No approved plan is available"));
      assert.ok(fixture.inputs.every((input) => input.mode === "plan"));
    } finally { view.unmount(); }
  });
});

test("failed session creation or fork leaves the approved plan available", async (context) => {
  for (const action of ["/new", "/fork child"]) await context.test(action, async () => {
    const fixture = createPlanFixture();
    const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
    try {
      await tick();
      await approvePlan(view);
      fixture.sessionStore.create = async () => { throw new Error("Session operation failed"); };
      fixture.sessionStore.fork = async () => { throw new Error("Session operation failed"); };
      await submitInput(view, action);
      await waitFor(() => (view.lastFrame() ?? "").includes("Session operation failed"));
      await tick();
      view.stdin.write("\u001b");
      await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
      await submitInput(view, "/plan show");
      await waitFor(() => (view.lastFrame() ?? "").includes("/plan show · Approved offline plan"));
    } finally { view.unmount(); }
  });
});

test("already-cancelled review never opens a window and late decisions are ignored", async () => {
  const fixture = createPlanFixture();
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    const controller = new AbortController();
    controller.abort();
    assert.equal(await fixture.interaction().reviewPlan!({ title: "Late plan", plan: "Do work" }, controller.signal), "cancel");
    assert.doesNotMatch(view.lastFrame() ?? "", /Late plan/u);
    await submitInput(view, "/plan plan a change");
    await waitFor(() => (view.lastFrame() ?? "").includes("Approve plan"));
    await tick();
    view.stdin.write("\u0003");
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Model request cancelled"));
    await submitInput(view, "/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("No approved plan is available"));
    assert.equal(fixture.inputs.length, 1);
  } finally { view.unmount(); }
});

test("explicit execution is single-use through cancellation and refuses overlapping starts", async () => {
  const fixture = createPlanFixture({ coding: async (signal) => {
    await new Promise<void>((_resolve, reject) => {
      const cancel = () => reject(signal?.reason ?? new Error("cancelled"));
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
    });
  } });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    await approvePlan(view);
    await submitInput(view, "/plan execute");
    await waitFor(() => fixture.inputs.length === 2 && (view.lastFrame() ?? "").includes("Add guidance"));
    await submitInput(view, "/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("A task or command is active"));
    assert.equal(fixture.inputs.length, 2);
    view.stdin.write("\u0003");
    await waitFor(() => (view.lastFrame() ?? "").includes("Model request cancelled"));
    await submitInput(view, "/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("No approved plan is available"));
    assert.equal(fixture.inputs.length, 2);
  } finally { view.unmount(); }
});

test("approval is unavailable during cleanup and cancellation there prevents publication", async () => {
  let release!: () => void;
  let cleaning = false;
  const fixture = createPlanFixture({ endTask: async () => { cleaning = true; await new Promise<void>((resolve) => { release = resolve; }); } });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    await submitInput(view, "/plan inspect");
    await waitFor(() => (view.lastFrame() ?? "").includes("Approve plan"));
    await tick();
    view.stdin.write("\r");
    await waitFor(() => cleaning && (view.lastFrame() ?? "").includes("Add guidance"));
    await submitInput(view, "/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("A task or command is active"));
    assert.equal(fixture.inputs.length, 1);
    view.stdin.write("\u0003");
    release();
    await waitFor(() => (view.lastFrame() ?? "").includes("Model request cancelled"));
    await submitInput(view, "/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("No approved plan is available"));
  } finally { release?.(); view.unmount(); }
});

test("clearing during Plan cleanup releases admission without publishing the old result", async () => {
  let release!: () => void;
  let cleaning = false;
  const fixture = createPlanFixture({ endTask: async () => {
    if (cleaning) return;
    cleaning = true;
    await new Promise<void>((resolve) => { release = resolve; });
  } });
  const createAgent = fixture.dependencies.createAgent;
  let agentsCreated = 0;
  fixture.dependencies.createAgent = (model, io, restore) => {
    agentsCreated++;
    return createAgent(model, io, restore);
  };
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    await submitInput(view, "/plan inspect");
    await waitFor(() => (view.lastFrame() ?? "").includes("Approve plan"));
    await tick();
    view.stdin.write("\r");
    await waitFor(() => cleaning && (view.lastFrame() ?? "").includes("Add guidance"));
    await submitInput(view, "/clear");
    await waitFor(() => agentsCreated === 2 && !(view.lastFrame() ?? "").includes("› inspect"));
    await submitInput(view, "keep this suggestion");
    await waitFor(() => (view.lastFrame() ?? "").includes("1 guidance message pending"));
    assert.equal(fixture.inputs.length, 1);
    release();
    try {
      await waitFor(() => (view.lastFrame() ?? "").includes("Pending guidance was returned to your draft"));
    } catch { assert.fail(view.lastFrame()); }
    assert.doesNotMatch(view.lastFrame() ?? "", /Plan approved|Model request cancelled/u);
    assert.match(view.lastFrame() ?? "", /keep this suggestion/u);
    assert.equal(fixture.inputs.length, 1);
    view.stdin.write("\u0003");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
    await submitInput(view, "/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("No approved plan is available"));
    await submitInput(view, "fresh discussion");
    await waitFor(() => fixture.inputs.length === 2 && (view.lastFrame() ?? "").includes("Explicit execution finished"));
    assert.equal(fixture.inputs[1]?.text, "fresh discussion");
    assert.equal(fixture.inputs[1]?.mode, "default");
  } finally { release?.(); view.unmount(); }
});

test("late initial Session creation cannot reattach after clearing the conversation", async () => {
  const fixture = createPlanFixture();
  const create = fixture.sessionStore.create.bind(fixture.sessionStore);
  let release!: () => void;
  let creations = 0;
  fixture.sessionStore.create = async (options) => {
    const session = await create(options);
    if (++creations === 1) await new Promise<void>((resolve) => { release = resolve; });
    return session;
  };
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    await submitInput(view, "old task");
    await waitFor(() => Boolean(release) && (view.lastFrame() ?? "").includes("Creating session"));
    await submitInput(view, "/clear");
    await tick();
    release();
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
    assert.equal(fixture.inputs.length, 0);
    assert.doesNotMatch(view.lastFrame() ?? "", /Session creation failed|old task/u);
    await submitInput(view, "fresh task");
    await waitFor(() => fixture.inputs.length === 1 && (view.lastFrame() ?? "").includes("Explicit execution finished"));
    assert.equal(creations, 2);
    assert.equal(fixture.inputs[0]?.text, "fresh task");
    assert.doesNotMatch(timelineText(fixture.sessionStore.sessions.get("session-1")!.timeline), /fresh task/u);
    assert.match(timelineText(fixture.sessionStore.sessions.get("session-2")!.timeline), /fresh task/u);
  } finally { release?.(); view.unmount(); }
});

test("queued Plan guidance returns to the draft after approval or cancellation without sampling", async (context) => {
  for (const decision of ["approve", "cancel"]) await context.test(decision, async () => {
    let release!: () => void;
    const fixture = createPlanFixture({ endTask: () => new Promise<void>((resolve) => { release = resolve; }) });
    const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
    try {
      await tick();
      await submitInput(view, "/plan inspect");
      await waitFor(() => (view.lastFrame() ?? "").includes("Approve plan"));
      await tick();
      view.stdin.write(decision === "approve" ? "\r" : "\u001b");
      await waitFor(() => Boolean(release) && (view.lastFrame() ?? "").includes("Add guidance"));
      await submitInput(view, "Include offline checks");
      release();
      await waitFor(() => (view.lastFrame() ?? "").includes("Pending guidance was returned to your draft"));
      assert.equal(fixture.inputs.length, 1);
      assert.match(view.lastFrame() ?? "", /Include offline checks/u);
    } finally { release?.(); view.unmount(); }
  });
});

test("Ctrl+C cancels direct commands, retains details, and accepts the next input", async () => {
  const model: RegisteredModel = { id: "cancel-model", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  const fixture = createFixture({ initial: [model] });
  let cancelled = false;
  fixture.dependencies.runTerminalCommand = async (_command, onOutput, signal) => {
    onOutput?.(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
    return { stdout: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"), stderr: "", exitCode: 1, signal: null, cancelled: true };
  };
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    view.stdin.write("!long-command");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Running"));
    assert.doesNotMatch(view.lastFrame() ?? "", /line 0\n/);
    assert.match(view.lastFrame() ?? "", /line 19/u);
    view.stdin.write("\u0003");
    await waitFor(() => cancelled && (view.lastFrame() ?? "").includes("Ask Everpeace"));
    assert.match(view.lastFrame() ?? "", /cancelled/);
    assert.match(view.lastFrame() ?? "", /\/outputs/);
    view.stdin.write("/outputs");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Esc to return to session"));
    await tick();
    view.stdin.write("\r");
    await waitFor(() => lastBorderedSurface(view.lastFrame() ?? "").includes("line 0"));
    view.stdin.write("\u001b");
    await waitFor(() => !lastBorderedSurface(view.lastFrame() ?? "").includes("line 0"));
    view.stdin.write("\u001b");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
    view.stdin.write("next turn");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("echo: next turn"));
  } finally {
    view.unmount();
  }
});

test("TUI accepts chat and renders the assistant response", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("你好");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: 你好"));

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /›\s+你好/);
  assert.match(frame, /•\s+echo: 你好/);
  assert.doesNotMatch(frame, /\b(?:you|assistant|bash)\b/);
  assert.doesNotMatch(frame, /https:\/\/api\.deepseek\.com/);
  assert.doesNotMatch(frame, /当前模型|登录状态/);
  assert.equal(frame.match(/deepseek-flash/g)?.length, 2);
  assert.match(frame, /model:\s+deepseek-flash\s+\/model to change/);
  assert.match(frame, /directory: C:\\workspace/);
  assert.match(frame, /C:\\workspace/);
  assert.doesNotMatch(frame, /Enter 发送|终端命令|命令菜单/);
  assert.match(frame, /╭.*╮/);
  assert.match(frame, /╰.*╯/);
  assert.match(frame, /Ask Everpeace to do anything/);
  const frameLines = frame.split("\n");
  const promptInput = frameLines.findIndex((line) =>
    line.includes("Ask Everpeace to do anything"),
  );
  assert.match(frameLines[promptInput] ?? "", /^\s*›/);
  const topBorders = frameLines.filter((line) => line.startsWith("╭"));
  assert.deepEqual(topBorders.map((line) => line.length), [60]);
  view.unmount();
});

test("coding questions block in the shared surface and Esc cancels task cleanup", async () => {
  const model: RegisteredModel = { id: "question-model", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  let cleanupCalls = 0;
  let endCalls = 0;
  let turns = 0;
  let alreadyAbortedRejected = false;
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async beginTask() {},
      async runTurn(_input, signal) {
        turns += 1;
        if (turns === 2) {
          const controller = new AbortController();
          controller.abort(new Error("already aborted"));
          try {
            await io.requestUserInput?.({
              questions: [{
                id: "path",
                header: "Path",
                question: "Which path?",
                options: [{ label: "Safe", description: "Use safe" }, { label: "Fast", description: "Use fast" }],
              }],
            }, controller.signal, "default");
          } catch (error) {
            alreadyAbortedRejected = error instanceof Error && /already aborted/u.test(error.message);
          }
          io.writeAssistant("question signal checked");
          return {};
        }
        await io.requestUserInput?.({
          questions: [{
            id: "approach",
            header: "Approach",
            question: "Which implementation should be used?",
            options: [
              { label: "Safe", description: "Use the safe implementation" },
              { label: "Fast", description: "Use the fast implementation" },
            ],
          }],
        }, signal, "default");
        signal?.throwIfAborted();
        return {};
      },
      async cancelBackgroundJobs() { cleanupCalls += 1; return []; },
      async endTask() { endCalls += 1; },
    }),
  });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    view.stdin.write("ask first");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("/question · Approach"));
    view.stdin.write("\u001b");
    await waitFor(() => cleanupCalls >= 1 && endCalls >= 1);
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
    assert.equal(cleanupCalls, 1);
    assert.equal(endCalls, 1);
    assert.equal((view.lastFrame() ?? "").match(/Ask Everpeace/g)?.length, 1);

    view.stdin.write("check aborted question");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => alreadyAbortedRejected && (view.lastFrame() ?? "").includes("question signal checked"));
    assert.doesNotMatch(view.lastFrame() ?? "", /\/question · Path/u);
    assert.equal((view.lastFrame() ?? "").match(/Ask Everpeace/g)?.length, 1);
  } finally {
    view.unmount();
  }
});

test("/tasks shows the persisted checklist and latest host workflow result", async () => {
  const model: RegisteredModel = { id: "tasks-model", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn() {
        await io.setTaskProgress?.({
          plan: [
            { step: "Inspect the runtime", status: "completed" },
            { step: "Verify the change", status: "in_progress" },
          ],
          updated_at: "2026-10-01T00:00:00.000Z",
        });
        io.writeAssistant("progress saved");
        return {};
      },
    }),
  });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    view.stdin.write("track work");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("progress saved"));
    view.stdin.write("/tasks");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("/tasks · Current task"));
    assert.match(view.lastFrame() ?? "", /Inspect the runtime/u);
    assert.match(view.lastFrame() ?? "", /Verify the change/u);
    assert.match(view.lastFrame() ?? "", /Last task result: no_changes/u);
    view.stdin.write("\u001b");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
  } finally {
    view.unmount();
  }
});

test("host workflow settles no-change goals without marking learned memory verified", async () => {
  const model: RegisteredModel = { id: "workflow-outcome", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  const completions: boolean[] = [];
  const memoryOutcomes: string[] = [];
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn() { io.writeAssistant("done"); return { goalCompletionRequested: true }; },
      async finalizePendingGoalCompletion(allow) { completions.push(allow); },
      async finishMemoryTurn(outcome) { memoryOutcomes.push(outcome); },
    }),
  });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    view.stdin.write("answer without edits");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => completions.length > 0);
    assert.deepEqual(completions, [true]);
    assert.deepEqual(memoryOutcomes, ["unverified"]);
  } finally { view.unmount(); }
});

test("/compact replaces persisted model context without removing the visible transcript", async () => {
  const model: RegisteredModel = {
    id: "compact-model",
    model_name: "test-model",
    base_url: "https://example.com/v1",
    api_key: "secret",
  };
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io, restore) => ({
      async runTurn(input) {
        await restore?.onContextAppend?.([{ role: "user", content: input }]);
        io.writeAssistant("visible answer");
        return {};
      },
      async compact() {
        const items = [{ type: "compaction", encrypted_content: "opaque" }];
        await restore?.onContextCompacted?.(items, false, { input_tokens: 20, output_tokens: 2, total_tokens: 22 });
        return { items, usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } };
      },
    }),
  });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );
  try {
    await tick();
    view.stdin.write("keep this transcript");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("visible answer"));
    view.stdin.write("/compact");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("full transcript remains available"));
    const session = [...fixture.sessionStore.sessions.values()][0];
    assert.ok(session);
    assert.deepEqual(session.context, [{ type: "compaction", encrypted_content: "opaque" }]);
    assert.match(view.lastFrame() ?? "", /keep this transcript/u);
  } finally {
    view.unmount();
  }
});

test("/compact explains usage and budget stops and returns to the same session", async (t) => {
  for (const reason of ["usage_limited", "budget_limited"] as const) await t.test(reason, async () => {
    const model: RegisteredModel = { id: "compact-stop", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" };
    const compactions: string[] = [];
    const fixture = createFixture({ initial: [model], createAgent: (_model, io, restore) => ({
      async runTurn(input) { await restore?.onContextAppend?.([{ role: "user", content: input }]); io.writeAssistant("Original answer"); return {}; },
      async compact() { compactions.push(reason); throw new LoopStoppedError(reason); },
    }) });
    const app = <EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />;
    const view = render(app);
    const flushInputEffects = async () => {
      const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previous = environment.IS_REACT_ACT_ENVIRONMENT;
      environment.IS_REACT_ACT_ENVIRONMENT = true;
      try { await act(async () => { view.rerender(app); }); }
      finally {
        if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
        else environment.IS_REACT_ACT_ENVIRONMENT = previous;
      }
    };
    const submitDraft = async (text: string) => {
      await flushInputEffects();
      await waitFor(() => view.stdin.listenerCount("readable") > 0);
      view.stdin.write(text);
      // Observe the accepted draft before Enter; a frame or a timer alone does
      // not prove that a newly mounted composer received the previous input.
      await waitFor(() => (view.lastFrame() ?? "").includes(`› ${text}`));
      view.stdin.write("\r");
    };
    try {
      await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
      await submitDraft("Original question");
      await waitFor(() => (view.lastFrame() ?? "").includes("Original answer") && (view.lastFrame() ?? "").includes("Ask Everpeace"));
      const sessionId = [...fixture.sessionStore.sessions.keys()][0];
      await submitDraft("/compact");
      const visibleText = () => (view.lastFrame() ?? "").replace(/[│\s]+/gu, " ");
      await waitFor(() => visibleText().includes(reason === "usage_limited" ? "model usage is incomplete" : "token budget is exhausted"))
        .catch((error: unknown) => { throw new Error(`Expected ${reason}; received compact calls ${compactions.join(", ")}\n${view.lastFrame() ?? ""}`, { cause: error }); });
      assert.match(visibleText(), /No further request was sent/u);
      assert.deepEqual(compactions, [reason]);
      // The info frame can precede its passive input subscription. Flush the
      // committed effects so remount cleanup cannot discard the pending Esc.
      await flushInputEffects();
      view.stdin.write("\u001b");
      await waitFor(() => !(view.lastFrame() ?? "").includes("/compact · Could not compact") && (view.lastFrame() ?? "").includes("Original answer") && (view.lastFrame() ?? "").includes("Ask Everpeace"))
        .catch((error: unknown) => { throw new Error(`Esc did not restore ${reason}\n${view.lastFrame() ?? ""}`, { cause: error }); });
      assert.deepEqual([...fixture.sessionStore.sessions.keys()], [sessionId]);
    } finally { view.unmount(); }
  });
});

test("history below the Codex row cap stays visible and remains persisted", async () => {
  const model: RegisteredModel = { id: "window", model_name: "test-model", base_url: "https://example.com", api_key: "test" };
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn() {
        for (let index = 0; index < 205; index++) io.writeAssistant(`window-reply-${index}.`);
        return {};
      },
    }),
  });
  let replays = 0;
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => { replays++; update(); }} />);
  try {
    await tick();
    view.stdin.write("fill history");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("window-reply-204."));
    await tick();
    assert.equal(replays, 0);
    assert.match(view.lastFrame() ?? "", /window-reply-0\./);
    const session = [...fixture.sessionStore.sessions.values()][0];
    assert.equal(session?.timeline.filter((entry) => entry.kind === "assistant").length, 205);
    view.stdin.write("/help");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Slash commands"));
    view.stdin.write("\u001b");
    await waitFor(() => (view.lastFrame() ?? "").includes("window-reply-204."));
    assert.match(view.lastFrame() ?? "", /window-reply-0\./);
  } finally {
    view.unmount();
  }
});

test("active turns show provider-aware English sampling and tool phases", async () => {
  const model: RegisteredModel = {
    id: "model-waiting",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  let continueToTools: (() => void) | undefined;
  let finishTurn: (() => void) | undefined;
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io, restore) => ({
      async runTurn() {
        restore?.onPhase?.("sampling");
        await new Promise<void>((resolve) => { continueToTools = resolve; });
        restore?.onPhase?.("tools");
        await new Promise<void>((resolve) => { finishTurn = resolve; });
        restore?.onPhase?.("completed");
        io.writeAssistant("done");
        return {};
      },
    }),
  });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("show progress");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => /Waiting for DeepSeek \(\d+s • ctrl\+c to interrupt\)/u.test(view.lastFrame() ?? ""));
  continueToTools?.();
  await waitFor(() => /Working \(\d+s • ctrl\+c to interrupt\)/u.test(view.lastFrame() ?? ""));
  finishTurn?.();
  await waitFor(() => (view.lastFrame() ?? "").includes("done"));
  view.unmount();
});

test("running turns keep a guidance composer and drain queued corrections", async () => {
  const model: RegisteredModel = {
    id: "model-guidance",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const calls: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn(input) {
        calls.push(input);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        io.writeAssistant(`done: ${input}`);
        return {};
      },
    }),
  });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("start task");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Add guidance while working"));
  view.stdin.write("use the safer approach");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("1 guidance message pending"));
  assert.match(view.lastFrame() ?? "", /use the safer approach/);
  releaseFirst?.();
  await waitFor(() => (view.lastFrame() ?? "").includes("done: use the safer approach"));
  assert.deepEqual(calls, ["start task", "use the safer approach"]);
  view.unmount();
});

test("running composer sends guidance to agents with live steering support", async () => {
  const model: RegisteredModel = {
    id: "model-live-steering",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  let release: (() => void) | undefined;
  const corrections: string[] = [];
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io, restore) => ({
      async runTurn() {
        await new Promise<void>((resolve) => { release = resolve; });
        restore?.onEvent?.({ type: "steering_applied", count: corrections.length });
        io.writeAssistant(`applied ${corrections.join("; ")}`);
        return {};
      },
      requestSteering(text) { corrections.push(text); return true; },
    }),
  });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );
  await tick();
  view.stdin.write("start task");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Add guidance while working"));
  view.stdin.write("avoid the unsafe command");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("1 guidance message pending"));
  assert.deepEqual(corrections, ["avoid the unsafe command"]);
  release?.();
  await waitFor(() => (view.lastFrame() ?? "").includes("applied avoid the unsafe command"));
  view.unmount();
});

test("/status renders provider, context, and zero usage without creating a session", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  let replayCalls = 0;
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => {
        replayCalls += 1;
        update();
      }}
    />,
  );

  await tick();
  view.stdin.write("/status");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Context window:"));

  const frame = lastBorderedSurface(view.lastFrame() ?? "");
  assert.match(frame, /\/status · Session status/);
  assert.match(frame, /Esc to return to session/);
  assert.doesNotMatch(frame, /Ask Everpeace to do anything/);
  assert.doesNotMatch(frame, /Everpeace Agent/);
  assert.match(frame, /Model:\s+deepseek-flash/);
  assert.match(frame, /Provider:\s+DeepSeek/);
  assert.match(frame, /Base URL:\s+https:\/\/api\.deepseek\.com/);
  assert.match(frame, /Session:\s+not started/);
  assert.match(frame, /Context window:\s+100% left \(0 used \/ 1M\)/);
  assert.match(frame, /Input tokens:\s+0/);
  assert.match(frame, /Output tokens:\s+0/);
  assert.doesNotMatch(frame, /secret/);
  const topBorder = frame.split("\n")[0] ?? "";
  assert.equal(textWidth(topBorder.trimStart()), 80);
  assert.equal(textWidth(topBorder) - textWidth(topBorder.trimStart()), 10);
  assert.equal(replayCalls, 1);
  assert.equal(fixture.sessionStore.sessions.size, 0);

  await tick();
  view.stdin.write("\u001B");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));
  assert.doesNotMatch(view.lastFrame() ?? "", /\/status · Session status/);
  assert.equal(replayCalls, 2);
  view.unmount();
});

test("/status keeps cumulative usage persistent while its command screen stays transient", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io, restore) => ({
      async runTurn(input) {
        await restore?.onContextAppend?.([{ role: "user", content: input }]);
        await restore?.onUsage?.({
          input_tokens: 1_200,
          output_tokens: 300,
          total_tokens: 1_500,
        });
        io.writeAssistant("done");
        return {};
      },
    }),
  });
  const firstView = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  firstView.stdin.write("use tokens");
  await tick();
  firstView.stdin.write("\r");
  await waitFor(() => (firstView.lastFrame() ?? "").includes("done"));
  firstView.stdin.write("/status");
  await tick();
  firstView.stdin.write("\r");
  await waitFor(() => (firstView.lastFrame() ?? "").includes("Input tokens:"));

  const statusFrame = firstView.lastFrame() ?? "";
  assert.match(statusFrame, /Context window:\s+100% left \(1\.5K used \/ 1M\)/);
  assert.match(statusFrame, /Input tokens:\s+1,200/);
  assert.match(statusFrame, /Output tokens:\s+300/);
  const session = [...fixture.sessionStore.sessions.values()][0];
  assert.ok(session);
  assert.deepEqual(session.usage, {
    input_tokens: 1_200,
    output_tokens: 300,
    context_tokens: 1_500,
    complete: true,
    cache_usage_complete: false,
    cache_write_usage_complete: false,
  });
  assert.deepEqual(session.timeline.map((entry) => entry.kind), ["user", "assistant"]);
  firstView.unmount();

  const resumedView = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );
  await tick();
  resumedView.stdin.write("/resume");
  await tick();
  resumedView.stdin.write("\r");
  await waitFor(() => (resumedView.lastFrame() ?? "").includes(session.summary.title));
  await tick();
  resumedView.stdin.write("\r");
  await waitFor(() => (resumedView.lastFrame() ?? "").includes("done"));
  assert.doesNotMatch(resumedView.lastFrame() ?? "", /Input tokens:/);

  resumedView.stdin.write("/status");
  await tick();
  resumedView.stdin.write("\r");
  await waitFor(() => (resumedView.lastFrame() ?? "").includes("Input tokens:"));
  assert.match(resumedView.lastFrame() ?? "", /Input tokens:\s+1,200/);
  resumedView.unmount();
});

test("/reasoning applies on the next turn and persists with the session model", async () => {
  const model: RegisteredModel = {
    id: "reasoning-model",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  let selected: string | undefined;
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      setRequestSettings(settings) { selected = settings.reasoningEffort; },
      async runTurn(input) { io.writeAssistant(`done: ${input}`); return {}; },
    }),
  });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  await tick();
  view.stdin.write("/reasoning low");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Reasoning is low"));
  assert.equal(selected, "low");
  view.stdin.write("\u001B");
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));
  view.stdin.write("implement this");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("done: implement this"));
  const session = [...fixture.sessionStore.sessions.values()][0];
  assert.equal(session?.summary.model.request_settings?.reasoningEffort, "low");
  view.unmount();
});

test("/doctor is local by default and sends a model check only with --live", async () => {
  const model: RegisteredModel = { id: "doctor-model", model_name: "deepseek-flash", base_url: "https://api.deepseek.com", api_key: "secret" };
  const fixture = createFixture({ initial: [model] });
  const calls: boolean[] = [];
  fixture.dependencies.doctor = async (_model, _policy, live) => {
    calls.push(live);
    return live ? "Model request: completed" : "Model request: not run";
  };
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  await tick();
  view.stdin.write("/doctor");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Model request: not run"));
  view.unmount();
  const liveView = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  await tick();
  liveView.stdin.write("/doctor --live");
  await tick();
  liveView.stdin.write("\r");
  await waitFor(() => (liveView.lastFrame() ?? "").includes("Model request: completed"));
  assert.deepEqual(calls, [false, true]);
  liveView.unmount();
});

test("/resume still renders status snapshots saved by earlier versions", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const summary = await fixture.sessionStore.create({
    title: "legacy status",
    titlePending: false,
    workspacePath: "C:\\workspace",
    model: toSessionModelForTest(model),
  });
  await fixture.sessionStore.appendTimeline(summary.id, {
    kind: "status",
    snapshot: {
      version: "0.1.20",
      model_name: model.model_name,
      provider: "DeepSeek",
      base_url: model.base_url,
      workspace_path: "C:\\workspace",
      session_id: summary.id,
      context_window: 1_000_000,
      context_tokens: 30,
      input_tokens: 20,
      output_tokens: 10,
      usage_complete: true,
    },
  });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/resume");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes(summary.title));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Input tokens:"));
  assert.match(view.lastFrame() ?? "", /Input tokens:\s+20/);
  view.unmount();
});

test("slash command surfaces close back to chat while direct commands remain persistent", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  let replayCalls = 0;
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => {
        replayCalls += 1;
        update();
      }}
    />,
  );

  await tick();
  view.stdin.write("persist this chat");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: persist this chat"));
  const session = [...fixture.sessionStore.sessions.values()][0];
  assert.ok(session);
  const persistedKinds = ["user", "assistant"];
  assert.deepEqual(session.timeline.map((entry) => entry.kind), persistedKinds);

  for (const [command, output] of [
    ["/help", "Slash commands"],
    ["/models", "[ready]"],
    ["/status", "Input tokens:"],
    ["/wat", "Unknown command: /wat"],
  ] as const) {
    view.stdin.write(command);
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes(output));
    const commandFrame = lastBorderedSurface(view.lastFrame() ?? "");
    assert.match(commandFrame, /Esc to return to session/);
    assert.doesNotMatch(commandFrame, /persist this chat/);
    assert.doesNotMatch(commandFrame, /echo: persist this chat/);
    assert.doesNotMatch(commandFrame, /Ask Everpeace to do anything/);
    assert.doesNotMatch(commandFrame, /Everpeace Agent/);
    assert.deepEqual(session.timeline.map((entry) => entry.kind), persistedKinds);
    await tick();
    view.stdin.write("\u001B");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));
    assert.equal((view.lastFrame() ?? "").includes(output), false);
    assert.match(view.lastFrame() ?? "", /persist this chat/);
    assert.match(view.lastFrame() ?? "", /echo: persist this chat/);
  }
  assert.equal(replayCalls, 8);

  view.stdin.write("!echo kept");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("You ran"));
  assert.deepEqual(session.timeline.map((entry) => entry.kind), [
    "user",
    "assistant",
    "output",
  ]);
  view.unmount();
});

test("/mcp refreshes status and /skills opens the transient Skill manager", async () => {
  const model: RegisteredModel = { id: "capabilities", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  const fixture = createFixture({ initial: [model] });
  let mcpLoads = 0;
  fixture.dependencies.getMcpStatus = async () => { mcpLoads++; return "calendar · stdio · ready · 2 tools"; };
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);

  await tick();
  view.stdin.write("/mcp");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("calendar · stdio · ready"));
  assert.equal(mcpLoads, 1);
  await tick();
  view.stdin.write("\u001B");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));

  view.stdin.write("/skills");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Create a skill"));
  assert.match(view.lastFrame() ?? "", /Install from URL/u);
  assert.match(view.lastFrame() ?? "", /View installed skills/u);
  view.unmount();
});

test("/memory opens a transient learned experience surface and supports pause", async () => {
  const model: RegisteredModel = { id: "memory-model", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  const fixture = createFixture({ initial: [model] });
  fixture.dependencies.getMemoryStatus = async () => ({
    enabled: true,
    projectEntries: 2,
    userEntries: 1,
    recent: [{ id: "lesson-1", scope: "project", kind: "procedure", lesson: "Validate inputs first", applyWhen: "When adding commands", confidence: "high", status: "active", createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" }],
  });
  let enabled: boolean | undefined;
  fixture.dependencies.setMemoryEnabled = async (value) => { enabled = value; };
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  await tick();
  view.stdin.write("/memory");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Learned experience"));
  assert.match(view.lastFrame() ?? "", /Validate inputs first/u);
  assert.equal(enabled, undefined);
  view.unmount();
});

test("Esc cancels manual Memory and neither late success nor failure reopens the window", async (t) => {
  for (const result of ["success", "failure"] as const) await t.test(result, async () => {
    const model: RegisteredModel = { id: "memory-cancel", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" };
    const fixture = createFixture({ initial: [model], createAgent: (_model, io, restore) => ({
      async runTurn(input) { await restore?.onContextAppend?.([{ role: "user", content: input }]); io.writeAssistant("Original Memory session"); return {}; },
    }) });
    let complete!: () => void, fail!: (error: Error) => void;
    const request = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    let requestSignal: AbortSignal | undefined;
    let requests = 0, statusReads = 0;
    fixture.dependencies.rememberMemory = async (_model, _workspace, _text, signal) => { requests++; requestSignal = signal; return request; };
    fixture.dependencies.getMemoryStatus = async () => { statusReads++; return { enabled: true, projectEntries: 0, userEntries: 1, recent: [] }; };
    const app = <EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />;
    const view = render(app);
    const flushInputEffects = async () => {
      const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previous = environment.IS_REACT_ACT_ENVIRONMENT;
      environment.IS_REACT_ACT_ENVIRONMENT = true;
      try { await act(async () => { view.rerender(app); }); }
      finally { if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT; else environment.IS_REACT_ACT_ENVIRONMENT = previous; }
    };
    const submit = async (text: string) => {
      await flushInputEffects();
      view.stdin.write(text);
      await waitFor(() => (view.lastFrame() ?? "").includes(`› ${text}`));
      view.stdin.write("\r");
    };
    try {
      await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
      await submit("Original question");
      await waitFor(() => (view.lastFrame() ?? "").includes("Original Memory session") && (view.lastFrame() ?? "").includes("Ask Everpeace"));
      const sessionId = [...fixture.sessionStore.sessions.keys()][0];
      await submit("/memory remember Use pnpm");
      await waitFor(() => requests === 1 && (view.lastFrame() ?? "").includes("Extracting user preference"));
      await flushInputEffects();
      view.stdin.write("\u001b");
      await waitFor(() => (view.lastFrame() ?? "").includes("Original Memory session") && (view.lastFrame() ?? "").includes("Ask Everpeace"));
      if (result === "success") complete(); else fail(new Error("Late extraction failed"));
      await tick();
      await flushInputEffects();
      assert.equal(statusReads, 0);
      assert.equal(requestSignal?.aborted, true);
      assert.equal(requests, 1);
      assert.match(view.lastFrame() ?? "", /Original Memory session/u);
      assert.doesNotMatch(view.lastFrame() ?? "", /Learned experience|Could not remember/u);
      assert.deepEqual([...fixture.sessionStore.sessions.keys()], [sessionId]);
    } finally { complete(); await request.catch(() => undefined); view.unmount(); }
  });
});

test("Esc cancels an in-flight slash command load without reopening its window", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  let resolveStatuses: ((models: RegisteredModelStatus[]) => void) | undefined;
  fixture.dependencies.registry.listStatuses = async () =>
    new Promise((resolve) => {
      resolveStatuses = resolve;
    });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/models");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Reading model registry"));
  const loadingFrame = lastBorderedSurface(view.lastFrame() ?? "");
  assert.doesNotMatch(loadingFrame, /Everpeace Agent/);
  assert.match(loadingFrame, /Esc to return to session/);

  await tick();
  view.stdin.write("\u001B");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));
  resolveStatuses?.([status(model)]);
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const restoredFrame = view.lastFrame() ?? "";
  assert.match(restoredFrame, /Everpeace Agent/);
  assert.match(restoredFrame, /Ask Everpeace to do anything/);
  assert.doesNotMatch(restoredFrame, /\[ready\]/);
  view.unmount();
});

test("prompt remains one non-wrapping input row when its input exceeds terminal width", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("x".repeat(180));
  await tick();

  const frameLines = (view.lastFrame() ?? "").split("\n");
  const promptLines = frameLines.filter((line) => line.trimStart().startsWith("›"));
  assert.equal(promptLines.length, 1);
  assert.ok((promptLines[0]?.length ?? 0) <= 99);
  assert.equal(frameLines.filter((line) => line.startsWith("╭")).length, 1);
  view.unmount();
});

test("repeated terminal resizes preserve history and keep one non-wrapping prompt box", async () => {
  assert.equal(RESIZE_REDRAW_DEBOUNCE_MS, 75);
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  let resizeRedraws = 0;
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => {
        resizeRedraws += 1;
        update();
      }}
    />,
  );

  await tick();
  view.stdin.write("history-before-resize");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: history-before-resize"));

  for (const columns of [72, 45, 120, 58]) {
    const frameCountBeforeResize = view.frames.length;
    Object.defineProperty(view.stdout, "columns", {
      configurable: true,
      value: columns,
    });
    view.stdout.emit("resize");
    await tick();

    const frame = view.lastFrame() ?? "";
    const resizeWrites = view.frames.slice(frameCountBeforeResize).join("");
    assert.match(frame, /Everpeace Agent/);
    assert.match(frame, /history-before-resize/);
    assert.match(frame, /echo: history-before-resize/);
    assert.doesNotMatch(resizeWrites, /\u001B\[3J/);

    const lines = frame.split("\n");
    const promptIndexes = lines
      .map((line, index) =>
        line.includes("Ask Everpeace to do anything") ? index : -1,
      )
      .filter((index) => index >= 0);
    assert.equal(promptIndexes.length, 1);
    const promptIndex = promptIndexes[0]!;
    assert.ok((lines[promptIndex]?.length ?? 0) <= columns - 1);
  }

  await new Promise((resolve) =>
    setTimeout(resolve, RESIZE_REDRAW_DEBOUNCE_MS + 30),
  );
  await waitFor(() => resizeRedraws === 1);
  const recoveredFrame = view.lastFrame() ?? "";
  assert.match(recoveredFrame, /Everpeace Agent/);
  assert.match(recoveredFrame, /history-before-resize/);
  assert.match(recoveredFrame, /echo: history-before-resize/);
  assert.equal(
    recoveredFrame.match(/Ask Everpeace to do anything/g)?.length,
    1,
  );

  view.stdin.write("/status");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("/status · Session status"));
  const replaysBeforeCommandResize = resizeRedraws;
  Object.defineProperty(view.stdout, "columns", {
    configurable: true,
    value: 64,
  });
  view.stdout.emit("resize");
  await new Promise((resolve) =>
    setTimeout(resolve, RESIZE_REDRAW_DEBOUNCE_MS + 30),
  );
  const commandFrame = lastBorderedSurface(view.lastFrame() ?? "");
  assert.equal(resizeRedraws, replaysBeforeCommandResize,
    "command resize must not clear an unchanged dynamic frame via transcript replay");
  assert.match(commandFrame, /\/status · Session status/);
  assert.doesNotMatch(commandFrame, /history-before-resize/);
  assert.doesNotMatch(commandFrame, /Everpeace Agent/);
  const narrowTopBorder = commandFrame.split("\n")[0] ?? "";
  assert.equal(textWidth(narrowTopBorder.trimStart()), 62);
  assert.equal(
    textWidth(narrowTopBorder) - textWidth(narrowTopBorder.trimStart()),
    1,
  );

  await tick();
  view.stdin.write("\u001B");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitFor(() => (view.lastFrame() ?? "").includes("history-before-resize"));
  assert.match(view.lastFrame() ?? "", /echo: history-before-resize/);

  view.unmount();
});

test("composer supports End, Shift+Enter, and Ctrl+U like Codex", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("abc");
  view.stdin.write("\u001B[D\u001B[D");
  view.stdin.write("\u001B[F");
  view.stdin.write("Z");
  view.stdin.write("\u0015");
  view.stdin.write("first");
  // Kitty/CSI-u Shift+Enter. Ink uses this same decoded key shape in a
  // supported interactive terminal after enhanced keyboard negotiation.
  view.stdin.write("\u001B[13;2u");
  view.stdin.write("second");
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: first"));

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /›\s+first\n\s+second/);
  assert.match(frame, /•\s+echo: first\n\s+second/);
  assert.doesNotMatch(frame, /abcZ/);
  view.unmount();
});

test("slash command menu filters commands and scrolls an eight-item window", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/");
  await tick();
  assert.deepEqual(
    visibleSlashCommandLines(view.lastFrame() ?? ""),
    SLASH_COMMANDS.slice(0, 8),
  );
  const initialLines = (view.lastFrame() ?? "").split("\n");
  const promptLine = initialLines.findIndex((line) => /›\s+\//u.test(line));
  const firstOptionLine = initialLines.findIndex((line) => /›\s+\/login/u.test(line));
  assert.ok(promptLine >= 0);
  assert.ok(firstOptionLine > promptLine);

  for (let index = 0; index < 8; index += 1) {
    view.stdin.write("\u001B[B");
    await tick();
  }
  assert.deepEqual(
    visibleSlashCommandLines(view.lastFrame() ?? ""),
    SLASH_COMMANDS.slice(1, 9),
  );
  view.stdin.write("\u001B[B");
  await tick();
  assert.deepEqual(
    visibleSlashCommandLines(view.lastFrame() ?? ""),
    SLASH_COMMANDS.slice(2, 10),
  );

  view.stdin.write("MO");
  await tick();
  assert.deepEqual(visibleSlashCommandLines(view.lastFrame() ?? ""), [
    "/model",
    "/models",
  ]);
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("[ready]"));
  view.unmount();
});

test("Tab completes a slash command without executing it", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/mo");
  await tick();
  assert.deepEqual(visibleSlashCommandLines(view.lastFrame() ?? ""), [
    "/model",
    "/models",
  ]);

  view.stdin.write("\t");
  await tick();
  const completedFrame = view.lastFrame() ?? "";
  assert.equal(
    completedFrame
      .split("\n")
      .map((line) => line.trim().replace(/^›\s+/u, ""))
      .filter((line) => line === "/model").length,
    1,
  );
  assert.doesNotMatch(completedFrame, /Switch the active model/);

  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Switch the active model"));
  assert.match(view.lastFrame() ?? "", /Esc to return to session/);
  assert.doesNotMatch(lastBorderedSurface(view.lastFrame() ?? ""), /Everpeace Agent/);
  view.unmount();
});

test("asynchronous file submission starts once and leaves a fresh guidance draft through replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "everpeace-prompt-submission-"));
  assert.ok(root.startsWith(join(tmpdir(), "everpeace-prompt-submission-")));
  await writeFile(join(root, "note.txt"), "attachment 中文 🙂\n");
  let release: (() => void) | undefined;
  const calls: string[] = [];
  const fixture = createFixture({ initial: [planModel], createAgent: (_model, io) => ({
    async runTurn(text, _signal, options) {
      calls.push(text);
      assert.equal(options?.attachments?.[0]?.content, "attachment 中文 🙂\n");
      await new Promise<void>((resolve) => { release = resolve; });
      io.writeAssistant("attachment task finished");
      return {};
    },
  }) });
  fixture.dependencies.workspacePath = root;
  const view = render(<EverpeaceApp dependencies={fixture.dependencies}
    initialModels={{ available: [planModel], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await submitInput(view, 'Review @"note.txt"');
    view.stdin.write("\r");
    await waitFor(() => calls.length === 1 && (view.lastFrame() ?? "").includes("Add guidance while working"));
    view.stdin.write("fresh guidance");
    await waitFor(() => (view.lastFrame() ?? "").includes("fresh guidance"));
    assert.match(view.lastFrame() ?? "", /›\s+fresh guidance/u);
    assert.match((view.lastFrame() ?? "").split("\n").filter((line) => line.trimStart().startsWith("›")).at(-1) ?? "", /›\s+fresh guidance/u);
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 60 });
    view.stdout.emit("resize");
    await new Promise<void>((resolve) => setTimeout(resolve, RESIZE_REDRAW_DEBOUNCE_MS + 30));
    assert.match(view.lastFrame() ?? "", /›\s+fresh guidance/u);
    release?.();
    await waitFor(() => (view.lastFrame() ?? "").includes("attachment task finished") && !(view.lastFrame() ?? "").includes("ctrl+c to interrupt"));
    assert.match(view.lastFrame() ?? "", /›\s+fresh guidance/u);
    view.stdin.write("\u0003");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));
    await submitInput(view, "/status");
    await waitFor(() => (view.lastFrame() ?? "").includes("/status · Session status"));
    view.stdin.write("\u001b");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));
    assert.match(view.lastFrame() ?? "", /attachment task finished/u);
    assert.equal((view.lastFrame() ?? "").match(/Ask Everpeace to do anything/gu)?.length, 1);
    assert.deepEqual(calls, ['Review @"note.txt"']);
  } finally {
    release?.();
    view.unmount();
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed explicit file references keep the App composer draft", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write('Review @"unterminated');
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Malformed file reference"));
  assert.match(view.lastFrame() ?? "", /Review @"unterminated/u);
  view.unmount();
});

test("Escape dismisses slash suggestions until editing resumes and Enter executes selection", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/res");
  await tick();
  assert.deepEqual(visibleSlashCommandLines(view.lastFrame() ?? ""), ["/resume"]);

  view.stdin.write("\u001B");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(visibleSlashCommandLines(view.lastFrame() ?? ""), []);
  assert.match(view.lastFrame() ?? "", /›\s+\/res/);

  view.stdin.write("u");
  await tick();
  assert.deepEqual(visibleSlashCommandLines(view.lastFrame() ?? ""), ["/resume"]);
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("No sessions are available to resume"));
  assert.match(view.lastFrame() ?? "", /Esc to return to session/);
  assert.doesNotMatch(lastBorderedSurface(view.lastFrame() ?? ""), /Everpeace Agent/);
  await tick();
  view.stdin.write("\u001B");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));
  view.unmount();
});

test("/login masks the API Key, registers one model, and activates it", async () => {
  const fixture = createFixture();
  const seenKeys: string[] = [];
  fixture.dependencies.listModels = async (baseUrl, apiKey) => {
    assert.equal(baseUrl, "https://api.deepseek.com");
    seenKeys.push(apiKey);
    return ["deepseek-flash"];
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/login");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Model sign-in"));
  assert.match(view.lastFrame() ?? "", /Esc to return to session/);
  assert.doesNotMatch(lastBorderedSurface(view.lastFrame() ?? ""), /Everpeace Agent/);
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("API Key"));
  await tick();
  view.stdin.write("sk-tui-secret");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("deepseek-flash"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Signed in and enabled"));

  assert.deepEqual(seenKeys, ["sk-tui-secret"]);
  assert.doesNotMatch(view.frames.join("\n"), /sk-tui-secret/);
  assert.doesNotMatch(view.frames.join("\n"), /https:\/\/api\.deepseek\.com/);
  assert.match(view.lastFrame() ?? "", /deepseek-flash/);
  view.unmount();
});

test("model-requested Bash waits for confirmation", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  let ranBash = false;
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn() {
        if (await io.confirmBash("pwd")) {
          await io.runBash("pwd");
          io.writeAssistant("done");
        }
        return {};
      },
    }),
  });
  fixture.dependencies.runBash = async () => {
    ranBash = true;
    return { stdout: "repo\n", stderr: "", exitCode: 0, signal: null };
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/permissions");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Codex native OS enforcement"));
  view.stdin.write("\u001B[A");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
  view.stdin.write("run pwd");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Run this command?"));
  assert.equal(ranBash, false);
  view.stdin.write("y");
  await waitFor(() => (view.lastFrame() ?? "").includes("done"));

  assert.equal(ranBash, true);
  assert.match(view.lastFrame() ?? "", /• Ran (?:PowerShell|Bash)/);
  view.unmount();
});

test("model-requested MCP calls use their own approval surface", async () => {
  const model: RegisteredModel = { id: "mcp-model", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  let called = false;
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn() {
        if (await io.confirmMcp?.('calendar/list {"day":"today"}')) {
          called = true;
          io.writeAssistant("mcp done");
        }
        return {};
      },
    }),
  });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);

  await tick();
  view.stdin.write("use calendar");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Allow this MCP tool call?"));
  assert.equal(called, false);
  view.stdin.write("y");
  await waitFor(() => (view.lastFrame() ?? "").includes("mcp done"));
  assert.equal(called, true);
  assert.match(view.lastFrame() ?? "", /Ask Everpeace to do anything/);
  view.unmount();
});

test("model Bash streams head and tail output and adapts to terminal height", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  let finishBash: ((result: BashResult) => void) | undefined;
  const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn() {
        if (await io.confirmBash("long-output")) {
          await io.runBash("long-output");
          io.writeAssistant("done");
        }
        return {};
      },
    }),
  });
  fixture.dependencies.runBash = async (_command, _policy, _signal, onOutput) => {
    onOutput?.({
      headLines: ["line 1", "line 2", "line 3", "line 4", "line 5"],
      tailLines: ["line 16", "line 17", "line 18", "line 19", "line 20"],
      omittedLines: 10,
    });
    return new Promise((resolve) => {
      finishBash = resolve;
    });
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/permissions");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Codex native OS enforcement"));
  view.stdin.write("\u001B[A");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
  view.stdin.write("run a long command");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Run this command?"));
  view.stdin.write("y");
  await waitFor(() => (view.lastFrame() ?? "").includes("… +10 lines"));

  const fullHeightFrame = view.lastFrame() ?? "";
  for (const line of ["line 1", "line 5", "line 16", "line 20"]) {
    assert.match(fullHeightFrame, new RegExp(`\\b${line}\\b`, "u"));
  }
  assert.doesNotMatch(fullHeightFrame, /\bline 6\b/u);

  Object.defineProperty(view.stdout, "rows", {
    configurable: true,
    value: 8,
  });
  view.stdout.emit("resize");
  await waitFor(() => (view.lastFrame() ?? "").includes("… +16 lines"));

  const shortHeightFrame = view.lastFrame() ?? "";
  for (const line of ["line 1", "line 2", "line 19", "line 20"]) {
    assert.match(shortHeightFrame, new RegExp(`\\b${line}\\b`, "u"));
  }
  assert.doesNotMatch(shortHeightFrame, /\bline 3\b/u);
  assert.doesNotMatch(shortHeightFrame, /\bline 18\b/u);

  finishBash?.({
    stdout: output,
    stderr: "",
    exitCode: 0,
    signal: null,
  });
  await waitFor(() => (view.lastFrame() ?? "").includes("done"));

  const completedFrame = view.lastFrame() ?? "";
  assert.match(completedFrame, /\bline 1\b/u);
  assert.match(completedFrame, /\bline 2\b/u);
  assert.match(completedFrame, /\bline 17\b/u);
  assert.match(completedFrame, /\bline 20\b/u);
  assert.match(completedFrame, /lines omitted \(\/outputs\)/u);
  view.unmount();
});

test("direct commands use the native terminal runner", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  let directCommand: string | undefined;
  let finishCommand: ((result: BashResult) => void) | undefined;
  fixture.dependencies.runTerminalCommand = (command, onOutput) => {
    directCommand = command;
    onOutput?.("NAME    SIZE");
    return new Promise((resolve) => {
      finishCommand = resolve;
    });
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("!ls");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("NAME    SIZE"));

  const streamingFrame = view.lastFrame() ?? "";
  assert.match(streamingFrame, /Everpeace Agent/);
  assert.match(streamingFrame, /NAME    SIZE/);
  assert.match(streamingFrame, /Command is still running/);

  finishCommand?.({
    stdout: "NAME    SIZE\nfile-a  10",
    stderr: "",
    exitCode: 0,
    signal: null,
  });
  await waitFor(() => (view.lastFrame() ?? "").includes("You ran"));

  assert.equal(directCommand, "ls");
  assert.match(view.lastFrame() ?? "", /NAME    SIZE\n\s+file-a  10/);
  view.unmount();
});

test("startup model picker activates the selected registered model", async () => {
  const models: RegisteredModel[] = [
    {
      id: "model-a",
      model_name: "deepseek-flash",
      base_url: "https://api.deepseek.com",
      api_key: "secret-a",
    },
    {
      id: "model-b",
      model_name: "deepseek-v4-pro",
      base_url: "https://api.deepseek.com",
      api_key: "secret-b",
    },
  ];
  const fixture = createFixture({ initial: models });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: models, missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  assert.match(view.lastFrame() ?? "", /Choose a model for this session/);
  view.stdin.write("\u001B[B");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("conversation context was reset"));

  assert.match(view.lastFrame() ?? "", /conversation context was reset/);
  assert.match(view.lastFrame() ?? "", /deepseek-v4-pro/);
  view.unmount();
});

test("/logout removes the active model and returns to logged-out chat", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/logout");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Remove models"));
  assert.match(view.lastFrame() ?? "", /Esc to return to session/);
  assert.doesNotMatch(lastBorderedSurface(view.lastFrame() ?? ""), /Everpeace Agent/);
  await tick();
  view.stdin.write(" ");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Remove 1 model"));
  await tick();
  view.stdin.write("y");
  await waitFor(() => (view.lastFrame() ?? "").includes("Removed 1 model"));

  assert.match(view.lastFrame() ?? "", /No model selected/);
  view.unmount();
});

test("/clear resets the agent session and clears rendered output", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  let createdAgents = 0;
  let clearCalls = 0;
  const fixture = createFixture({
    initial: [model],
    createAgent: () => {
      createdAgents += 1;
      return { async runTurn() { return {}; } };
    },
  });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => {
        clearCalls += 1;
        update();
      }}
    />,
  );

  await tick();
  assert.equal(createdAgents, 1);
  view.stdin.write("/clear");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => createdAgents === 2);

  assert.equal(clearCalls, 1);
  view.unmount();
});

test("the first chat creates one session and generates its title without blocking", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  let resolveTitle: ((title: string) => void) | undefined;
  fixture.dependencies.generateSessionTitle = async () =>
    new Promise((resolve) => {
      resolveTitle = resolve;
    });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/help");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Slash commands"));
  assert.equal(fixture.sessionStore.sessions.size, 0);
  assert.match(view.lastFrame() ?? "", /Esc to return to session/);
  await tick();
  view.stdin.write("\u001B");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));

  view.stdin.write("first persisted question");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: first persisted question"));
  assert.equal(fixture.sessionStore.sessions.size, 1);
  const session = [...fixture.sessionStore.sessions.values()][0];
  assert.ok(session);
  assert.equal(session.summary.title, "first persisted question");
  assert.deepEqual(session.timeline.map((entry) => entry.kind), ["user", "assistant"]);
  assert.equal(session.context.length, 2);

  resolveTitle?.("Generated session title");
  await waitFor(() => session.summary.title === "Generated session title");
  view.unmount();
});

test("/new immediately creates and enters a session that is named by its first question", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  let resolveTitle: ((title: string) => void) | undefined;
  fixture.dependencies.generateSessionTitle = async () =>
    new Promise((resolve) => {
      resolveTitle = resolve;
    });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/new");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("New session created"));

  assert.equal(fixture.sessionStore.sessions.size, 1);
  const session = [...fixture.sessionStore.sessions.values()][0];
  assert.ok(session);
  assert.equal(session.summary.title, "New Session");
  assert.equal(session.summary.title_pending, true);
  assert.deepEqual(session.timeline, []);

  view.stdin.write("name this conversation");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: name this conversation"));
  assert.equal(fixture.sessionStore.sessions.size, 1);
  assert.equal(session.summary.title, "name this conversation");
  assert.equal(session.summary.title_pending, false);
  assert.equal(session.context.length, 2);

  resolveTitle?.("Generated new title");
  await waitFor(() => session.summary.title === "Generated new title");
  view.unmount();
});

test("/new requires an active model and does not create an unusable session", async () => {
  const fixture = createFixture();
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/new");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("No model is active"));

  assert.equal(fixture.sessionStore.sessions.size, 0);
  view.unmount();
});

test("/new leaves the previous session intact and writes subsequent chat only to the new one", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("old conversation");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: old conversation"));
  const oldSession = [...fixture.sessionStore.sessions.values()][0];
  assert.ok(oldSession);

  view.stdin.write("/new");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("New session created"));
  view.stdin.write("new conversation");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: new conversation"));

  assert.equal(fixture.sessionStore.sessions.size, 2);
  assert.doesNotMatch(
    timelineText(oldSession.timeline),
    /new conversation/,
  );
  const newSession = [...fixture.sessionStore.sessions.values()].at(-1);
  assert.ok(newSession);
  assert.match(
    timelineText(newSession.timeline),
    /new conversation/,
  );
  view.unmount();
});

test("/fork creates and enters an independent child with the requested title", async () => {
  const model: RegisteredModel = {
    id: "fork-model",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );
  try {
    await tick();
    view.stdin.write("parent message");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("echo: parent message"));
    const parent = [...fixture.sessionStore.sessions.values()][0];
    assert.ok(parent);

    view.stdin.write("/fork Review branch");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Forked session created: Review branch"));
    assert.equal(fixture.sessionStore.sessions.size, 2);
    const child = [...fixture.sessionStore.sessions.values()].find((session) => session.lineage?.parent_session_id === parent.summary.id);
    assert.ok(child);
    assert.equal(child.summary.title, "Review branch");
    assert.equal(child.forkPendingResume, true);
    assert.deepEqual(child.context, parent.context);

    view.stdin.write("child-only message");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("echo: child-only message"));
    assert.doesNotMatch(timelineText(parent.timeline), /child-only message/u);
    assert.match(timelineText(child.timeline), /child-only message/u);
    assert.equal(child.forkPendingResume, false);
  } finally {
    view.unmount();
  }
});

test("/fork refuses while a model task is active", async () => {
  const model: RegisteredModel = { id: "fork-busy", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  let release: (() => void) | undefined;
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn(input) {
        if (input === "hold task") await new Promise<void>((resolve) => { release = resolve; });
        io.writeAssistant(`done: ${input}`);
        return {};
      },
    }),
  });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    view.stdin.write("seed session");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("done: seed session"));
    view.stdin.write("hold task");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => release !== undefined);
    view.stdin.write("/fork Must not exist");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Wait for the active task"));
    assert.equal(fixture.sessionStore.sessions.size, 1);
  } finally {
    release?.();
    view.unmount();
  }
});

test("cancelling /fork keeps the parent session active", async () => {
  const model: RegisteredModel = { id: "fork-cancel", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  const fixture = createFixture({ initial: [model] });
  const originalFork = fixture.sessionStore.fork!.bind(fixture.sessionStore);
  fixture.sessionStore.fork = async (sessionId, input = {}) => {
    await new Promise<void>((_resolve, reject) => {
      const cancel = () => reject(input.signal?.reason ?? new Error("cancelled"));
      if (input.signal?.aborted) cancel();
      else input.signal?.addEventListener("abort", cancel, { once: true });
    });
    return originalFork(sessionId, input);
  };
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    view.stdin.write("parent remains");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("echo: parent remains"));
    view.stdin.write("/fork Cancelled branch");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Preparing an independent session copy"));
    view.stdin.write("\u0003");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
    assert.match(view.lastFrame() ?? "", /parent remains/u);
    assert.equal(fixture.sessionStore.sessions.size, 1);
  } finally {
    view.unmount();
  }
});

test("a restarted fork keeps resume semantics through planning and cancellation until coding settles", async () => {
  const model: RegisteredModel = { id: "fork-resume", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  const taskStarts: Array<{ mode: string; source: string }> = [];
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      beginTask(options) {
        taskStarts.push({ mode: options.mode, source: options.source });
      },
      async runTurn(input, signal, options) {
        if (options?.mode === "plan") {
          io.writeAssistant(`planned: ${input}`);
          return {};
        }
        if (input === "cancel this continuation") {
          await new Promise<void>((_resolve, reject) => {
            const cancel = () => reject(signal?.reason ?? new Error("cancelled"));
            if (signal?.aborted) cancel();
            else signal?.addEventListener("abort", cancel, { once: true });
          });
        }
        io.writeAssistant(`continued: ${input}`);
        return {};
      },
    }),
  });
  const parent = await fixture.sessionStore.create({
    title: "Parent before restart",
    titlePending: false,
    workspacePath: "C:\\workspace",
    model: toSessionModelForTest(model),
  });
  await fixture.sessionStore.setTaskProgress?.(parent.id, {
    plan: [{ step: "Inherited work", status: "in_progress" }],
    updated_at: "2026-10-01T00:00:00.000Z",
  });
  const child = await fixture.sessionStore.fork?.(parent.id, { title: "Restarted child" });
  assert.ok(child);

  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  try {
    await tick();
    view.stdin.write("/resume");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Scope: This workspace"));
    view.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 250));
    await waitFor(() => (view.lastFrame() ?? "").includes("Restarted child"));
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));

    view.stdin.write("/plan inspect only");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("planned: inspect only"));
    assert.equal((await fixture.sessionStore.load(child.id)).forkPendingResume, true);
    view.stdin.write("/plan exit");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Plan mode disabled"));

    view.stdin.write("cancel this continuation");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => taskStarts.some((item) => item.mode === "default"));
    view.stdin.write("\u0003");
    await waitFor(() => (view.lastFrame() ?? "").includes("Model request cancelled"));
    assert.equal((await fixture.sessionStore.load(child.id)).forkPendingResume, true);

    view.stdin.write("settle continuation");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("continued: settle continuation"));
    await waitFor(() => fixture.sessionStore.sessions.get(child.id)?.forkPendingResume === false);
    view.stdin.write("ordinary next task");
    await tick();
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("continued: ordinary next task"));

    assert.deepEqual(taskStarts, [
      { mode: "plan", source: "user" },
      { mode: "default", source: "session_resume" },
      { mode: "default", source: "session_resume" },
      { mode: "default", source: "user" },
    ]);
  } finally {
    view.unmount();
  }
});

test("a pending session resumed before its first question is named without duplication", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const summary = await fixture.sessionStore.create({
    title: "新 Session",
    titlePending: true,
    workspacePath: "C:\\workspace",
    model: toSessionModelForTest(model),
  });
  let titleQuestion: string | undefined;
  fixture.dependencies.generateSessionTitle = async (_model, firstQuestion) => {
    titleQuestion = firstQuestion;
    return "Resumed title";
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/resume");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("New Session"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => !(view.lastFrame() ?? "").includes("Resume session"));
  view.stdin.write("first after resume");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: first after resume"));
  await waitFor(() => titleQuestion === "first after resume");

  assert.equal(fixture.sessionStore.sessions.size, 1);
  const loaded = await fixture.sessionStore.load(summary.id);
  assert.equal(loaded.summary.title, "Resumed title");
  assert.equal(loaded.summary.title_pending, false);
  view.unmount();
});

test("/resume restores transcript, workspace, context, and continues the same session", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const restoredContexts: Array<readonly Record<string, unknown>[]> = [];
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io, restore) => {
      restoredContexts.push(restore?.initialContext ?? []);
      return {
        async runTurn(input) {
          await restore?.onContextAppend?.([{ role: "user", content: input }]);
          io.writeAssistant(`continued: ${input}`);
          return {};
        },
      };
    },
  });
  const summary = await fixture.sessionStore.create({
    title: "Old session",
    titlePending: false,
    workspacePath: "C:\\old-repo",
    model: toSessionModelForTest(model),
  });
  await fixture.sessionStore.appendTimeline(summary.id, {
    kind: "user",
    text: "before restart",
  });
  await fixture.sessionStore.appendTimeline(summary.id, {
    kind: "assistant",
    text: "old answer",
  });
  await fixture.sessionStore.appendContext(summary.id, [
    { role: "user", content: "before restart" },
    { type: "message", role: "assistant", content: "old answer" },
  ]);
  const workspaces: string[] = [];
  fixture.dependencies.changeWorkspace = async (workspacePath) => {
    workspaces.push(workspacePath);
    return workspacePath;
  };

  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );
  await tick();
  view.stdin.write("/resume");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Scope: This workspace"));
  await tick();
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitFor(() => (view.lastFrame() ?? "").includes("Old session"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("old answer"));

  assert.deepEqual(workspaces, ["C:\\old-repo"]);
  assert.match(view.lastFrame() ?? "", /C:\\old-repo/);
  assert.deepEqual(restoredContexts.at(-1), [
    { role: "user", content: "before restart" },
    { type: "message", role: "assistant", content: "old answer" },
  ]);

  view.stdin.write("\u001b[A");
  await waitFor(() => !(view.lastFrame() ?? "").includes("Ask Everpeace"));
  assert.match((view.lastFrame() ?? "").split("\n").filter((line) => line.trimStart().startsWith("›")).at(-1) ?? "", /before restart/);
  view.stdin.write("\u001b[B");
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
  view.stdin.write("continue now");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("continued: continue now"));
  assert.equal(fixture.sessionStore.sessions.size, 1);
  const loaded = await fixture.sessionStore.load(summary.id);
  const lastEntry = loaded.timeline.at(-1);
  assert.ok(lastEntry && "text" in lastEntry);
  assert.match(lastEntry.text, /continued: continue now/);
  assert.deepEqual(loaded.context.at(-1), { role: "user", content: "continue now" });
  view.unmount();
});

test("/resume exposes batch session deletion", async () => {
  const model: RegisteredModel = { id: "model-1", model_name: "deepseek-flash", base_url: "https://api.deepseek.com", api_key: "secret" };
  const fixture = createFixture({ initial: [model] });
  const first = await fixture.sessionStore.create({ title: "First", titlePending: false, workspacePath: "C:\\workspace", model: toSessionModelForTest(model) });
  const second = await fixture.sessionStore.create({ title: "Second", titlePending: false, workspacePath: "C:\\workspace", model: toSessionModelForTest(model) });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  await tick();
  view.stdin.write("/resume");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Scope: This workspace"));
  assert.match(view.lastFrame() ?? "", /Delete sessions\.\.\./u);
  assert.match(view.lastFrame() ?? "", /First/u);
  assert.match(view.lastFrame() ?? "", /Second/u);
  view.unmount();
});

test("/resume asks for a replacement model and preserves the restored context", async () => {
  const replacement: RegisteredModel = {
    id: "model-new",
    model_name: "gpt-5",
    base_url: "https://api.openai.com/v1",
    api_key: "secret",
  };
  const restoredContexts: Array<readonly Record<string, unknown>[]> = [];
  const fixture = createFixture({
    initial: [replacement],
    createAgent: (_model, _io, restore) => {
      restoredContexts.push(restore?.initialContext ?? []);
      return { async runTurn() { return {}; } };
    },
  });
  const oldModel: SessionModelRef = {
    id: "removed-model",
    model_name: "removed-model-name",
    base_url: "https://old.example.com/v1",
  };
  const summary = await fixture.sessionStore.create({
    title: "Needs replacement",
    titlePending: false,
    workspacePath: "C:\\restored",
    model: oldModel,
  });
  await fixture.sessionStore.appendTimeline(summary.id, {
    kind: "user",
    text: "remember this",
  });
  await fixture.sessionStore.appendContext(summary.id, [
    { role: "user", content: "remember this" },
  ]);

  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [replacement], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );
  await tick();
  view.stdin.write("/resume");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Scope: This workspace"));
  await tick();
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitFor(() => (view.lastFrame() ?? "").includes("Needs replacement"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("choose a replacement"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("remember this"));

  const loaded = await fixture.sessionStore.load(summary.id);
  assert.deepEqual(loaded.summary.model, {
    ...toSessionModelForTest(replacement),
    request_settings: { reasoningEffort: "high", maxOutputTokens: 32_768 },
  });
  assert.deepEqual(loaded.context, [{ role: "user", content: "remember this" }]);
  assert.deepEqual(restoredContexts.at(-1), loaded.context);
  view.unmount();
});

test("/resume keeps the current conversation when the stored workspace is missing", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const summary = await fixture.sessionStore.create({
    title: "Missing workspace",
    titlePending: false,
    workspacePath: "C:\\missing",
    model: toSessionModelForTest(model),
  });
  await fixture.sessionStore.appendTimeline(summary.id, {
    kind: "user",
    text: "must not replace current view",
  });
  fixture.dependencies.changeWorkspace = async () => {
    throw new Error("ENOENT: workspace not found");
  };
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("/resume");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Scope: This workspace"));
  await tick();
  view.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitFor(() => (view.lastFrame() ?? "").includes("Missing workspace"));
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("workspace not found"));

  const frame = lastBorderedSurface(view.lastFrame() ?? "");
  assert.doesNotMatch(frame, /C:\\workspace/);
  assert.doesNotMatch(frame, /must not replace current view/);

  await tick();
  view.stdin.write("\u001B");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace to do anything"));
  assert.match(view.lastFrame() ?? "", /C:\\workspace/);
  assert.doesNotMatch(view.lastFrame() ?? "", /must not replace current view/);
  view.unmount();
});

test("/clear causes the next question to create a different session", async () => {
  const model: RegisteredModel = {
    id: "model-1",
    model_name: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    api_key: "secret",
  };
  const fixture = createFixture({ initial: [model] });
  const view = render(
    <EverpeaceApp
      dependencies={fixture.dependencies}
      initialModels={{ available: [model], missing: [] }}
      onReplayOutput={(update) => update()}
    />,
  );

  await tick();
  view.stdin.write("first session");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: first session"));
  view.stdin.write("/clear");
  await tick();
  view.stdin.write("\r");
  await tick();
  view.stdin.write("second session");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("echo: second session"));

  assert.equal(fixture.sessionStore.sessions.size, 2);
  view.unmount();
});

function toSessionModelForTest(model: RegisteredModel): SessionModelRef {
  return {
    id: model.id,
    model_name: model.model_name,
    base_url: model.base_url,
  };
}

test("/permissions is transient and changes the live policy without rebuilding the agent", async () => {
  const model: RegisteredModel = { id: "permissions-model", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
  let io: AgentIO | undefined;
  let created = 0;
  const fixture = createFixture({ initial: [model], createAgent: (_model, agentIo) => {
    io = agentIo;
    created++;
    return { async runTurn() { return {}; } };
  } });
  const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  await tick();
  const before = created;
  assert.equal(io?.getPermissions?.().mode, "workspace-write");
  view.stdin.write("/permissions");
  await tick();
  view.stdin.write("\r");
  await waitFor(() => (view.lastFrame() ?? "").includes("Codex native OS enforcement"));
  view.stdin.write("\u001B[A");
  await tick();
  view.stdin.write("\u001B[A");
  await tick();
  assert.doesNotMatch(lastBorderedSurface(view.lastFrame() ?? ""), /Ask Everpeace/);
  await tick();
  view.stdin.write("\r");
  await waitFor(() => io?.getPermissions?.().mode === "read-only");
  assert.equal(created, before);
  assert.equal(fixture.sessionStore.sessions.size, 0);
  view.unmount();
});

test("budget stop bypasses workflow completion and automatic continuation", async () => {
  for (const stopReason of ["budget_limited", "usage_limited"] as const) {
    const model: RegisteredModel = { id: "budget", model_name: "test", base_url: "https://example.com/v1", api_key: "secret" };
    let turns = 0, commands = 0;
    const phases: string[] = [];
    const fixture = createFixture({ initial: [model], createAgent: () => ({
      async runTurn() { turns++; return { stopReason }; },
    }) });
    fixture.dependencies.sessionStore.setWorkflow = async (_id, state) => { phases.push(state.phase); };
    fixture.dependencies.runBash = async () => { commands++; return { stdout: "", stderr: "", exitCode: 0, signal: null }; };
    const view = render(<EverpeaceApp dependencies={fixture.dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
    try {
      await tick();
      view.stdin.write("bounded task");
      await tick();
      view.stdin.write("\r");
      await waitFor(() => (view.lastFrame() ?? "").includes("Work stopped before further tools or model requests"));
      assert.equal(turns, 1);
      assert.equal(commands, 0);
      assert.deepEqual(phases, ["understand"]);
      assert.doesNotMatch(view.lastFrame() ?? "", /Model request failed/);
    } finally { view.unmount(); }
  }
});
