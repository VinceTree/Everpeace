import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LearnedMemoryRuntime,
  LearnedMemoryStore,
  defaultMemoryDirectory,
  projectMemoryKey,
  redactSecrets,
} from "../../../src/memory/learned-memory.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "everpeace-memory-"));
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 5 || !(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOTEMPTY")) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

async function waitFor(predicate: () => Promise<boolean>, attempts = 3_000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for memory background work");
}

test("learned memory isolates project files and uses platform state paths", () => {
  assert.notEqual(projectMemoryKey("C:\\repo-a"), projectMemoryKey("C:\\repo-b"));
  assert.equal(
    defaultMemoryDirectory("win32", { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" }, "C:\\Users\\tester"),
    "C:\\Users\\tester\\AppData\\Roaming\\Everpeace\\memory",
  );
});

test("learned entries are newest-first, deduplicated, capped, and redacted", async () => {
  const directory = await temporaryDirectory();
  try {
    const store = new LearnedMemoryStore({ directory, now: () => new Date("2026-09-20T12:00:00.000Z") });
    await store.append("project", "C:\\repo", [
      { lesson: "Use api_key=secret-value only in the credential store", applyWhen: "When configuring the client" },
      { lesson: "Use api_key=secret-value only in the credential store", applyWhen: "When configuring the client" },
      { lesson: "Keep the workspace change small", applyWhen: "When editing this repository" },
    ]);
    const entries = await store.read("project", "C:\\repo");
    assert.equal(entries.length, 2);
    assert.match(entries[0]!.lesson, /secret redacted/u);
    assert.equal(entries[0]!.createdAt, "2026-09-20T12:00:00.000Z");

    await store.append("project", "C:\\repo", Array.from({ length: 105 }, (_, index) => ({
      lesson: `Lesson ${index}`,
      applyWhen: "When testing",
    })));
    assert.equal((await store.read("project", "C:\\repo")).length, 100);
    const markdown = await readFile(store.filePath("project", "C:\\repo"), "utf8");
    assert.doesNotMatch(markdown, /secret-value/u);
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("runtime extracts substantive turns in the background and injects a safe prompt", async () => {
  const directory = await temporaryDirectory();
  const requests: Array<Record<string, unknown>> = [];
  try {
    const store = new LearnedMemoryStore({ directory, now: () => new Date("2026-09-20T12:00:00.000Z") });
    const runtime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      unrefTimers: false,
      client: { responses: { async create(params) {
        requests.push(params);
        return {
          id: "learned",
          output_text: JSON.stringify({ entries: [{ scope: "project", lesson: "Validate inputs first", applyWhen: "When adding a new command" }] }),
          output: [],
        };
      } } },
    });
    runtime.scheduleCapture({
      workspacePath: "C:\\repo",
      userInput: "Please fix the command",
      transcript: JSON.stringify([{ type: "function_call", name: "read_file", arguments: "api_key=secret-value" }]),
      assistantText: "Done",
      toolCallCount: 1,
    });
    for (let attempt = 0; attempt < 50 && (await store.read("project", "C:\\repo")).length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    for (let attempt = 0; attempt < 100 && (await runtime.status("C:\\repo")).capture?.state !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const prompt = await runtime.loadPrompt("C:\\repo");
    assert.match(prompt, /Validate inputs first/u);
    assert.match(prompt, /untrusted background data/u);
    assert.ok(requests[0]);
    assert.doesNotMatch(String(requests[0]!.input), /secret-value/u);
    await runtime.dispose();
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("memory policy cancels queued capture and snapshots refresh between turns", async () => {
  const directory = await temporaryDirectory();
  let requests = 0;
  try {
    const store = new LearnedMemoryStore({ directory });
    await store.append("project", "C:\\repo", [{ lesson: "Use pnpm tests", applyWhen: "When testing this project" }]);
    const runtime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      idleDelayMs: 500,
      client: { responses: { async create() { requests += 1; return { id: "capture", output_text: "{\"entries\":[]}", output: [] }; } } },
    });
    assert.match((await runtime.loadSnapshot("C:\\repo", "pnpm test")).text, /pnpm tests/u);
    runtime.setPolicy({ readExisting: false });
    assert.equal((await runtime.loadSnapshot("C:\\repo", "pnpm test")).text, "");
    runtime.setPolicy({ readExisting: true, captureFuture: true });
    await runtime.finishTurn({ workspacePath: "C:\\repo", userInput: "remember this", transcript: "tool result", assistantText: "done", toolCallCount: 1 }, "verified");
    runtime.setPolicy({ captureFuture: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(requests, 0);
    await runtime.dispose();
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("memory redaction covers JSON secrets and incomplete private keys before truncation", () => {
  const json = '{"api_key":"fixture-sensitive-value"}';
  assert.doesNotMatch(redactSecrets(json), /fixture-sensitive-value/u);
  const incomplete = `-----BEGIN PRIVATE KEY-----\n${"Q".repeat(3_000)}`;
  assert.doesNotMatch(redactSecrets(incomplete), /BEGIN PRIVATE KEY/u);
});

test("Chinese retrieval and full timestamp metadata survive round trips", async () => {
  const directory = await temporaryDirectory();
  try {
    const store = new LearnedMemoryStore({ directory, now: () => new Date("2026-09-20T12:34:56.789Z") });
    await store.append("project", "C:\\repo", [{ lesson: "中文项目使用 pnpm 执行测试", applyWhen: "修改代码后运行测试" }]);
    assert.match(await store.prompt("C:\\repo", "请检查项目测试"), /pnpm/u);
    const [entry] = await store.read("project", "C:\\repo");
    assert.equal(entry?.createdAt, "2026-09-20T12:34:56.789Z");
    assert.equal(entry?.updatedAt, "2026-09-20T12:34:56.789Z");
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("explicit remember writes a user preference and can be disabled", async () => {
  const directory = await temporaryDirectory();
  try {
    const store = new LearnedMemoryStore({ directory });
    const runtime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      client: { responses: { async create() {
        return {
          id: "learned",
          output_text: JSON.stringify({ entries: [{ scope: "user", lesson: "Prefer concise answers", applyWhen: "For future responses" }] }),
          output: [],
        };
      } } },
    });
    await runtime.remember("C:\\repo", "Remember that I prefer concise answers");
    assert.equal((await store.read("user", "C:\\repo")).length, 1);
    await runtime.setEnabled(false);
    assert.equal((await runtime.status("C:\\repo")).enabled, false);
    await runtime.clear("user", "C:\\repo");
    assert.equal((await store.read("user", "C:\\repo")).length, 0);
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("memory metadata remains compatible with legacy markdown and supports archive/delete", async () => {
  const directory = await temporaryDirectory();
  try {
    const store = new LearnedMemoryStore({ directory, now: () => new Date("2026-09-20T12:00:00.000Z") });
    await mkdir(path.dirname(store.filePath("project", "C:\\repo")), { recursive: true });
    await writeFile(store.filePath("project", "C:\\repo"), [
      "# Learned Experience",
      "",
      "### 2026-09-19 · Project",
      "- Lesson: Keep changes focused",
      "- Apply when: Editing this repository",
      "",
    ].join("\n"), "utf8");
    const legacy = (await store.read("project", "C:\\repo"))[0]!;
    assert.equal(legacy.kind, "convention");
    assert.equal(legacy.status, "active");
    await store.append("project", "C:\\repo", [{
      lesson: "Prefer the existing test style",
      applyWhen: "When adding tests",
      kind: "procedure",
      confidence: "high",
      sourceSessionId: "session-1",
      evidence: [{ sessionId: "session-1", createdAt: "2026-09-20T12:00:00.000Z", excerpt: "A short supporting excerpt" }],
    }]);
    const entries = await store.read("project", "C:\\repo");
    const added = entries.find((entry) => entry.lesson.includes("existing test"))!;
    assert.equal(added.kind, "procedure");
    assert.equal(added.confidence, "high");
    assert.equal(added.sourceSessionId, "session-1");
    assert.equal(added.evidence?.[0]?.excerpt, "A short supporting excerpt");
    await store.updateEntry("project", "C:\\repo", added.id, { status: "archived" });
    assert.equal((await store.read("project", "C:\\repo")).find((entry) => entry.id === added.id)!.status, "archived");
    await store.deleteEntry("project", "C:\\repo", added.id);
    assert.equal((await store.read("project", "C:\\repo")).some((entry) => entry.id === added.id), false);
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("memory retrieval prefers relevant active entries and respects chat policy", async () => {
  const directory = await temporaryDirectory();
  try {
    const store = new LearnedMemoryStore({ directory, now: () => new Date("2026-09-20T12:00:00.000Z") });
    await store.append("project", "C:\\repo", [
      { lesson: "Use the existing test style", applyWhen: "When adding tests" },
      { lesson: "Use the release checklist", applyWhen: "When preparing a release" },
    ]);
    const entries = await store.read("project", "C:\\repo");
    await store.updateEntry("project", "C:\\repo", entries[1]!.id, { status: "archived" });
    const prompt = await store.prompt("C:\\repo", "add a unit test", [], 2_000);
    assert.match(prompt, /existing test style/u);
    assert.doesNotMatch(prompt, /release checklist/u);

    const runtime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      policy: { readExisting: false, captureFuture: false },
      client: { responses: { async create() { throw new Error("capture should be disabled"); } } },
    });
    assert.equal(await runtime.loadPrompt("C:\\repo", "add a unit test"), "");
    runtime.scheduleCapture({ workspacePath: "C:\\repo", userInput: "fix tests", transcript: "", assistantText: "done", toolCallCount: 1 });
    assert.equal((await runtime.status("C:\\repo")).capture?.state, "skipped");
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("memory capture can wait for idle time before extracting", async () => {
  const directory = await temporaryDirectory();
  let requests: number = 0;
  try {
    const store = new LearnedMemoryStore({ directory });
    const runtime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      idleDelayMs: 25,
      unrefTimers: false,
      client: { responses: { async create() {
        requests += 1;
        return { id: "capture", output_text: JSON.stringify({ entries: [{ lesson: "Use bounded output", applyWhen: "When rendering command output" }] }), output: [] };
      } } },
    });
    await runtime.finishTurn({ workspacePath: "C:\\repo", userInput: "fix command output", transcript: "tool", assistantText: "done", toolCallCount: 1 }, "verified");
    assert.equal(requests, 0);
    await waitFor(async () => {
      const capture = (await runtime.status("C:\\repo")).capture;
      if (capture?.state === "failed" && capture.queued === 0) assert.fail(capture.error ?? "Memory capture failed");
      return capture?.state === "succeeded";
    });
    const finalStatus = await runtime.status("C:\\repo");
    await runtime.dispose();
    assert.ok(requests >= 1 && requests <= 3);
    assert.equal(finalStatus.capture?.state, "succeeded", finalStatus.capture?.error);
    assert.equal((await store.read("project", "C:\\repo")).length, 1);
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("persistent capture jobs preserve consecutive turns and resume after restart", async () => {
  const directory = await temporaryDirectory();
  const workspacePath = "C:\\repo";
  let requests = 0;
  try {
    const store = new LearnedMemoryStore({ directory });
    const queuedRuntime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      idleDelayMs: 40,
      unrefTimers: false,
      client: { responses: { async create() { throw new Error("queued runtime should be disposed before capture"); } } },
    });
    await queuedRuntime.finishTurn({ workspacePath, sessionId: "session-1", userInput: "Fix alpha behavior", transcript: "verified local tool result alpha", assistantText: "done", toolCallCount: 1 }, "verified");
    await queuedRuntime.finishTurn({ workspacePath, sessionId: "session-1", userInput: "Fix beta behavior", transcript: "verified local tool result beta", assistantText: "done", toolCallCount: 1 }, "verified");
    assert.equal((await queuedRuntime.status(workspacePath)).capture?.queued, 2);
    await queuedRuntime.dispose();

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const resumedRuntime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      idleDelayMs: 0,
      unrefTimers: false,
      client: { responses: { async create(params) {
        requests += 1;
        const input = String(params.input);
        const label = input.includes("alpha") ? "alpha" : "beta";
        return {
          id: `capture-${label}`,
          output_text: JSON.stringify({ entries: [{ lesson: `Keep ${label} behavior verified`, applyWhen: `When changing ${label}` }] }),
          output: [],
        };
      } } },
    });
    await waitFor(async () => (await store.read("project", workspacePath)).length === 2);
    assert.equal(requests, 2);
    assert.deepEqual((await store.read("project", workspacePath)).map((entry) => entry.lesson).sort(), [
      "Keep alpha behavior verified",
      "Keep beta behavior verified",
    ]);
    assert.equal((await resumedRuntime.status(workspacePath)).capture?.queued, 0);
    await resumedRuntime.dispose();
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("unverified turns do not enter the persistent capture queue", async () => {
  const directory = await temporaryDirectory();
  try {
    const store = new LearnedMemoryStore({ directory });
    const runtime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      client: { responses: { async create() { throw new Error("unverified capture must not run"); } } },
    });
    await runtime.finishTurn({ workspacePath: "C:\\repo", userInput: "The task might be done", transcript: "assistant-only claim", assistantText: "done", toolCallCount: 1 }, "unverified");
    const status = await runtime.status("C:\\repo");
    assert.equal(status.capture?.state, "skipped");
    assert.equal(status.capture?.queued, 0);
    assert.equal((await store.read("project", "C:\\repo")).length, 0);
    await runtime.dispose();
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("conflicting extracted candidates remain pending review instead of becoming active memory", async () => {
  const directory = await temporaryDirectory();
  let requests = 0;
  try {
    const store = new LearnedMemoryStore({ directory });
    const runtime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      unrefTimers: false,
      client: { responses: { async create() {
        requests += 1;
        return { id: "capture", output_text: JSON.stringify({ entries: [
          { lesson: "Always run command A", applyWhen: "When validating changes" },
          { lesson: "Always run command B", applyWhen: "When validating changes" },
        ] }), output: [] };
      } } },
    });
    await runtime.finishTurn({ workspacePath: "C:\\repo", userInput: "Validate the change", transcript: "verified local results", assistantText: "done", toolCallCount: 1 }, "verified");
    await waitFor(async () => {
      const capture = (await runtime.status("C:\\repo")).capture;
      if (capture?.state === "failed" && capture.queued === 0) assert.fail(capture.error ?? "Memory capture failed");
      return capture?.state === "succeeded";
    });
    assert.equal(requests, 1);
    assert.equal((await store.read("project", "C:\\repo")).length, 0);
    const candidates = JSON.parse(await readFile(path.join(directory, "memory-candidates.json"), "utf8")) as Array<{ status?: string }>;
    assert.deepEqual(candidates.map((candidate) => candidate.status), ["review", "review"]);
    await runtime.dispose();
  } finally {
    await removeTemporaryDirectory(directory);
  }
});

test("candidate consolidation keeps project and user scopes separate", async () => {
  const directory = await temporaryDirectory();
  let requests = 0;
  try {
    const store = new LearnedMemoryStore({ directory });
    const runtime = new LearnedMemoryRuntime({
      store,
      model: "test-model",
      unrefTimers: false,
      client: { responses: { async create() {
        requests += 1;
        if (requests > 1) throw new Error("separate single-item scopes must not be consolidated together");
        return { id: "capture", output_text: JSON.stringify({ entries: [
          { scope: "project", lesson: "Keep repository checks focused", applyWhen: "When validating this project" },
          { scope: "user", kind: "preference", lesson: "Prefer concise answers", applyWhen: "For future responses" },
        ] }), output: [] };
      } } },
    });
    await runtime.finishTurn({ workspacePath: "C:\\repo", sessionId: "session-1", userInput: "Remember that I prefer concise answers while fixing this project", transcript: "verified local results", assistantText: "done", toolCallCount: 1 }, "verified");
    await waitFor(async () => (await runtime.status("C:\\repo")).capture?.state === "succeeded");
    assert.equal(requests, 1);
    assert.equal((await store.read("project", "C:\\repo")).length, 1);
    assert.equal((await store.read("user", "C:\\repo")).length, 1);
    await runtime.dispose();
  } finally {
    await removeTemporaryDirectory(directory);
  }
});
