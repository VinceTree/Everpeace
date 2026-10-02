import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import lockfile from "proper-lockfile";
import {
  defaultSessionDirectory,
  SessionStore,
  type SessionModelRef,
  type SessionGoal,
} from "../../../src/storage/session-store.js";
import type { WorkflowState } from "../../../src/workflow/types.js";
import type { TaskProgress } from "../../../src/workflow/task-progress.js";
import { prepareToolOutput, type PreparedOutputAttachment } from "../../../src/agent/context-limits.js";

const model: SessionModelRef = {
  id: "model-1",
  model_name: "deepseek-chat",
  base_url: "https://api.deepseek.com",
};

test("command output metadata round-trips alongside legacy output without changing context", async () => {
  const fixture = await createFixture();
  try {
    const session = await fixture.store.create({ title: "output", titlePending: false, workspacePath: "C:\\repo", model });
    const command = { id: "command-1", command: "echo hello", shell: "Bash", workspace: "C:\\repo", source: "user" as const, status: "cancelled" as const, durationMs: 123, truncated: true };
    await fixture.store.appendTimeline(session.id, { kind: "output", text: "legacy" });
    await fixture.store.appendTimeline(session.id, { kind: "output", text: "hello", command });
    const loaded = await fixture.store.load(session.id);
    assert.deepEqual(loaded.timeline, [{ kind: "output", text: "legacy" }, { kind: "output", text: "hello", command }]);
    assert.deepEqual(loaded.context, []);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-sessions-"));
  let id = 0;
  let seconds = 0;
  const store = new SessionStore({
    directory,
    createId: () => `session-${++id}`,
    now: () => new Date(`2026-09-16T00:00:${String(seconds++).padStart(2, "0")}.000Z`),
  });
  return {
    directory,
    store,
    cleanup: () => fs.rm(directory, { recursive: true, force: true }),
  };
}

test("session store round-trips timeline, context, title, and model changes", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({
      title: "first question",
      titlePending: false,
      workspacePath: "C:\\repo",
      model,
    });
    await Promise.all([
      fixture.store.appendTimeline(created.id, { kind: "user", text: "first question" }),
      fixture.store.appendContext(created.id, [{ role: "user", content: "first question" }]),
      fixture.store.appendTimeline(created.id, { kind: "assistant", text: "answer" }),
    ]);
    await fixture.store.updateTitle(created.id, "Generated title");

    const replacement: SessionModelRef = {
      id: "model-2",
      model_name: "gpt-5",
      base_url: "https://api.openai.com/v1",
    };
    await fixture.store.selectModel(created.id, replacement, true);

    const loaded = await fixture.store.load(created.id);
    assert.equal(loaded.summary.title, "Generated title");
    assert.equal(loaded.summary.title_pending, false);
    assert.deepEqual(loaded.summary.model, replacement);
    assert.deepEqual(loaded.timeline, [
      { kind: "user", text: "first question" },
      { kind: "assistant", text: "answer" },
    ]);
    assert.deepEqual(loaded.context, [{ role: "user", content: "first question" }]);

    await fixture.store.selectModel(created.id, model, false);
    assert.deepEqual((await fixture.store.load(created.id)).context, []);
  } finally {
    await fixture.cleanup();
  }
});

