import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import { GoalRuntime } from "../../../src/goal/runtime.js";
import { createProductionWorkflowAgentIO } from "../../../src/runtime/production.js";
import type { LearnedTurnOutcome } from "../../../src/memory/learned-memory.js";
import type { SessionGoal } from "../../../src/storage/session-store.js";
import type { BashResult } from "../../../src/tools/bash.js";
import { ProcessCleanupError } from "../../../src/tools/process-completion.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";
import { CodingTaskRunner } from "../../../src/workflow/task-runner.js";

const failedCleanup: BashResult = {
  stdout: "partial", stderr: "", exitCode: 0, signal: null,
  cancelled: true, cleanupFailed: true, error: "termination refused",
};

test("real Agent background cleanup failure denies Goal and successful Memory before verification", async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-cleanup-settlement-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  let goal: SessionGoal | undefined;
  const goalRuntime = new GoalRuntime({
    async getGoal() { return goal; },
    async setGoal(value) { goal = value; },
  });
  await goalRuntime.create({ objective: "Complete the task" });
  let release!: (value: BashResult) => void;
  const worker = new Promise<BashResult>((resolve) => { release = resolve; });
  const memory: LearnedTurnOutcome[] = [];
  let requests = 0, verifications = 0, captures = 0;
  const workflow = new CodingWorkflowRuntime({ workspacePath });
  const agent = new ReactAgent({
    workspacePath, model: "offline-cleanup-settlement", goalRuntime,
    learnedMemory: {
      async loadPrompt() { return ""; },
      scheduleCapture() { captures++; },
      async finishTurn(_turn, outcome) { memory.push(outcome); },
      async remember() {}, async clear() {}, async setEnabled() {},
      async status() { return { enabled: true, projectEntries: 0, userEntries: 0, recent: [] }; },
    },
    client: { responses: { async create() {
      requests++;
      return requests === 1 ? { id: "work", output_text: "", output: [
        { type: "function_call", name: "start_background", call_id: "job", arguments: '{"command":"fixture worker"}' },
        { type: "function_call", name: "update_goal", call_id: "complete", arguments: '{"status":"complete"}' },
      ] } : { id: "done", output_text: "done", output: [] };
    } } },
    io: createProductionWorkflowAgentIO({
      workspacePath, workflow,
      policy: () => ({ mode: "workspace-write", web: false, shellNetwork: "deny" }),
      async execute() { throw new Error("Unexpected foreground command"); },
      executeBackground() { return worker; },
      interaction: { async confirm() { return true; } },
    }),
  });
  t.after(async () => { release(failedCleanup); await assert.rejects(agent.dispose(), ProcessCleanupError); });
  const runner = new CodingTaskRunner({
    agent, workflow,
    host: {
      onStatus(status) {
        if (status === "Waiting for background commands before final verification") release(failedCleanup);
      },
      async executeVerification() { verifications++; return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
      async getGoal() { return goal; }, async addGoalTime() { return goal; },
    },
  });
  await assert.rejects(runner.run({ text: "Complete the task" }), ProcessCleanupError);
  assert.equal(goal?.status, "active");
  assert.equal(verifications, 0);
  assert.deepEqual(memory, ["failed"]);
  assert.equal(captures, 0);
  assert.equal(workflow.state.pending_verification, true);
  assert.equal(workflow.state.result, "unverified");
  assert.equal(JSON.stringify(workflow.state).includes("termination refused"), false);
  await assert.rejects(workflow.runManualVerification([], async () => {
    throw new Error("A failed resource owner cannot launch manual checks");
  }, { supplemental: false }), ProcessCleanupError);
  await assert.rejects(workflow.undo(), ProcessCleanupError);
  assert.equal(requests, 2);
  const restored = new CodingWorkflowRuntime({ workspacePath, initialState: workflow.state });
  await restored.beginTurn();
  const resumed = await restored.finishTurn(async () => { throw new Error("Unexpected verification"); });
  assert.equal(resumed.state.result, "unverified", "restart and empty work cannot erase cleanup debt");
  await assert.rejects(agent.finalizePendingGoalCompletion(true), ProcessCleanupError);
  await assert.rejects(agent.beginTask({ mode: "default", source: "user" }), ProcessCleanupError);
  await assert.rejects(runner.run({ text: "Retry" }), ProcessCleanupError);
  assert.equal(requests, 2);
});

test("production shell bridge preserves cleanup failure without starting snapshot commands", async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-cleanup-bridge-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const workflow = new CodingWorkflowRuntime({ workspacePath });
  let observations = 0;
  t.mock.method(workflow, "observeShellExecution", async () => { observations++; throw new Error("snapshot failed"); });
  const io = createProductionWorkflowAgentIO({
    workspacePath, workflow,
    policy: () => ({ mode: "workspace-write", web: false, shellNetwork: "deny" }),
    async execute() { return failedCleanup; },
  });
  await assert.rejects(io.runBash("foreground"), ProcessCleanupError);
  await assert.rejects(io.runBackgroundBash!("background", new AbortController().signal, 1000, () => {}), ProcessCleanupError);
  assert.equal(observations, 0);
});

