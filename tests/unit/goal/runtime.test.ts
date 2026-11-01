import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime, parseGoalCommand } from "../../../src/goal/runtime.js";
import { SessionStore, type SessionGoal } from "../../../src/storage/session-store.js";

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
  await runtime.beginTurn();
  await assert.rejects(() => runtime.update("blocked", "Test service unavailable"), /three consecutive/);
  await runtime.beginTurn();
  await assert.rejects(() => runtime.update("blocked", "Test service unavailable"), /three consecutive/);
  await runtime.beginTurn();
  const blocked = await runtime.update("blocked", "Test service unavailable");
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
  await runtime.beginTurn();
  await assert.rejects(() => runtime.update("blocked", "Missing external service"), /three consecutive/);
  const rebuilt = new GoalRuntime({
    getGoal: async () => get(),
    setGoal: async (next) => { Object.assign(get()!, next); },
  });
  await rebuilt.beginTurn();
  await assert.rejects(() => rebuilt.update("blocked", "Missing external service"), /three consecutive/);
  await rebuilt.beginTurn();
  const blocked = await rebuilt.update("blocked", "Missing external service");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_streak, 3);
});

test("later reliable usage and a rebuilt runtime cannot clear a Goal accounting gap", async () => {
  const { runtime, get } = fixture();
  await runtime.create({ objective: "Long task without a numeric budget" });
  await runtime.recordUsage({ tokensUsed: 3, usageComplete: false, timeUsedSeconds: 1 });
  const rebuilt = new GoalRuntime({ async getGoal() { return get(); }, async setGoal(next) { Object.assign(get()!, next); } });
  const settled = await rebuilt.recordUsage({ tokensUsed: 6, usageComplete: true, timeUsedSeconds: 2 });
  assert.equal(settled?.tokens_used, 6);
  assert.equal(settled?.usage_complete, false);
  assert.equal(settled?.status, "active");
});

test("different blockers and an intervening turn without a report restart the streak", async () => {
  const { runtime, get } = fixture();
  await runtime.create({ objective: "Finish the task" });
  await runtime.beginTurn();
  await assert.rejects(runtime.update("blocked", "Service unavailable"), /three consecutive/);
  await assert.rejects(runtime.update("blocked", "Service unavailable"), /already been reported/);
  assert.equal(get()?.blocked_streak, 1);
  await runtime.beginTurn();
  await assert.rejects(runtime.update("blocked", "User must supply a fixture"), /three consecutive/);
  assert.equal(get()?.blocked_streak, 1);
  await runtime.beginTurn(); // This turn makes progress without reporting a blocker.
  await runtime.beginTurn();
  await assert.rejects(runtime.update("blocked", "User must supply a fixture"), /three consecutive/);
  assert.equal(get()?.blocked_streak, 1);
  assert.equal(JSON.stringify(get()).includes("User must supply a fixture"), false);
});

test("legacy streaks and calls outside a host turn are insufficient blocker evidence", async () => {
  const { runtime, get } = fixture();
  await runtime.create({ objective: "Restore old task" });
  get()!.blocked_streak = 2;
  await assert.rejects(runtime.update("blocked", "Missing service"), /host coding turn/);
  await runtime.beginTurn();
  await assert.rejects(runtime.update("blocked", "Missing service"), /three consecutive/);
  assert.equal(get()?.blocked_streak, 1);
  await runtime.beginTurn();
  await assert.rejects(runtime.update("blocked"), /stable description/);
});

test("stopped states cannot be overwritten by model status updates", async () => {
  for (const status of ["paused", "blocked", "complete", "budget_limited", "usage_limited"] as const) {
    const { runtime, get } = fixture();
    await runtime.create({ objective: "Preserve stop reason" });
    get()!.status = status;
    await assert.rejects(runtime.update("complete"), /Only an active goal/);
    await assert.rejects(runtime.update("paused"), /Only an active goal/);
    await assert.rejects(runtime.update("blocked", "Missing service"), /Only an active goal/);
    assert.equal(get()?.status, status);
  }
});

test("pre-cancelled host turns cannot read or write Goal state", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  const runtime = new GoalRuntime({ async getGoal() { throw new Error("Unexpected read"); }, async setGoal() { throw new Error("Unexpected write"); } });
  await assert.rejects(runtime.beginTurn(controller.signal), (error) => error === controller.signal.reason);
});

test("JSONL reopen preserves actual consecutive blocker turns and resume starts a fresh audit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-goal-turns-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = new SessionStore({ directory });
  const session = await initial.create({ workspacePath: directory, title: "Goal turns", titlePending: false,
    model: { id: "offline", model_name: "offline-goal", base_url: "https://example.invalid" } });
  const reopen = () => {
    const store = new SessionStore({ directory });
    return new GoalRuntime({ async getGoal() { return (await store.load(session.id)).goal; }, async setGoal(goal) { await store.setGoal(session.id, goal); } });
  };
  await reopen().create({ objective: "Finish every requested behavior" });
  for (let turn = 1; turn <= 3; turn++) {
    const runtime = reopen();
    await runtime.beginTurn();
    if (turn < 3) await assert.rejects(runtime.update("blocked", "User-owned service is offline"), /three consecutive/);
    else await runtime.update("blocked", "User-owned service is offline");
    const stored = await reopen().get();
    assert.equal(stored?.blocked_streak, turn);
    assert.equal(stored?.status, turn === 3 ? "blocked" : "active");
    assert.equal(stored?.goal_turn_id, stored?.blocked_turn_id);
  }
  const resumed = reopen();
  await resumed.resume();
  await resumed.beginTurn();
  await assert.rejects(resumed.update("blocked", "User-owned service is offline"), /three consecutive/);
  assert.equal((await reopen().get())?.blocked_streak, 1);
  const raw = await readFile(join(directory, session.id + ".jsonl"), "utf8");
  assert.equal(raw.includes("User-owned service is offline"), false);
});
