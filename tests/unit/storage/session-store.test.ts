import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  defaultSessionDirectory,
  SessionStore,
  type SessionModelRef,
  type SessionGoal,
} from "../../../src/storage/session-store.js";
import type { WorkflowState } from "../../../src/workflow/types.js";

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
    });
    await fixture.store.appendUsage(created.id, { input_tokens: 12, output_tokens: 2, total_tokens: 14 });
    assert.equal((await fixture.store.load(created.id)).usage.context_tokens, 14);
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
      cache_write_input_tokens: 20,
      cache_usage_complete: true,
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

test("session store round-trips workflow metadata without storing file contents", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.store.create({ title: "workflow", titlePending: false, workspacePath: "C:\\repo", model });
    const workflow: WorkflowState = {
      task_id: "task-1",
      phase: "verify_fast",
      repair_attempts: 0,
      max_repair_attempts: 3,
      changed_paths: ["src/index.ts"],
      checkpoint_available: true,
      last_verification: {
        command: { id: "node:typecheck", label: "Node typecheck", command: "pnpm run typecheck", tier: "fast", timeoutMs: 60_000 },
        passed: true,
        exitCode: 0,
        stdout: "secret-token-from-check",
        stderr: "",
        durationMs: 12,
        timedOut: false,
      },
      updated_at: "2026-09-16T00:00:00.000Z",
    };
    await fixture.store.setWorkflow(created.id, workflow);
    const loaded = await fixture.store.load(created.id);
    const persistedWorkflow = {
      ...workflow,
      last_verification: { ...workflow.last_verification!, stdout: "", stderr: "" },
    };
    assert.deepEqual(loaded.workflow, persistedWorkflow);
    assert.deepEqual((await fixture.store.list()).sessions[0]?.workflow, persistedWorkflow);
    const raw = await fs.readFile(path.join(fixture.directory, `${created.id}.jsonl`), "utf8");
    assert.doesNotMatch(raw, /beforeContent|file contents/iu);
    assert.doesNotMatch(raw, /secret-token-from-check/u);
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
    });
    assert.equal(loaded.timeline.at(-1)?.kind, "status");

    await fixture.store.selectModel(created.id, model, false);
    loaded = await fixture.store.load(created.id);
    assert.deepEqual(loaded.usage, {
      input_tokens: 250,
      output_tokens: 50,
      context_tokens: 0,
      complete: true,
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
    path.join("C:\\Config", "Everpeace", "sessions"),
  );
  assert.equal(
    defaultSessionDirectory("linux", { XDG_STATE_HOME: "/state" }, "/home/test"),
    path.join("/state", "everpeace", "sessions"),
  );
});
