import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  defaultSessionDirectory,
  SessionStore,
  type SessionModelRef,
} from "../../../src/storage/session-store.js";

const model: SessionModelRef = {
  id: "model-1",
  model_name: "deepseek-chat",
  base_url: "https://api.deepseek.com",
};

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

    assert.equal(
      (await fixture.store.load("legacy-session")).summary.title_pending,
      false,
    );
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
