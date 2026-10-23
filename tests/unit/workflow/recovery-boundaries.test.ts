import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GoalRuntime } from "../../../src/goal/runtime.js";
import { SessionStore, type SessionGoal } from "../../../src/storage/session-store.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";
import { CodingTaskRunner } from "../../../src/workflow/task-runner.js";
import { createWorkflowState, type WorkflowRunResult, type WorkflowState } from "../../../src/workflow/types.js";
import { WorkspaceChangeTracker } from "../../../src/workflow/workspace-tracker.js";

const passed = () => ({ stdout: "fresh check", stderr: "", exitCode: 0, signal: null });
const debts: Array<{ name: string; state: Partial<WorkflowState> }> = [
  { name: "pending verification without known paths", state: { pending_verification: true } },
  { name: "legacy unverified result without a pending flag", state: { result: "unverified", phase: "done" } },
  { name: "legacy failure without a pending flag", state: { result: "failed", phase: "diagnose", repair_attempts: 1 } },
  { name: "interrupted verification without a final result", state: { phase: "verify_full" } },
];

for (const debt of debts) test(`Session recovery revalidates ${debt.name}`, async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "everpeace-recovery-debt-"));
  try {
    const workspacePath = join(root, "workspace");
    const directory = join(root, "sessions");
    await fs.mkdir(workspacePath);
    execFileSync("git", ["init", "--quiet", workspacePath], { windowsHide: true });
    await fs.writeFile(join(workspacePath, "package.json"), JSON.stringify({ scripts: { typecheck: "fixture", lint: "fixture", test: "fixture", build: "fixture" } }));
    const store = new SessionStore({ directory });
    const session = await store.create({ title: "recover", titlePending: false, workspacePath, model: { id: "offline", model_name: "offline", base_url: "https://example.test" } });
    await store.setWorkflow(session.id, { ...createWorkflowState("interrupted", new Date().toISOString()), ...debt.state });
    const reopened = new SessionStore({ directory });
    const restored = await reopened.load(session.id);
    assert.ok(restored.workflow);
    const runtime = new CodingWorkflowRuntime({ workspacePath, initialState: restored.workflow, async confirmVerificationBasis() { return true; }, onState: state => reopened.setWorkflow(session.id, state) });
    await runtime.resumeTurn();
    const checks: string[] = [];
    const result = await runtime.finishTurn(async command => { checks.push(command); return passed(); });
    assert.deepEqual(checks.map(command => command.split(" ").at(-1)), ["typecheck", "lint", "test", "build"]);
    assert.equal(result.state.result, "verified");
    assert.equal(result.state.pending_verification, false);
    assert.equal(result.state.repair_attempts, restored.workflow.repair_attempts);
    assert.equal((await reopened.load(session.id)).workflow?.result, "verified");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("restored debt stays unverified when Git tracking is unavailable", async () => {
  const workspacePath = await fs.mkdtemp(join(tmpdir(), "everpeace-recovery-untracked-"));
  try {
    const runtime = new CodingWorkflowRuntime({ workspacePath, initialState: { ...createWorkflowState("untracked", new Date().toISOString()), pending_verification: true, result: "unverified", changed_paths: ["unknown.ts"] } });
    await runtime.resumeTurn();
    const result = await runtime.finishTurn(async () => { throw new Error("No checks are available"); });
    assert.equal(result.state.result, "unverified");
    assert.equal(result.state.pending_verification, true);
    assert.deepEqual(result.state.changed_paths, ["unknown.ts"]);
  } finally { await fs.rm(workspacePath, { recursive: true, force: true }); }
});

test("recovered debt without paths still requires fresh verification authorization", async () => {
  const workspacePath = await fs.mkdtemp(join(tmpdir(), "everpeace-recovery-approval-"));
  try {
    execFileSync("git", ["init", "--quiet", workspacePath], { windowsHide: true });
    await fs.writeFile(join(workspacePath, "package.json"), JSON.stringify({ scripts: { test: "fixture" } }));
    let checks = 0;
    const runtime = new CodingWorkflowRuntime({ workspacePath, initialState: { ...createWorkflowState("unapproved", new Date().toISOString()), pending_verification: true } });
    await runtime.resumeTurn();
    const result = await runtime.finishTurn(async () => { checks++; return passed(); });
    assert.equal(checks, 0);
    assert.equal(result.state.result, "unverified");
    assert.equal(result.state.pending_verification, true);
    assert.match(result.verificationSuite?.reason ?? "", /fresh user authorization/u);
  } finally { await fs.rm(workspacePath, { recursive: true, force: true }); }
});

test("pre-cancelled Session recovery never starts a workspace snapshot or saves state", async t => {
  const controller = new AbortController();
  const reason = new Error("recovery cancelled");
  controller.abort(reason);
  let snapshots = 0, saves = 0;
  t.mock.method(WorkspaceChangeTracker.prototype, "begin", async () => { snapshots++; return { available: false, complete: false, changedPaths: [] }; });
  const runtime = new CodingWorkflowRuntime({ workspacePath: process.cwd(), onState() { saves++; } });
  await assert.rejects(runtime.resumeTurn(controller.signal), error => error === reason);
  assert.equal(snapshots, 0);
  assert.equal(saves, 0);
});

test("Session recovery passes cancellation into its initial workspace snapshot", async t => {
  const controller = new AbortController();
  const reason = new Error("cancel during recovery snapshot");
  let saves = 0;
  t.mock.method(WorkspaceChangeTracker.prototype, "begin", async (signal?: AbortSignal) => {
    assert.equal(signal, controller.signal);
    controller.abort(reason);
    signal!.throwIfAborted();
    throw new Error("Snapshot cancellation was not propagated");
  });
  const runtime = new CodingWorkflowRuntime({ workspacePath: process.cwd(), onState() { saves++; } });
  await assert.rejects(runtime.resumeTurn(controller.signal), error => error === reason);
  assert.equal(saves, 0);
});

test("a pre-cancelled cold workspace observation cannot start Git", async t => {
  const controller = new AbortController();
  const reason = new Error("snapshot cancelled");
  controller.abort(reason);
  let snapshots = 0;
  t.mock.method(WorkspaceChangeTracker.prototype, "begin", async () => { snapshots++; return { available: false, complete: false, changedPaths: [] }; });
  const tracker = new WorkspaceChangeTracker(process.cwd());
  await assert.rejects(tracker.observe(controller.signal), error => error === reason);
  assert.equal(snapshots, 0);
});

test("a cold workspace observation passes its cancellation signal to Git discovery", async t => {
  const controller = new AbortController();
  const reason = new Error("snapshot cancelled");
  t.mock.method(WorkspaceChangeTracker.prototype, "begin", async (signal?: AbortSignal) => {
    assert.equal(signal, controller.signal);
    controller.abort(reason);
    throw reason;
  });
  await assert.rejects(new WorkspaceChangeTracker(process.cwd()).observe(controller.signal), error => error === reason);
});

for (const stop of ["cancellation", "deadline"] as const) test(`${stop} during team verification cleanup cannot complete Goal or Memory`, async () => {
  const controller = new AbortController();
  const reason = new Error(stop);
  let goal: SessionGoal | undefined;
  const goals = new GoalRuntime({ async getGoal() { return goal; }, async setGoal(value) { goal = value; } });
  await goals.create({ objective: "Keep the task active until settlement" });
  const finalized: boolean[] = [], memory: string[] = [];
  const state: WorkflowState = { ...createWorkflowState("verify", new Date().toISOString()), phase: "done", result: "verified" };
  const workflow = { state, async beginTurn() {}, async finishTurn(): Promise<WorkflowRunResult> { return { state, changed: true }; } } as unknown as CodingWorkflowRuntime;
  const runner = new CodingTaskRunner({ agent: {
    async runTurn() { return {}; },
    async finishTeamVerification() { controller.abort(reason); },
    async finalizePendingGoalCompletion(allow) { finalized.push(allow); if (allow) await goals.update("complete"); },
    async finishMemoryTurn(outcome) { memory.push(outcome); },
  }, workflow, host: { async getGoal() { return goal; }, async addGoalTime() { return goal; }, async executeVerification() { return passed(); } } });
  await assert.rejects(runner.run({ text: "verify", signal: controller.signal }), error => error === reason);
  assert.equal(goal?.status, "active");
  assert.deepEqual(finalized, [false]);
  assert.deepEqual(memory, ["stopped"]);
});
