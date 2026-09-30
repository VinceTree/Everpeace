import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";
import { CodingTaskRunner } from "../../../src/workflow/task-runner.js";

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
