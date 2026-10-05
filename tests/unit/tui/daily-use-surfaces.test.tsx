import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { ContextSurface } from "../../../src/tui/components/screens/context-surface.js";
import { WorkspaceDiffSurface } from "../../../src/tui/components/screens/workspace-diff-surface.js";
import type { ContextInspectionSnapshot } from "../../../src/agent/context-inspection.js";
import type { WorkspaceChangeIndex } from "../../../src/tools/workspace-review.js";
import { TaskProgressSurface } from "../../../src/tui/components/screens/task-progress-surface.js";
import { PlanQuestionsSurface } from "../../../src/tui/components/screens/plan-surface.js";

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
      runtimeIdentity: { agent: "Everpeace", protocol: "Responses", source: "host", workspacePath: "C:\\repo" },
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
    assert.match(view.lastFrame() ?? "", /Runtime agent: Everpeace/u);
    assert.match(view.lastFrame() ?? "", /Identity source: host/u);
    assert.match(view.lastFrame() ?? "", /Workspace \(cwd\): C:\\repo/u);
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

test("task progress surface shows the full checklist and host result separately", async () => {
  const view = render(<TaskProgressSurface
    progress={{
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "in_progress" },
        { step: "Verify", status: "pending" },
      ],
      updated_at: "2026-10-01T00:00:00.000Z",
    }}
    workflow={{
      task_id: "task-1",
      phase: "done",
      repair_attempts: 0,
      max_repair_attempts: 3,
      changed_paths: [],
      checkpoint_available: false,
      result: "unverified",
      result_reason: "No checks were discovered",
      updated_at: "2026-10-01T00:00:00.000Z",
    }}
    onBack={() => {}}
  />);
  try {
    await waitFor(() => (view.lastFrame() ?? "").includes("Implement"));
    assert.match(view.lastFrame() ?? "", /Last task result: unverified · No checks were discovered/u);
    assert.match(view.lastFrame() ?? "", /✓ Inspect/u);
    assert.match(view.lastFrame() ?? "", /● Implement/u);
    assert.match(view.lastFrame() ?? "", /○ Verify/u);
    assert.match(view.lastFrame() ?? "", /verification determines completion/u);
  } finally {
    view.unmount();
  }
});

test("question surface labels coding cancellation separately from Plan cancellation", async () => {
  const request = { questions: [{
    id: "path",
    header: "Path",
    question: "Which path?",
    options: [{ label: "Safe", description: "Use safe" }, { label: "Fast", description: "Use fast" }],
  }] };
  let cancelled = 0;
  const coding = render(<PlanQuestionsSurface request={request} mode="default" onComplete={() => {}} onCancel={() => { cancelled += 1; }} />);
  try {
    await waitFor(() => (coding.lastFrame() ?? "").includes("/question · Path"));
    assert.match(coding.lastFrame() ?? "", /Esc to cancel the active task/u);
    coding.stdin.write("\u001b");
    await waitFor(() => cancelled === 1);
  } finally {
    coding.unmount();
  }
  const planning = render(<PlanQuestionsSurface request={request} mode="plan" onComplete={() => {}} onCancel={() => {}} />);
  try {
    await waitFor(() => (planning.lastFrame() ?? "").includes("/plan · Path"));
    assert.match(planning.lastFrame() ?? "", /Esc to cancel planning/u);
  } finally {
    planning.unmount();
  }
});
