import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { SessionPicker } from "../../../src/tui/components/navigation/session-picker.js";
import { SessionStore, type SessionSearchResult, type SessionSummary } from "../../../src/storage/session-store.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail("Timed out waiting for session picker update");
}

const summary: SessionSummary = {
  id: "session-1",
  title: "Other workspace result",
  title_pending: false,
  created_at: "2026-10-01T00:00:00.000Z",
  updated_at: "2026-10-01T00:00:01.000Z",
  workspace_path: "C:\\other",
  model: { id: "model", model_name: "deepseek-chat", base_url: "https://api.deepseek.com" },
};

test("session picker toggles to all workspaces, shows local preview, and resumes with Enter", async () => {
  const empty: SessionSearchResult = { matches: [], total: 0, skipped: 0 };
  const scopes: boolean[] = [];
  let selected: SessionSummary | undefined;
  const view = render(<SessionPicker
    initialResult={empty}
    search={async (_query, allWorkspaces) => {
      scopes.push(allWorkspaces);
      return allWorkspaces ? {
        matches: [{ summary, match: { kind: "user", snippet: "matching request" }, preview: [{ kind: "assistant", snippet: "local answer" }] }],
        total: 1,
        skipped: 0,
      } : empty;
    }}
    onSelect={(value) => { selected = value; }}
    onDelete={async () => {}}
    onCancel={() => {}}
  />);
  try {
    await tick();
    view.stdin.write("\t");
    await waitFor(() => (view.lastFrame() ?? "").includes("local answer"));
    assert.match(view.lastFrame() ?? "", /Scope: All workspaces/u);
    assert.match(view.lastFrame() ?? "", /local answer/u);
    assert.ok(scopes.includes(true));
    view.stdin.write("\r");
    await waitFor(() => selected?.id === summary.id);
    assert.equal(selected?.id, summary.id);
  } finally {
    view.unmount();
  }
});

test("session picker searches persisted titles after a selection callback changes its own snapshot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-picker-snapshot-"));
  const store = new SessionStore({ directory });
  let unmount: (() => void) | undefined;
  try {
    const session = await store.create({ title: "Persisted picker title", titlePending: false, workspacePath: directory, model: summary.model });
    const initialResult = await store.search({ query: "", workspacePath: directory });
    const queried: string[] = [];
    const selected: string[] = [];
    const view = render(<SessionPicker
      initialResult={initialResult}
      search={async (query, allWorkspaces, offset, signal) => {
        const result = await store.search({ query, ...(allWorkspaces ? {} : { workspacePath: directory }), offset, ...(signal ? { signal } : {}) });
        queried.push(query);
        return result;
      }}
      onSelect={(value) => {
        selected.push(value.title);
        if (selected.length === 1) value.title = "Caller-only title";
      }}
      onDelete={(ids) => store.deleteMany(ids)}
      onCancel={() => {}}
    />);
    unmount = () => view.unmount();
    await tick();
    view.stdin.write("\r");
    await waitFor(() => selected.length === 1);
    view.stdin.write("persisted");
    await waitFor(() => queried.includes("persisted") && (view.lastFrame() ?? "").includes("Persisted picker title"));
    assert.doesNotMatch(view.lastFrame() ?? "", /Caller-only title/u);
    view.stdin.write("\r");
    await waitFor(() => selected.length === 2);
    assert.deepEqual(selected, ["Persisted picker title", "Persisted picker title"]);
    assert.equal((await store.load(session.id)).summary.title, "Persisted picker title");
  } finally {
    unmount?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
