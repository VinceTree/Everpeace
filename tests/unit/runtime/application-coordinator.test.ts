import assert from "node:assert/strict";
import { test } from "node:test";
import { ApplicationCoordinator } from "../../../src/runtime/application-coordinator.js";
import type { AgentMode } from "../../../src/plan/runtime.js";

const submitted = { title: "Full approved plan", plan: "Inspect files\n\nImplement changes\nVerify END_OF_PLAN" };

function fixture() {
  const agent = { id: "original" };
  const coordinator = new ApplicationCoordinator<typeof agent>();
  coordinator.setAgent(agent);
  coordinator.attachSession("session-1");
  return { agent, coordinator };
}

function start(coordinator: ApplicationCoordinator<{ id: string }>, agent: { id: string }, mode: AgentMode = "default") {
  const admission = coordinator.beginTask(agent, mode);
  assert.equal(admission.status, "started");
  assert.ok(admission.status === "started");
  return admission.task;
}

function approve(coordinator: ApplicationCoordinator<{ id: string }>, agent: { id: string }) {
  coordinator.setMode("plan");
  const task = start(coordinator, agent, "plan");
  assert.equal(coordinator.approvePlan(task, submitted), true);
  assert.equal(coordinator.finishTask(task), true);
}

test("cancellation retains admission until runner cleanup is finished", () => {
  const { agent, coordinator } = fixture();
  const task = start(coordinator, agent);
  const reason = new Error("cancelled by user");
  coordinator.cancelTask(reason);
  assert.equal(task.signal.reason, reason);
  assert.equal(coordinator.activeTask, task);
  assert.equal(coordinator.beginTask(agent, "default").status, "busy");
  assert.equal(coordinator.finishTask(task), true);
  const next = start(coordinator, agent);
  assert.equal(coordinator.finishTask(task), false);
  assert.equal(coordinator.activeTask, next);
  assert.equal(next.signal.aborted, false);
});

test("approval waits in Plan mode and explicit execution consumes the exact body once", () => {
  const { agent, coordinator } = fixture();
  approve(coordinator, agent);
  assert.equal(coordinator.mode, "plan");
  assert.equal(coordinator.activeTask, undefined);
  const visible = coordinator.approvedPlan();
  assert.deepEqual(visible, submitted);
  assert.ok(visible);
  visible.plan = "caller mutation";
  const execution = coordinator.beginTask(agent, "plan", true);
  assert.ok(execution.status === "started");
  assert.deepEqual(execution.approvedPlan, submitted);
  assert.equal(execution.task.mode, "default");
  assert.equal(coordinator.mode, "default");
  assert.equal(coordinator.approvedPlan(), undefined);
  assert.equal(coordinator.beginTask(agent, "default", true).status, "busy");
  coordinator.cancelTask();
  coordinator.finishTask(execution.task);
  assert.equal(coordinator.beginTask(agent, "default", true).status, "no_approved_plan");
});

test("discussion and leaving Plan mode invalidate a prior approval", () => {
  const { agent, coordinator } = fixture();
  approve(coordinator, agent);
  const discussion = start(coordinator, agent, "plan");
  assert.equal(coordinator.approvedPlan(), undefined);
  coordinator.finishTask(discussion);
  approve(coordinator, agent);
  coordinator.setMode("default");
  assert.equal(coordinator.approvedPlan(), undefined);
  assert.equal(coordinator.beginTask(agent, "default", true).status, "no_approved_plan");
});

test("cancelled, completed and duplicate plan callbacks cannot publish approval", () => {
  const { agent, coordinator } = fixture();
  const cancelled = start(coordinator, agent, "plan");
  coordinator.cancelTask();
  assert.equal(coordinator.approvePlan(cancelled, submitted), false);
  coordinator.finishTask(cancelled);
  const planning = start(coordinator, agent, "plan");
  assert.equal(coordinator.approvePlan(planning, submitted), true);
  coordinator.setMode("default");
  assert.equal(coordinator.approvePlan(planning, submitted), false);
  coordinator.finishTask(planning);
  assert.equal(coordinator.approvePlan(planning, submitted), false);
  assert.equal(coordinator.approvedPlan(), undefined);
});

test("session replacement invalidates approval even when restoring the same ID", () => {
  const { agent, coordinator } = fixture();
  for (const sessionId of ["session-2", "session-2", undefined]) {
    approve(coordinator, agent);
    coordinator.replaceSession(sessionId);
    assert.equal(coordinator.mode, "default");
    assert.equal(coordinator.approvedPlan(), undefined);
    if (!sessionId) coordinator.attachSession("session-3");
  }
});

test("session replacement cancels the old task and rejects its late approval", () => {
  const { agent, coordinator } = fixture();
  const task = start(coordinator, agent, "plan");
  coordinator.replaceSession("session-2");
  assert.equal(task.signal.aborted, true);
  assert.equal(coordinator.matchesTaskContext(task), false);
  assert.equal(coordinator.approvePlan(task, submitted), false);
  assert.equal(coordinator.beginTask(agent, "default").status, "busy");
  coordinator.finishTask(task);
  assert.equal(coordinator.sessionId, "session-2");
  assert.equal(coordinator.beginTask(agent, "default", true).status, "no_approved_plan");
});

test("Agent replacement rejects old task identity and clears approval", () => {
  const { agent, coordinator } = fixture();
  approve(coordinator, agent);
  coordinator.setAgent(agent);
  assert.deepEqual(coordinator.approvedPlan(), submitted);
  const other = { id: "replacement" };
  coordinator.setAgent(other);
  assert.equal(coordinator.approvedPlan(), undefined);
  assert.equal(coordinator.beginTask(agent, "default").status, "stale_agent");
  const task = start(coordinator, other, "plan");
  coordinator.setAgent(agent);
  coordinator.setAgent(other);
  assert.equal(task.signal.aborted, true);
  assert.equal(coordinator.matchesTaskContext(task), false);
  assert.equal(coordinator.approvePlan(task, submitted), false);
});

test("initial Session attachment preserves the admitted planning task", () => {
  const agent = { id: "original" };
  const coordinator = new ApplicationCoordinator<typeof agent>();
  coordinator.setAgent(agent);
  const task = start(coordinator, agent, "plan");
  coordinator.attachSession("first-session");
  assert.equal(coordinator.matchesTaskContext(task), true);
  assert.equal(task.signal.aborted, false);
  assert.equal(coordinator.approvePlan(task, submitted), true);
  assert.throws(() => coordinator.attachSession("duplicate"), /already attached/u);
});

test("coding results and incomplete submissions cannot authorize Plan execution", () => {
  const { agent, coordinator } = fixture();
  const coding = start(coordinator, agent);
  assert.equal(coordinator.approvePlan(coding, submitted), false);
  coordinator.finishTask(coding);
  const planning = start(coordinator, agent, "plan");
  assert.equal(coordinator.approvePlan(planning, { ...submitted, plan: " " }), false);
  assert.equal(coordinator.approvePlan(planning, { ...submitted, title: " " }), false);
  assert.equal(coordinator.approvedPlan(), undefined);
});

test("command operation identities reject late results after navigation", () => {
  const { coordinator } = fixture();
  const load = coordinator.nextCommandOperation();
  assert.equal(coordinator.isCurrentCommandOperation(load), true);
  coordinator.nextCommandOperation();
  assert.equal(coordinator.isCurrentCommandOperation(load), false);
  const replacement = coordinator.nextCommandOperation();
  assert.equal(coordinator.isCurrentCommandOperation(replacement), true);
  assert.equal(coordinator.isCurrentCommandOperation(load), false);
});
