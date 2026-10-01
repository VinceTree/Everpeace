import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { ContextSurface } from "../../../src/tui/components/screens/context-surface.js";
import { WorkspaceDiffSurface } from "../../../src/tui/components/screens/workspace-diff-surface.js";
import type { ContextInspectionSnapshot } from "../../../src/agent/context-inspection.js";
import type { WorkspaceChangeIndex } from "../../../src/tools/workspace-review.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 35));

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail("Timed out waiting for daily-use surface update");
}

test("workspace diff surface opens detail and Esc returns through list to chat", async () => {
  const index: WorkspaceChangeIndex = {
    workspacePath: "C:\\repo",
    repositoryRoot: "C:\\repo",
    capturedAt: "2026-10-01T00:00:00.000Z",
    entries: [{ id: "unstaged:file.ts:", path: "file.ts", kind: "unstaged", status: "M" }],
  };
  let backs = 0;
  const view = render(<WorkspaceDiffSurface
    initialIndex={index}
    readDetail={async (entry) => ({ entry, contentKind: "diff", text: "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new", truncated: false })}
    refresh={async () => index}
    onBack={() => { backs += 1; }}
  />);
  try {
    await waitFor(() => /unstaged\s+M file\.ts/u.test(view.lastFrame() ?? ""));
    assert.match(view.lastFrame() ?? "", /Last task result: unavailable/u);
    assert.match(view.lastFrame() ?? "", /unstaged\s+M file\.ts/u);
    view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("UNSTAGED · file.ts"));
    assert.match(view.lastFrame() ?? "", /UNSTAGED · file\.ts/u);
    assert.match(view.lastFrame() ?? "", /new/u);
    view.stdin.write("\u001b");
    await waitFor(() => /unstaged\s+M file\.ts/u.test(view.lastFrame() ?? ""));
    assert.match(view.lastFrame() ?? "", /unstaged\s+M file\.ts/u);
    assert.equal(backs, 0);
    view.stdin.write("\u001b");
    await waitFor(() => backs === 1);
    assert.equal(backs, 1);
  } finally {
    view.unmount();
  }
});

test("context surface has an explicit empty state and refreshes the latest in-memory snapshot", async () => {
  let snapshot: ContextInspectionSnapshot | undefined;
  const view = render(<ContextSurface getSnapshot={() => snapshot} onBack={() => {}} />);
  try {
    await waitFor(() => (view.lastFrame() ?? "").includes("No coding request has been submitted"));
    assert.match(view.lastFrame() ?? "", /No coding request has been submitted/u);
    snapshot = {
      model: "deepseek-chat",
      provider: "deepseek",
      submittedAt: "2026-10-01T00:00:00.000Z",
      contextRevision: 4,
      requestFingerprint: "a".repeat(64),
      estimatedInputTokens: 123,
      estimateSource: "utf8_bytes_div_4",
      outputReserveTokens: 456,
      componentBytes: { stableInstructions: 10, dynamicInstructions: 20 },
      projectRules: [],
      projectRuleDiagnostics: [],
      skills: { advertised: [], explicitlyIncluded: [] },
      memory: { entryIds: [] },
      mcp: { servers: [], tools: [] },
      advertisedTools: ["read_file"],
      itemCounts: { user_messages: 1 },
      opaqueItemBytes: {},
      attachments: [],
      previews: [],
    };
    view.stdin.write("r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Model: deepseek-chat"));
    assert.match(view.lastFrame() ?? "", /Model: deepseek-chat/u);
    assert.match(view.lastFrame() ?? "", /Estimated input: 123 tokens/u);
  } finally {
    view.unmount();
  }
});

test("context surface distinguishes integrations without inspection support", async () => {
  const view = render(<ContextSurface onBack={() => {}} />);
  try {
    await waitFor(() => (view.lastFrame() ?? "").includes("unavailable for the active agent integration"));
    assert.match(view.lastFrame() ?? "", /unavailable for the active agent integration/u);
  } finally {
    view.unmount();
  }
});
