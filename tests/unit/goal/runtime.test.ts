import assert from "node:assert/strict";
import { test } from "node:test";
import { GoalRuntime, parseGoalCommand } from "../../../src/goal/runtime.js";
import type { SessionGoal } from "../../../src/storage/session-store.js";

function fixture() {
  let goal: SessionGoal | undefined;
  let second = 0;
  const runtime = new GoalRuntime({
    getGoal: async () => goal,
    setGoal: async (next) => { goal = next; },
  }, () => new Date(`2026-09-20T00:00:${String(second++).padStart(2, "0")}.000Z`), () => "00000000-0000-4000-8000-000000000001");
  return { runtime, get: () => goal };
}

test("goal parser supports create, status, pause, resume, and token budget", () => {
  assert.deepEqual(parseGoalCommand("status"), { action: "status" });
  assert.deepEqual(parseGoalCommand("finish the migration --tokens 1200"), { action: "create", objective: "finish the migration", tokenBudget: 1200 });
  assert.deepEqual(parseGoalCommand("pause"), { action: "pause" });
});

test("goal runtime persists lifecycle and enforces recurring blocker threshold", async () => {
  const { runtime, get } = fixture();
  const created = await runtime.create({ objective: "Ship the feature", tokenBudget: 100 });
  assert.equal(created.status, "active");
  await assert.rejects(() => runtime.update("blocked"), /three consecutive/);
  await assert.rejects(() => runtime.update("blocked"), /three consecutive/);
  const blocked = await runtime.update("blocked");
  assert.equal(blocked.status, "blocked");
  const resumed = await runtime.resume();
  assert.equal(resumed.status, "active");
  const limited = await runtime.recordUsage({ tokensUsed: 100, usageComplete: true, timeUsedSeconds: 12 });
  assert.equal(limited?.status, "budget_limited");
  assert.equal(get()?.tokens_used, 100);
});

test("blocked streak survives rebuilding the runtime", async () => {
  const { runtime, get } = fixture();
  await runtime.create({ objective: "Ship it" });
  await assert.rejects(() => runtime.update("blocked"), /three consecutive/);
  const rebuilt = new GoalRuntime({
    getGoal: async () => get(),
    setGoal: async (next) => { Object.assign(get()!, next); },
  });
  await assert.rejects(() => rebuilt.update("blocked"), /three consecutive/);
  const blocked = await rebuilt.update("blocked");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_streak, 3);
});
