import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { GoalStatusSurface } from "../../../src/tui/components/screens/goal-surface.js";

test("Goal separates request admission from known consumption and incomplete metering", () => {
  const goal = { goal_id: "fixture", objective: "fixture", status: "active" as const, created_at: "2000-01-01T00:00:00Z", updated_at: "2000-01-01T00:00:00Z", token_budget: 100, tokens_used: 150, usage_complete: false, time_used_seconds: 1, blocked_streak: 0 };
  const view = render(<GoalStatusSurface goal={goal} inFlightRequests={1} onResume={() => {}} onPause={() => {}} onBack={() => {}} />);
  try { const text = view.lastFrame()!; assert.match(text, /Request token budget: 100/u); assert.match(text, /not a spending cap/u); assert.match(text, /Known consumption: 150 tokens/u); assert.match(text, /Metering: incomplete/u); assert.match(text, /In-flight requests: 1/u); }
  finally { view.cleanup(); }
});