test("foreground cleanup failure closes durable tool pairs and stops later tools and requests", async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-foreground-cleanup-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  let requests = 0, commands = 0;
  const persisted: Array<Record<string, unknown>> = [];
  const agent = new ReactAgent({
    workspacePath, model: "offline-foreground-cleanup",
    client: { responses: { async create() {
      requests++;
      return { id: "commands", output_text: "", output: [
        { type: "function_call", name: "bash", call_id: "first", arguments: '{"command":"first"}' },
        { type: "function_call", name: "bash", call_id: "second", arguments: '{"command":"second"}' },
      ] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { commands++; return failedCleanup; }, writeAssistant() {},
    },
    async onHistoryAppend(items) { persisted.push(...items); },
  });
  t.after(() => assert.rejects(agent.dispose(), ProcessCleanupError));
  await assert.rejects(agent.runTurn("Run commands"), ProcessCleanupError);
  assert.equal(commands, 1);
  assert.equal(requests, 1);
  const outputs = persisted.filter((item) => item.type === "function_call_output");
  assert.deepEqual(outputs.map((item) => item.call_id), ["first", "second"]);
  assert.equal(JSON.parse(String(outputs[0]?.output)).cleanup_failed, true);
  assert.equal(JSON.parse(String(outputs[1]?.output)).reason, "process_cleanup_failed");
  await assert.rejects(agent.runTurn("Retry"), ProcessCleanupError);
  assert.equal(requests, 1);
});

test("navigation cleanup failure remains fatal through Agent tool feedback", async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-navigation-settlement-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  let requests = 0, queries = 0;
  const persisted: Array<Record<string, unknown>> = [];
  const agent = new ReactAgent({
    workspacePath, model: "offline-navigation-cleanup",
    codeNavigation: {
      describe() { return "controlled navigation"; },
      async query() { queries++; throw new ProcessCleanupError("fixture tree refused"); },
    },
    client: { responses: { async create() {
      requests++;
      return { id: "navigation", output_text: "", output: [
        { type: "function_call", name: "code_navigation", call_id: "first", arguments: '{"operation":"hover","path":"sample.ts","line":1,"column":1}' },
        { type: "function_call", name: "code_navigation", call_id: "second", arguments: '{"operation":"hover","path":"sample.ts","line":1,"column":1}' },
      ] };
    } } },
    io: { async confirmBash() { return true; }, async runBash() { throw new Error("Unexpected shell"); }, writeAssistant() {} },
    async onHistoryAppend(items) { persisted.push(...items); },
  });
  t.after(() => assert.rejects(agent.dispose(), ProcessCleanupError));
  await assert.rejects(agent.runTurn("Inspect the symbol"), ProcessCleanupError);
  const outputs = persisted.filter((item) => item.type === "function_call_output");
  assert.deepEqual(outputs.map((item) => item.call_id), ["first", "second"]);
  assert.equal(JSON.parse(String(outputs[0]?.output)).cleanup_failed, true);
  assert.equal(JSON.parse(String(outputs[1]?.output)).reason, "process_cleanup_failed");
  await assert.rejects(agent.runTurn("Retry"), ProcessCleanupError);
  assert.equal(requests, 1);
  assert.equal(queries, 1);
});

test("cleanup failure during cancellation remains the runner error and blocks reuse", async () => {
  const controller = new AbortController();
  const failure = new ProcessCleanupError(new Error("termination refused"));
  const finalized: boolean[] = [], memory: LearnedTurnOutcome[] = [];
  let turns = 0;
  const runner = new CodingTaskRunner({
    agent: {
      async runTurn() { turns++; controller.abort(new Error("cancelled")); throw controller.signal.reason; },
      async cancelBackgroundJobs() { throw failure; },
      async finalizePendingGoalCompletion(allow) { finalized.push(allow); },
      async finishMemoryTurn(outcome) { memory.push(outcome); },
    },
    workflow: new CodingWorkflowRuntime({ workspacePath: process.cwd() }),
    host: {
      async executeVerification() { throw new Error("Unexpected verification"); },
      async getGoal() { return undefined; }, async addGoalTime() { return undefined; },
    },
  });
  await assert.rejects(runner.run({ text: "Run", mode: "plan", signal: controller.signal }), (error) => error === failure);
  assert.deepEqual(finalized, [false]);
  assert.deepEqual(memory, ["failed"]);
  await assert.rejects(runner.run({ text: "Retry" }), (error) => error === failure);
  assert.equal(turns, 1);
});

test("host verification cleanup failure stops production repair and settlement", async (t) => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-verification-cleanup-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  await writeFile(join(workspacePath, "package.json"), JSON.stringify({ scripts: { test: "fixture" } }));
  const exec = promisify(execFile);
  await exec("git", ["init", "--quiet"], { cwd: workspacePath });
  await exec("git", ["add", "package.json"], { cwd: workspacePath });
  await exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: workspacePath });
  const finalized: boolean[] = [], memory: LearnedTurnOutcome[] = [];
  let turns = 0, verifications = 0;
  const runner = new CodingTaskRunner({
    agent: {
      async runTurn() { turns++; await writeFile(join(workspacePath, "changed.ts"), "export const changed = true;\n"); return {}; },
      async finalizePendingGoalCompletion(allow) { finalized.push(allow); },
      async finishMemoryTurn(outcome) { memory.push(outcome); },
    },
    workflow: new CodingWorkflowRuntime({ workspacePath }),
    host: {
      async executeVerification() { verifications++; return failedCleanup; },
      async getGoal() { return undefined; }, async addGoalTime() { return undefined; },
    },
  });
  await assert.rejects(runner.run({ text: "Change" }), ProcessCleanupError);
  assert.equal(turns, 1);
  assert.equal(verifications, 1);
  assert.deepEqual(finalized, [false]);
  assert.deepEqual(memory, ["failed"]);
  await assert.rejects(runner.run({ text: "Retry" }), ProcessCleanupError);
});