test("session search matches titles and conversation text while excluding tool and context data", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.store.create({ title: "Build parser", titlePending: false, workspacePath: "C:\\repo", model });
    await fixture.store.appendTimeline(first.id, { kind: "user", text: "Please add Unicode support" });
    await fixture.store.appendTimeline(first.id, { kind: "assistant", text: "Added the tokenizer" });
    await fixture.store.appendTimeline(first.id, { kind: "tool", text: "hidden tool needle" });
    await fixture.store.appendContext(first.id, [{ role: "user", content: "hidden context needle" }]);
    const second = await fixture.store.create({ title: "Other task", titlePending: false, workspacePath: "D:\\other", model });
    await fixture.store.appendTimeline(second.id, { kind: "assistant", text: "Unicode in another workspace" });

    const title = await fixture.store.search({ query: "PARSER", workspacePath: "c:/repo/" });
    assert.deepEqual(title.matches.map((match) => [match.summary.id, match.match?.kind]), [[first.id, "title"]]);
    const message = await fixture.store.search({ query: "unicode", workspacePath: "C:\\repo" });
    assert.deepEqual(message.matches.map((match) => [match.summary.id, match.match?.kind]), [[first.id, "user"]]);
    assert.match(message.matches[0]?.match?.snippet ?? "", /Unicode/u);
    assert.deepEqual(message.matches[0]?.preview?.map((item) => item.kind), ["user", "assistant"]);
    assert.equal((await fixture.store.search({ query: "needle" })).total, 0);
    assert.equal((await fixture.store.search({ query: "unicode" })).total, 2);

    await fixture.store.appendTimeline(first.id, { kind: "assistant", text: "A newly cached phrase" });
    assert.equal((await fixture.store.search({ query: "newly cached" })).matches[0]?.summary.id, first.id);
    await fixture.store.deleteMany([first.id]);
    assert.equal((await fixture.store.search({ query: "newly cached" })).total, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("session search paginates newest-first and isolates corrupt JSONL files", async () => {
  const fixture = await createFixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      await fixture.store.create({ title: `match ${index}`, titlePending: false, workspacePath: "C:\\repo", model });
    }
    await fs.writeFile(path.join(fixture.directory, "corrupt.jsonl"), "{bad}\n", "utf8");
    const result = await fixture.store.search({ query: "match", offset: 1, limit: 1 });
    assert.equal(result.total, 3);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.summary.title, "match 1");
    assert.equal(result.skipped, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("session model request settings round-trip while legacy model refs stay valid", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({
      title: "settings",
      titlePending: false,
      workspacePath: "C:\\repo",
      model: {
        ...model,
        request_settings: { reasoningEffort: "max", maxOutputTokens: 16_384 },
      },
    });
    assert.deepEqual((await fixture.store.load(created.id)).summary.model.request_settings, {
      reasoningEffort: "max",
      maxOutputTokens: 16_384,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("session store replaces model context on compaction and counts its usage", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({ title: "compact", titlePending: false, workspacePath: "C:\\repo", model });
    await fixture.store.appendContext(created.id, [{ role: "user", content: "old" }]);
    await fixture.store.appendUsage(created.id, { input_tokens: 10, output_tokens: 2, total_tokens: 12 });
    await fixture.store.compactContext(
      created.id,
      [{ type: "compaction", encrypted_content: "opaque" }],
      true,
      { input_tokens: 80, output_tokens: 8, total_tokens: 88 },
    );
    const loaded = await fixture.store.load(created.id);
    assert.deepEqual(loaded.context, [{ type: "compaction", encrypted_content: "opaque" }]);
    assert.deepEqual(loaded.usage, {
      input_tokens: 90,
      output_tokens: 10,
      context_tokens: null,
      complete: true,
      cache_usage_complete: false,
      cache_write_usage_complete: false,
    });
    await fixture.store.appendUsage(created.id, { input_tokens: 12, output_tokens: 2, total_tokens: 14 });
    assert.equal((await fixture.store.load(created.id)).usage.context_tokens, 14);
  } finally {
    await fixture.cleanup();
  }
});

test("session store replays pruning after restart without adding cumulative usage", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({ title: "prune", titlePending: false, workspacePath: "C:\\repo", model });
    const original = [
      { role: "user", content: "old" },
      { type: "function_call", call_id: "call", name: "bash", arguments: "{}" },
      { type: "function_call_output", call_id: "call", output: "large original output" },
    ];
    const pruned = original.map((item) => item.type === "function_call_output"
      ? { ...item, output: JSON.stringify({ status: "context_pruned", history_reference: { event_id: "history_ref" } }) }
      : item);
    await fixture.store.appendContext(created.id, original);
    await fixture.store.appendUsage(created.id, { input_tokens: 40, output_tokens: 4, total_tokens: 44 });
    await fixture.store.pruneContext(created.id, pruned, {
      original_bytes: 2_000,
      pruned_bytes: 1_000,
      pruned_results: 1,
    });

    const restarted = new SessionStore({ directory: fixture.directory });
    const loaded = await restarted.load(created.id);
    assert.deepEqual(loaded.context, pruned);
    assert.deepEqual(loaded.usage, {
      input_tokens: 40,
      output_tokens: 4,
      context_tokens: null,
      complete: true,
      cache_usage_complete: false,
      cache_write_usage_complete: false,
    });
    const log = await fs.readFile(path.join(fixture.directory, `${created.id}.jsonl`), "utf8");
    assert.match(log, /"type":"context_append"/u);
    assert.match(log, /large original output/u);
    assert.match(log, /"type":"context_pruned"/u);
  } finally {
    await fixture.cleanup();
  }
});

test("session store persists prompt cache usage details with legacy compatibility", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({ title: "cache", titlePending: false, workspacePath: "C:\\repo", model });
    await fixture.store.appendUsage(created.id, {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      cached_input_tokens: 80,
      cache_write_input_tokens: 20,
    });
    const loaded = await fixture.store.load(created.id);
    assert.deepEqual(loaded.usage, {
      input_tokens: 100,
      output_tokens: 10,
      context_tokens: 110,
      cached_input_tokens: 80,
      cache_observed_input_tokens: 100,
      cache_write_input_tokens: 20,
      cache_usage_complete: true,
      cache_write_usage_complete: true,
      complete: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("session store round-trips a goal and preserves it in the session summary", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({ title: "goal", titlePending: false, workspacePath: "C:\\repo", model });
    const goal: SessionGoal = {
      goal_id: "goal-1", objective: "Ship it", status: "active", token_budget: 100,
      tokens_used: 20, usage_complete: true, time_used_seconds: 3,
      created_at: "2026-09-16T00:00:00.000Z", updated_at: "2026-09-16T00:00:00.000Z",
    };
    await fixture.store.setGoal(created.id, goal);
    await fixture.store.updateGoal(created.id, { status: "complete", tokens_used: 40 });
    const loaded = await fixture.store.load(created.id);
    assert.equal(loaded.goal?.status, "complete");
    assert.equal(loaded.goal?.tokens_used, 40);
    assert.equal((await fixture.store.list()).sessions[0]?.goal?.goal_id, "goal-1");
  } finally {
    await fixture.cleanup();
  }
});

test("session store round-trips additive task progress and keeps legacy sessions compatible", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({ title: "tasks", titlePending: false, workspacePath: "C:\\repo", model });
    assert.equal((await fixture.store.load(created.id)).taskProgress, undefined);
    const progress: TaskProgress = {
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "in_progress" },
      ],
      updated_at: "2026-10-01T00:00:00.000Z",
    };
    await fixture.store.setTaskProgress(created.id, progress);
    progress.plan[0]!.step = "mutated caller";
    const loaded = await fixture.store.load(created.id);
    assert.equal(loaded.taskProgress?.plan[0]?.step, "Inspect");
    assert.deepEqual(loaded.summary.task_progress, loaded.taskProgress);
    assert.deepEqual((await fixture.store.list()).sessions[0]?.task_progress, loaded.taskProgress);
  } finally {
    await fixture.cleanup();
  }
});

