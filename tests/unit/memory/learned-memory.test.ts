import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LearnedMemoryRuntime,
  LearnedMemoryStore,
  defaultMemoryDirectory,
  projectMemoryKey,
} from "../../../src/memory/learned-memory.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "everpeace-memory-"));
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
    assert.equal(entries[0]!.createdAt, "2026-09-20T00:00:00.000Z");

    await store.append("project", "C:\\repo", Array.from({ length: 105 }, (_, index) => ({
      lesson: `Lesson ${index}`,
      applyWhen: "When testing",
    })));
    assert.equal((await store.read("project", "C:\\repo")).length, 100);
    const markdown = await readFile(store.filePath("project", "C:\\repo"), "utf8");
    assert.doesNotMatch(markdown, /secret-value/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
    const prompt = await runtime.loadPrompt("C:\\repo");
    assert.match(prompt, /Validate inputs first/u);
    assert.match(prompt, /untrusted background data/u);
    assert.ok(requests[0]);
    assert.doesNotMatch(String(requests[0]!.input), /secret-value/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
    await rm(directory, { recursive: true, force: true });
  }
});
