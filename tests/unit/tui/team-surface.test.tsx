import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { TeamSurface } from "../../../src/tui/components/screens/team-surface.js";
import type { TeamOptions, TeamSnapshot } from "../../../src/team/types.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 35));

test("team screen enables collaboration only when idle and Esc returns to the same host", async () => {
  let config: TeamOptions = { enabled: false }; let returned = 0;
  const view = render(<TeamSurface config={config} models={[]} getSnapshot={() => undefined} busy={false} onConfigure={async (value) => { config = value; }} onAction={async () => {}} onBack={() => { returned++; }} />);
  try { await tick(); assert.match(view.lastFrame() ?? "", /Collaboration: off/); view.stdin.write("\r"); await tick(); assert.equal(config.enabled, true); view.stdin.write("\u001b"); await tick(); assert.equal(returned, 1); }
  finally { view.cleanup(); }
  let changed = false;
  const active = render(<TeamSurface config={{ enabled: true }} models={[]} getSnapshot={() => undefined} busy onConfigure={async () => { changed = true; }} onAction={async () => {}} onBack={() => {}} />);
  try { await tick(); active.stdin.write("\r"); await tick(); assert.equal(changed, false); assert.match(active.lastFrame() ?? "", /idle/); }
  finally { active.cleanup(); }
});

test("team member details page reports and show scoped tokens without rendering all member transcripts", async () => {
  const snapshot: TeamSnapshot = { version: 1, teamId: "fixture-team", rootSessionId: "root", workspacePath: "/fixture", options: {}, mode: "default", state: "stopped", openRequests: 0, elapsedMs: 0, startedAt: 0, usage: { attempts: [{ id: 1, purpose: "coding", status: "completed", usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 }, agentId: "member", modelId: "registered" }], inputTokens: 4, outputTokens: 6, reasoningTokens: 0, complete: true }, members: [{ agentId: "member", taskId: "task", modelId: "registered", task: { role: "reviewer", goal: "Inspect", acceptance: "Evidence", paths: ["."], dependencies: [] }, state: "completed", summary: Array.from({ length: 100 }, (_, index) => `Report ${index}`).join("\n") }] };
  let back = 0;
  const view = render(<TeamSurface config={{ enabled: true }} models={[]} getSnapshot={() => snapshot} busy={false} onConfigure={async () => {}} onAction={async () => {}} onBack={() => { back++; }} />);
  try {
    await tick(); for (let index = 0; index < 9; index++) { view.stdin.write("\u001b[B"); await tick(); }
    view.stdin.write("\r"); await tick(); assert.match(view.lastFrame() ?? "", /Known consumption: 10/); assert.doesNotMatch(view.lastFrame() ?? "", /Report 99/);
    view.stdin.write("\u001b[6~"); await tick(); assert.match(view.lastFrame() ?? "", /Report/);
    view.stdin.write("\u001b"); await tick(); assert.equal(back, 0); view.stdin.write("\u001b"); await tick(); assert.equal(back, 1);
  } finally { view.cleanup(); }
});
