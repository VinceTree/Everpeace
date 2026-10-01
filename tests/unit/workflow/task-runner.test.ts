import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";
import { CodingTaskRunner } from "../../../src/workflow/task-runner.js";
import type { WorkflowRunResult } from "../../../src/workflow/types.js";

const exec = promisify(execFile);

test("coding task runner shares the production turn, verification, and settlement lifecycle", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-task-runner-"));
  await writeFile(join(workspacePath, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
  await exec("git", ["init", "--quiet"], { cwd: workspacePath });
  await exec("git", ["config", "user.email", "runner@example.invalid"], { cwd: workspacePath });
  await exec("git", ["config", "user.name", "Runner"], { cwd: workspacePath });
  await exec("git", ["add", "package.json"], { cwd: workspacePath });
  await exec("git", ["commit", "--quiet", "-m", "fixture"], { cwd: workspacePath });
  const finalized: boolean[] = [];
  const memory: string[] = [];
  let turns = 0;
  const runner = new CodingTaskRunner({
    agent: {
      async runTurn() { turns += 1; return {}; },
      async finalizePendingGoalCompletion(allow) { finalized.push(allow); },
      async finishMemoryTurn(outcome) { memory.push(outcome); },
    },
    workflow: new CodingWorkflowRuntime({ workspacePath }),
    host: {
      async executeVerification() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
      async getGoal() { return undefined; },
      async addGoalTime() { return undefined; },
    },
  });
  const result = await runner.run({ text: "inspect only" });
  assert.equal(result.disposition, "completed");
  assert.equal(result.workflowResult?.state.result, "no_changes");
  assert.equal(turns, 1);
  assert.deepEqual(finalized, [true]);
  assert.deepEqual(memory, ["unverified"]);
});

test("cancellation during final verification cannot complete Goal or verified Memory", async () => {
  const controller = new AbortController();
  const finalized: boolean[] = [];
  const memory: string[] = [];
  let cancelledJobs = 0;
  const workflow = {
    state: { phase: "verify" },
    async beginTurn() {},
    async resumeTurn() {},
    async startRepairTurn() { return { phase: "implement" }; },
    async finishTurn() {
      controller.abort(new Error("cancel during workflow settlement"));
      return { state: { phase: "done", result: "verified", repair_attempts: 0 }, changed: true } as unknown as WorkflowRunResult;
    },
  } as unknown as CodingWorkflowRuntime;
  const runner = new CodingTaskRunner({
    agent: {
      async runTurn() { return {}; },
      async cancelBackgroundJobs() { cancelledJobs += 1; },
      async finalizePendingGoalCompletion(allow) { finalized.push(allow); },
      async finishMemoryTurn(outcome) { memory.push(outcome); },
    },
    workflow,
    host: {
      async executeVerification() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
      async getGoal() { return undefined; },
      async addGoalTime() { return undefined; },
    },
  });
  await assert.rejects(runner.run({ text: "change", signal: controller.signal }), /cancel during workflow settlement/);
  assert.deepEqual(finalized, [false]);
  assert.deepEqual(memory, ["stopped"]);
  assert.equal(cancelledJobs, 1);
});

test("coding task runner rejects a new task while failed-task cleanup is unresolved", async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let cleanupStarted!: () => void;
  const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  const runner = new CodingTaskRunner({
    agent: {
      async runTurn() { throw new Error("task failed"); },
      async cancelBackgroundJobs() { cleanupStarted(); await cleanup; },
      async finalizePendingGoalCompletion() {},
      async finishMemoryTurn() {},
    },
    workflow: {
      state: { phase: "implement", repair_attempts: 0 },
      async beginTurn() {},
    } as unknown as CodingWorkflowRuntime,
    host: {
      async executeVerification() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
      async getGoal() { return undefined; },
      async addGoalTime() { return undefined; },
    },
  });

  const first = runner.run({ text: "first" });
  await started;
  await assert.rejects(runner.run({ text: "second" }), /already running or cleaning up/u);
  releaseCleanup();
  await assert.rejects(first, /task failed/u);
});
