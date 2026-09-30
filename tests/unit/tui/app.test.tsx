import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import type { AgentIO } from "../../../src/agent/react-agent.js";
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await tick();
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
  const bottom = lines.findLastIndex((line) => line.trimStart().startsWith("╰"));
  assert.ok(bottom >= 0, "expected a bordered command surface");
  let top = bottom;
  while (top >= 0 && !lines[top]!.trimStart().startsWith("╭")) top -= 1;
  assert.ok(top >= 0, "expected the command surface top border");
  return lines.slice(top, bottom + 1).join("\n");
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
        summary: { ...session.summary, model: { ...session.summary.model } },
        timeline: session.timeline.map((entry) => ({ ...entry })),
        context: session.context.map((item) => ({ ...item })),
        usage: { ...session.usage },
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

test("history below the Codex row cap stays visible and remains persisted", async () => {
  const model: RegisteredModel = { id: "window", model_name: "test-model", base_url: "https://example.com", api_key: "test" };
  const fixture = createFixture({
    initial: [model],
    createAgent: (_model, io) => ({
      async runTurn() {
        for (let index = 0; index < 205; index++) io.writeAssistant(`window-reply-${index}.`);
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
      async runTurn(input) { io.writeAssistant(`done: ${input}`); },
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
    recent: [{ scope: "project", lesson: "Validate inputs first", applyWhen: "When adding commands", createdAt: "2026-09-20T00:00:00.000Z" }],
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
  Object.defineProperty(view.stdout, "columns", {
    configurable: true,
    value: 64,
  });
  view.stdout.emit("resize");
  await new Promise((resolve) =>
    setTimeout(resolve, RESIZE_REDRAW_DEBOUNCE_MS + 30),
  );
  const commandFrame = lastBorderedSurface(view.lastFrame() ?? "");
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
      return { async runTurn() {} };
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
    oldSession.timeline.map((entry) => entry.text).join("\n"),
    /new conversation/,
  );
  const newSession = [...fixture.sessionStore.sessions.values()].at(-1);
  assert.ok(newSession);
  assert.match(
    newSession.timeline.map((entry) => entry.text).join("\n"),
    /new conversation/,
  );
  view.unmount();
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
  assert.match(loaded.timeline.at(-1)?.text ?? "", /continued: continue now/);
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
  await waitFor(() => (view.lastFrame() ?? "").includes("Resume session"));
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
      return { async runTurn() {} };
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
    return { async runTurn() {} };
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