test("session store round-trips workflow metadata without storing file contents", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({ title: "workflow", titlePending: false, workspacePath: "C:\\repo", model });
    const workflow: WorkflowState = {
      task_id: "task-1",
      task_source: "session_resume",
      phase: "verify_fast",
      repair_attempts: 0,
      max_repair_attempts: 3,
      changed_paths: ["src/index.ts"],
      checkpoint_available: true,
      result: "failed",
      result_reason: "Workspace changed during final verification",
      tracking_limited: false,
      verification_retries: 2,
      pending_verification: true,
      workspace_revision: "workspace-sha",
      verification_revision: "verification-sha",
      prior_unverified: { task_id: "task-0", result: "unverified", reason: "No checks" },
      last_verification: {
        command: { id: "node:typecheck", label: "Node typecheck", command: "pnpm run typecheck", tier: "fast", timeoutMs: 60_000 },
        passed: true,
        exitCode: 0,
        stdout: "secret-token-from-check",
        stderr: "",
        durationMs: 12,
        timedOut: false,
      },
      last_verification_suite: {
        status: "unavailable",
        stale: true,
        reason: "Workspace changed during final verification",
        results: [{
          command: { id: "node:typecheck", label: "Node typecheck", command: "pnpm run typecheck", tier: "fast", timeoutMs: 60_000 },
          passed: false,
          exitCode: 1,
          stdout: "suite-secret-output",
          stderr: "suite-secret-error",
          durationMs: 12,
          timedOut: false,
          error: "secret execution error",
        }],
        skipped: [{ id: "node:build", label: "Node build", command: "pnpm run build", tier: "full", timeoutMs: 120_000 }],
      },
      updated_at: "2026-09-16T00:00:00.000Z",
    };
    await fixture.store.setWorkflow(created.id, workflow);
    const loaded = await fixture.store.load(created.id);
    const persistedWorkflow = {
      ...workflow,
      last_verification: { ...workflow.last_verification!, stdout: "", stderr: "" },
      last_verification_suite: {
        ...workflow.last_verification_suite!,
        results: workflow.last_verification_suite!.results.map((result) => {
          const { error: _error, ...metadata } = result;
          return { ...metadata, stdout: "", stderr: "" };
        }),
      },
    };
    assert.deepEqual(loaded.workflow, persistedWorkflow);
    assert.deepEqual((await fixture.store.list()).sessions[0]?.workflow, persistedWorkflow);
    const raw = await fs.readFile(path.join(fixture.directory, `${created.id}.jsonl`), "utf8");
    assert.doesNotMatch(raw, /beforeContent|file contents/iu);
    assert.doesNotMatch(raw, /secret-token-from-check/u);
    assert.doesNotMatch(raw, /suite-secret-output|suite-secret-error|secret execution error/u);
  } finally {
    await fixture.cleanup();
  }
});

