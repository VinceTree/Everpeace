import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { PlanReviewSurface } from "../../../src/tui/components/screens/plan-surface.js";
import { CommandScreen } from "../../../src/tui/components/screens/command-surface.js";
import type { PlanReviewResult } from "../../../src/plan/runtime.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const submitted = { title: "Offline plan", plan: "Read the source and add regression coverage." };

async function waitFor(view: ReturnType<typeof render>, check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for Plan review update:\n${view.lastFrame()}`);
}

async function enterRevision(view: ReturnType<typeof render>): Promise<void> {
  view.stdin.write("\u001b[B");
  await waitFor(view, () => /[›❯>]\s+Revise plan/u.test(view.lastFrame() ?? ""));
  view.stdin.write("\r");
  await waitFor(view, () => (view.lastFrame() ?? "").includes("Describe the changes"));
  await tick();
}

test("review accepts only nonempty feedback and Escape returns to the review menu", async () => {
  const results: PlanReviewResult[] = [];
  const view = render(<CommandScreen><PlanReviewSurface submitted={submitted} onDecision={(result) => results.push(result)} onCancelTask={() => assert.fail("unexpected cancellation")} /></CommandScreen>);
  try {
    await tick();
    assert.match(view.lastFrame() ?? "", /Approve plan/u);
    await enterRevision(view);
    assert.match(view.lastFrame() ?? "", /Describe the changes/u);
    view.stdin.write(" ");
    await tick();
    view.stdin.write("\r");
    await tick();
    assert.deepEqual(results, []);
    view.stdin.write("\u001b");
    await waitFor(view, () => (view.lastFrame() ?? "").includes("Revise plan") && !(view.lastFrame() ?? "").includes("Describe the changes"));
    await tick();
    assert.match(view.lastFrame() ?? "", /Revise plan/u);
    assert.deepEqual(results, []);
    await enterRevision(view);
    view.stdin.write("Include cancellation tests");
    await waitFor(view, () => (view.lastFrame() ?? "").includes("Include cancellation tests"));
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 48 });
    view.stdout.emit("resize");
    await waitFor(view, () => (view.lastFrame() ?? "").split("\n").some((line) => line.trimStart().startsWith("╭") && line.trim().length === 46));
    assert.match(view.lastFrame() ?? "", /Include cancellation tests/u);
    view.stdin.write("\r");
    await waitFor(view, () => results.length === 1);
    assert.deepEqual(results, [{ decision: "continue", feedback: "Include cancellation tests" }]);
  } finally { view.unmount(); }
});

test("review Escape cancels planning and Ctrl+C cancels the task in both surfaces", async (context) => {
  for (const revising of [false, true]) await context.test(revising ? "revision input" : "review menu", async () => {
    let cancelled = 0;
    const decisions: PlanReviewResult[] = [];
    const view = render(<CommandScreen><PlanReviewSurface submitted={submitted} onDecision={(result) => decisions.push(result)} onCancelTask={() => { cancelled++; }} /></CommandScreen>);
    try {
      await tick();
      if (revising) {
        await enterRevision(view);
      }
      view.stdin.write("\u0003");
      await waitFor(view, () => cancelled === 1);
      assert.equal(cancelled, 1);
      assert.deepEqual(decisions, []);
      if (!revising) {
        view.stdin.write("\u001b");
        await waitFor(view, () => decisions.length === 1);
        assert.deepEqual(decisions, ["cancel"]);
      }
    } finally { view.unmount(); }
  });
});
