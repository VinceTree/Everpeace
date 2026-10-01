import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { SessionPicker } from "../../../src/tui/components/navigation/session-picker.js";
import type { SessionSearchResult, SessionSummary } from "../../../src/storage/session-store.js";

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
