import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { PlanReviewSurface } from "../../../src/tui/components/screens/plan-surface.js";
import type { PlanReviewResult } from "../../../src/plan/runtime.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const submitted = { title: "Offline plan", plan: "Read the source and add regression coverage." };

test("review accepts only nonempty feedback and Escape returns to the review menu", async () => {
  const results: PlanReviewResult[] = [];
  const view = render(<PlanReviewSurface submitted={submitted} onDecision={(result) => results.push(result)} onCancelTask={() => assert.fail("unexpected cancellation")} />);
  try {
    await tick();
    assert.match(view.lastFrame() ?? "", /Approve plan/u);
    view.stdin.write("\u001b[B");
    await tick();
    view.stdin.write("\r");
    await tick();
    assert.match(view.lastFrame() ?? "", /Describe the changes/u);
    view.stdin.write(" \r");
    await tick();
    assert.deepEqual(results, []);
    view.stdin.write("\u001b");
    await tick();
    assert.match(view.lastFrame() ?? "", /Revise plan/u);
    assert.deepEqual(results, []);
    view.stdin.write("\u001b[B");
    await tick();
    view.stdin.write("\r");
    await tick();
    view.stdin.write("Include cancellation tests");
    await tick();
    Object.defineProperty(view.stdout, "columns", { configurable: true, value: 48 });
    view.stdout.emit("resize");
    await tick();
    view.stdin.write("\r");
    await tick();
    assert.deepEqual(results, [{ decision: "continue", feedback: "Include cancellation tests" }]);
  } finally { view.unmount(); }
});

test("review Escape cancels planning and Ctrl+C cancels the task in both surfaces", async (context) => {
  for (const revising of [false, true]) await context.test(revising ? "revision input" : "review menu", async () => {
    let cancelled = 0;
    const decisions: PlanReviewResult[] = [];
    const view = render(<PlanReviewSurface submitted={submitted} onDecision={(result) => decisions.push(result)} onCancelTask={() => { cancelled++; }} />);
    try {
      await tick();
      if (revising) {
        view.stdin.write("\u001b[B");
        await tick();
        view.stdin.write("\r");
        await tick();
      }
      view.stdin.write("\u0003");
      await tick();
      assert.equal(cancelled, 1);
      assert.deepEqual(decisions, []);
      if (!revising) {
        view.stdin.write("\u001b");
        await tick();
        assert.deepEqual(decisions, ["cancel"]);
      }
    } finally { view.unmount(); }
  });
});