test("pending titles survive reload and are cleared by a title update", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({
      title: "新 Session",
      titlePending: true,
      workspacePath: "C:\\repo",
      model,
    });
    assert.equal((await fixture.store.load(created.id)).summary.title_pending, true);

    await fixture.store.updateTitle(created.id, "first question");
    const loaded = await fixture.store.load(created.id);
    assert.equal(loaded.summary.title, "first question");
    assert.equal(loaded.summary.title_pending, false);
  } finally {
    await fixture.cleanup();
  }
});

test("session files written before title_pending default to a completed title", async () => {
  const fixture = await createFixture();
  try {
    const legacyHeader = {
      version: 1,
      type: "session_created",
      at: "2026-09-16T00:00:00.000Z",
      session_id: "legacy-session",
      title: "legacy",
      workspace_path: "C:\\repo",
      model,
    };
    await fs.writeFile(
      path.join(fixture.directory, "legacy-session.jsonl"),
      `${JSON.stringify(legacyHeader)}\n`,
      "utf8",
    );

    const loaded = await fixture.store.load("legacy-session");
    assert.equal(loaded.summary.title_pending, false);
    assert.deepEqual(loaded.usage, {
      input_tokens: 0,
      output_tokens: 0,
      context_tokens: null,
      complete: false,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("session memory policy round-trips while legacy sessions keep defaults external", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({ title: "memory", titlePending: false, workspacePath: "C:\\repo", model });
    assert.equal((await fixture.store.load(created.id)).memoryPolicy, undefined);
    await fixture.store.setMemoryPolicy(created.id, { readExisting: false, captureFuture: true });
    const loaded = await fixture.store.load(created.id);
    assert.deepEqual(loaded.memoryPolicy, { readExisting: false, captureFuture: true });
    assert.deepEqual(loaded.summary.memory_policy, loaded.memoryPolicy);
  } finally {
    await fixture.cleanup();
  }
});

test("session store loads usage totals, context resets, and legacy status snapshots", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({
      title: "usage",
      titlePending: false,
      workspacePath: "C:\\repo",
      model,
    });
    await fixture.store.appendUsage(created.id, {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    });
    await fixture.store.appendUsage(created.id, {
      input_tokens: 150,
      output_tokens: 30,
      total_tokens: 180,
    });
    await fixture.store.appendTimeline(created.id, {
      kind: "status",
      snapshot: {
        version: "0.1.20",
        model_name: "deepseek-chat",
        provider: "DeepSeek",
        base_url: "https://api.deepseek.com",
        workspace_path: "C:\\repo",
        session_id: created.id,
        context_window: null,
        context_tokens: 180,
        input_tokens: 250,
        output_tokens: 50,
        usage_complete: true,
      },
    });

    let loaded = await fixture.store.load(created.id);
    assert.deepEqual(loaded.usage, {
      input_tokens: 250,
      output_tokens: 50,
      context_tokens: 180,
      complete: true,
      cache_usage_complete: false,
      cache_write_usage_complete: false,
    });
    assert.equal(loaded.timeline.at(-1)?.kind, "status");

    await fixture.store.selectModel(created.id, model, false);
    loaded = await fixture.store.load(created.id);
    assert.deepEqual(loaded.usage, {
      input_tokens: 250,
      output_tokens: 50,
      context_tokens: 0,
      complete: true,
      cache_usage_complete: false,
      cache_write_usage_complete: false,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("missing provider usage is persisted as partial without corrupting the session", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({
      title: "partial usage",
      titlePending: false,
      workspacePath: "C:\\repo",
      model,
    });
    await fixture.store.appendUsage(created.id, null);
    assert.deepEqual((await fixture.store.load(created.id)).usage, {
      input_tokens: 0,
      output_tokens: 0,
      context_tokens: null,
      complete: false,
      cache_usage_complete: false,
      cache_write_usage_complete: false,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("session list is global, newest-first, and isolates corrupt files", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.store.create({
      title: "one",
      titlePending: false,
      workspacePath: "C:\\one",
      model,
    });
    const second = await fixture.store.create({
      title: "two",
      titlePending: false,
      workspacePath: "C:\\two",
      model,
    });
    await fixture.store.appendTimeline(first.id, { kind: "user", text: "active again" });
    await fs.writeFile(path.join(fixture.directory, "broken.jsonl"), "not json\n", "utf8");

    const result = await fixture.store.list();
    assert.deepEqual(result.sessions.map((session) => session.id), [first.id, second.id]);
    assert.equal(result.skipped, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("session store permanently deletes selected sessions without touching others", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.store.create({ title: "one", titlePending: false, workspacePath: "C:\\one", model });
    const second = await fixture.store.create({ title: "two", titlePending: false, workspacePath: "C:\\two", model });
    const third = await fixture.store.create({ title: "three", titlePending: false, workspacePath: "C:\\three", model });
    await fixture.store.deleteMany([first.id, third.id, first.id]);
    assert.deepEqual((await fixture.store.list()).sessions.map((session) => session.id), [second.id]);
    await assert.rejects(() => fixture.store.load(first.id), /ENOENT/u);
    assert.equal((await fixture.store.load(second.id)).summary.title, "two");
    await fixture.store.deleteMany(["missing-session"]);
  } finally {
    await fixture.cleanup();
  }
});

test("session load ignores only an incomplete final JSONL line", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({
      title: "safe",
      titlePending: false,
      workspacePath: "C:\\repo",
      model,
    });
    await fixture.store.appendTimeline(created.id, { kind: "user", text: "kept" });
    const filePath = path.join(fixture.directory, `${created.id}.jsonl`);
    await fs.appendFile(filePath, "{\"version\":1", "utf8");

    assert.deepEqual((await fixture.store.load(created.id)).timeline, [
      { kind: "user", text: "kept" },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("default session directory follows platform state locations", () => {
  assert.equal(
    defaultSessionDirectory("win32", { APPDATA: "C:\\Config" }, "C:\\Users\\Test"),
    "C:\\Config\\Everpeace\\sessions",
  );
  assert.equal(
    defaultSessionDirectory("linux", { XDG_STATE_HOME: "/state" }, "/home/test"),
    path.join("/state", "everpeace", "sessions"),
  );
});

test("fork publishes an independent Session with inherited history, attachments, and unsettled verification debt", async () => {
  const fixture = await createFixture();
  try {
    const parent = await fixture.store.create({ title: "Parent", titlePending: false, workspacePath: "C:\\repo", model });
    await fixture.store.updateTitle(parent.id, "Renamed parent");
    await fixture.store.appendTimeline(parent.id, { kind: "user", text: "diagnose the build" });
    await fixture.store.appendContext(parent.id, [
      { type: "message", role: "user", content: "diagnose the build" },
      { type: "function_call", name: "bash", call_id: "large-call", arguments: "{}" },
    ]);
    const prepared = prepareToolOutput(`HEAD\r\n${"中😀".repeat(20_000)}\nTAIL`, "bash");
    assert.ok(prepared.attachment);
    await fixture.store.commitToolResult(parent.id, {
      type: "function_call_output",
      call_id: "large-call",
      output: prepared.output,
    }, prepared.attachment);
    const beforePrune = (await fixture.store.load(parent.id)).context;
    await fixture.store.pruneContext(parent.id, beforePrune.map((item) => item.type === "function_call_output"
      ? {
          ...item,
          output: JSON.stringify({
            status: "context_pruned",
            output_id: prepared.attachment!.output_id,
            continuation: { tool: "read_tool_output", offset_bytes: 0 },
            history_reference: { tool: "session_event_read", event_id: "history_parent" },
          }),
        }
      : item), { original_bytes: 20_000, pruned_bytes: 5_000, pruned_results: 1 });
    await fixture.store.appendUsage(parent.id, { input_tokens: 90, output_tokens: 10, total_tokens: 100 });
    await fixture.store.setGoal(parent.id, {
      goal_id: "goal-parent",
      objective: "finish",
      status: "active",
      token_budget: 1_000,
      tokens_used: 100,
      usage_complete: true,
      time_used_seconds: 5,
      created_at: "2026-09-16T00:00:00.000Z",
      updated_at: "2026-09-16T00:00:00.000Z",
    });
    await fixture.store.setWorkflow(parent.id, {
      task_id: "parent-task",
      task_source: "user",
      phase: "done",
      repair_attempts: 2,
      max_repair_attempts: 3,
      changed_paths: ["src/index.ts"],
      checkpoint_available: true,
      result: "verified",
      pending_verification: false,
      verification_revision: "old-success",
      updated_at: "2026-09-16T00:00:00.000Z",
    });
    await fixture.store.setTaskProgress(parent.id, {
      plan: [{ step: "Inspect failure", status: "completed" }],
      updated_at: "2026-09-16T00:00:00.000Z",
    });
    await fixture.store.setMemoryPolicy(parent.id, { readExisting: false, captureFuture: true });

    const child = await fixture.store.fork(parent.id, { title: "Child branch" });
    const loaded = await fixture.store.load(child.id);
    const parentAtFork = await fixture.store.load(parent.id);
    assert.equal(loaded.summary.title, "Child branch");
    assert.equal(loaded.summary.lineage?.parent_session_id, parent.id);
    assert.equal(loaded.summary.fork_pending_resume, true);
    assert.equal(loaded.forkPendingResume, true);
    assert.deepEqual(loaded.timeline, parentAtFork.timeline);
    assert.deepEqual(loaded.context, parentAtFork.context);
    assert.deepEqual(loaded.usage, { input_tokens: 0, output_tokens: 0, context_tokens: 0, complete: true });
    assert.equal(loaded.goal, undefined);
    assert.notEqual(loaded.workflow?.task_id, "parent-task");
    assert.equal(loaded.workflow?.task_source, "session_resume");
    assert.equal(loaded.workflow?.repair_attempts, 0);
    assert.deepEqual(loaded.workflow?.changed_paths, ["src/index.ts"]);
    assert.equal(loaded.workflow?.pending_verification, true);
    assert.equal(loaded.workflow?.checkpoint_available, false);
    assert.equal(loaded.workflow?.result, undefined);
    assert.equal(loaded.workflow?.workspace_revision, undefined);
    assert.equal(loaded.workflow?.verification_revision, undefined);
    assert.equal(loaded.workflow?.last_verification, undefined);
    assert.equal(loaded.workflow?.last_verification_suite, undefined);
    assert.equal(loaded.taskProgress?.inherited_from_session_id, parent.id);
    assert.deepEqual(loaded.memoryPolicy, { readExisting: false, captureFuture: true });

    const copiedOutput = await fixture.store.readToolOutput(child.id, prepared.attachment.output_id);
    assert.deepEqual(copiedOutput?.bytes, prepared.attachment.bytes);
    await fixture.store.appendTimeline(child.id, { kind: "assistant", text: "child only" });
    await fixture.store.appendTimeline(parent.id, { kind: "assistant", text: "parent after fork" });
    assert.deepEqual((await fixture.store.load(child.id)).timeline.at(-1), { kind: "assistant", text: "child only" });
    assert.deepEqual((await fixture.store.load(parent.id)).timeline.at(-1), { kind: "assistant", text: "parent after fork" });

    await fixture.store.deleteMany([parent.id]);
    assert.deepEqual((await fixture.store.readToolOutput(child.id, prepared.attachment.output_id))?.bytes, prepared.attachment.bytes);

    await fixture.store.setForkPendingResume(child.id, false);
    const restarted = new SessionStore({ directory: fixture.directory });
    assert.equal((await restarted.load(child.id)).forkPendingResume, false);
  } finally {
    await fixture.cleanup();
  }
});

test("fork preserves prior and interrupted verification debt without restoring observations", async () => {
  const fixture = await createFixture();
  try {
    const priorParent = await fixture.store.create({ title: "Prior debt", titlePending: false, workspacePath: "C:\\repo", model });
    await fixture.store.setWorkflow(priorParent.id, {
      task_id: "current-clean-task",
      task_source: "user",
      phase: "understand",
      repair_attempts: 0,
      max_repair_attempts: 3,
      changed_paths: [],
      checkpoint_available: false,
      prior_unverified: { task_id: "older-task", result: "failed", reason: "Checks failed" },
      updated_at: "2026-09-16T00:00:00.000Z",
    });
    const priorChild = await fixture.store.fork(priorParent.id);
    const priorWorkflow = (await fixture.store.load(priorChild.id)).workflow;
    assert.equal(priorWorkflow?.pending_verification, true);
    assert.deepEqual(priorWorkflow?.prior_unverified, {
      task_id: "older-task",
      result: "failed",
      reason: "Checks failed",
    });

    const interruptedParent = await fixture.store.create({ title: "Interrupted tracking", titlePending: false, workspacePath: "C:\\repo", model });
    await fixture.store.setWorkflow(interruptedParent.id, {
      task_id: "interrupted-task",
      task_source: "user",
      phase: "understand",
      repair_attempts: 2,
      max_repair_attempts: 3,
      changed_paths: [],
      checkpoint_available: false,
      tracking_limited: true,
      workspace_revision: "stale-observation",
      updated_at: "2026-09-16T00:00:00.000Z",
    });
    const interruptedChild = await fixture.store.fork(interruptedParent.id);
    const interruptedWorkflow = (await fixture.store.load(interruptedChild.id)).workflow;
    assert.equal(interruptedWorkflow?.pending_verification, true);
    assert.deepEqual(interruptedWorkflow?.prior_unverified, {
      task_id: "interrupted-task",
      result: "unverified",
      reason: "Forked sessions must revalidate inherited workspace changes",
    });
    assert.equal(interruptedWorkflow?.repair_attempts, 0);
    assert.equal(interruptedWorkflow?.tracking_limited, undefined);
    assert.equal(interruptedWorkflow?.workspace_revision, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("forked attachment retention, eviction, and deletion stay independent", async () => {
  const fixture = await createFixture();
  try {
    const parent = await fixture.store.create({ title: "Attachment parent", titlePending: false, workspacePath: "C:\\repo", model });
    const retained: PreparedOutputAttachment[] = [];
    for (let index = 0; index < 16; index += 1) {
      const prepared = prepareToolOutput(`${index}:${"x".repeat(40_000)}`, "bash");
      assert.ok(prepared.attachment);
      retained.push(prepared.attachment);
      await fixture.store.commitToolResult(parent.id, {
        type: "function_call_output",
        call_id: `parent-${index}`,
        output: prepared.output,
      }, prepared.attachment);
    }

    const child = await fixture.store.fork(parent.id);
    const childExtra = prepareToolOutput(`child:${"c".repeat(40_000)}`, "bash");
    assert.ok(childExtra.attachment);
    await fixture.store.commitToolResult(child.id, {
      type: "function_call_output",
      call_id: "child-extra",
      output: childExtra.output,
    }, childExtra.attachment);
    assert.equal(await fixture.store.readToolOutput(child.id, retained[0]!.output_id), null);
    assert.deepEqual((await fixture.store.readToolOutput(parent.id, retained[0]!.output_id))?.bytes, retained[0]!.bytes);

    const parentExtra = prepareToolOutput(`parent:${"p".repeat(40_000)}`, "bash");
    assert.ok(parentExtra.attachment);
    await fixture.store.commitToolResult(parent.id, {
      type: "function_call_output",
      call_id: "parent-extra",
      output: parentExtra.output,
    }, parentExtra.attachment);
    assert.equal(await fixture.store.readToolOutput(parent.id, retained[0]!.output_id), null);
    assert.deepEqual((await fixture.store.readToolOutput(child.id, childExtra.attachment.output_id))?.bytes, childExtra.attachment.bytes);

    await fixture.store.deleteMany([child.id]);
    assert.deepEqual((await fixture.store.readToolOutput(parent.id, retained[1]!.output_id))?.bytes, retained[1]!.bytes);
  } finally {
    await fixture.cleanup();
  }
});

test("fork publication failure removes staging and never exposes a partial child", async () => {
  const fixture = await createFixture();
  try {
    const parent = await fixture.store.create({ title: "Parent", titlePending: false, workspacePath: "C:\\repo", model });
    const collidingOutputDirectory = path.join(fixture.directory, "outputs", "session-2");
    await fs.mkdir(collidingOutputDirectory, { recursive: true });
    await fs.writeFile(path.join(collidingOutputDirectory, "collision"), "occupied", "utf8");

    await assert.rejects(() => fixture.store.fork(parent.id));
    assert.deepEqual((await fixture.store.list()).sessions.map((session) => session.id), [parent.id]);
    await assert.rejects(() => fs.access(path.join(fixture.directory, "session-2.jsonl")));
    assert.deepEqual(await fs.readdir(path.join(fixture.directory, ".fork-staging")), []);
  } finally {
    await fixture.cleanup();
  }
});

test("startup cleanup preserves active fork staging and removes it after the lease is released", async () => {
  const fixture = await createFixture();
  try {
    const stagingDirectory = path.join(fixture.directory, ".fork-staging", "inflight-child");
    const leasePath = path.join(stagingDirectory, "lease");
    const outputDirectory = path.join(fixture.directory, "outputs", "inflight-child");
    await fs.mkdir(stagingDirectory, { recursive: true });
    await fs.writeFile(leasePath, "", "utf8");
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, "prepared.output"), "prepared", "utf8");
    const release = await lockfile.lock(leasePath, { realpath: false, retries: 0 });
    try {
      await new SessionStore({ directory: fixture.directory }).list();
      assert.equal((await fs.stat(stagingDirectory)).isDirectory(), true);
      assert.equal((await fs.stat(outputDirectory)).isDirectory(), true);
    } finally {
      await release();
    }

    await new SessionStore({ directory: fixture.directory }).list();
    await assert.rejects(() => fs.access(stagingDirectory));
    await assert.rejects(() => fs.access(outputDirectory));
  } finally {
    await fixture.cleanup();
  }
});

test("fork cancellation and invalid titles leave no visible child Session", async () => {
  const fixture = await createFixture();
  try {
    const parent = await fixture.store.create({ title: "Parent", titlePending: false, workspacePath: "C:\\repo", model });
    const controller = new AbortController();
    controller.abort(new Error("cancel fork"));
    await assert.rejects(() => fixture.store.fork(parent.id, { signal: controller.signal }), /cancel fork/u);
    await assert.rejects(() => fixture.store.fork(parent.id, { title: "   " }), /title/u);
    assert.deepEqual((await fixture.store.list()).sessions.map((session) => session.id), [parent.id]);
  } finally {
    await fixture.cleanup();
  }
});
