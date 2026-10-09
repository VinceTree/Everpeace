import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as nativeTimeout, clearTimeout as nativeClearTimeout } from "node:timers";
import { promisify } from "node:util";
import type { AgentResponse } from "../../../src/agent/react-agent.js";
import { LearnedMemoryRuntime, LearnedMemoryStore, type LearnedTurnOutcome } from "../../../src/memory/learned-memory.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { createProductionAgent, createProductionWorkflowAgentIO } from "../../../src/runtime/production.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";
import { CodingTaskRunner } from "../../../src/workflow/task-runner.js";

const idleDelayMs = 300_000;
const realTimeout = nativeTimeout;
const realClearTimeout = nativeClearTimeout;
const delay = () => new Promise<void>((resolve) => realTimeout(resolve, 5));
const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const memoryResponse = (): AgentResponse => ({ id: "old-memory", status: "completed", output: [], usage,
  output_text: '{"entries":[{"lesson":"Use pnpm","applyWhen":"Node projects"}]}' });
const oldTurn = (root: string) => ({ workspacePath: root, sessionId: "old-session", userInput: "Fix the old defect",
  transcript: "Old verified local result", assistantText: "done", toolCallCount: 1 });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function codingFixture(stream: ProviderRuntime["responses"]["stream"], maxSteps?: number) {
  const root = await mkdtemp(join(tmpdir(), "everpeace-memory-idle-coding-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.txt"), "before\n");
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "offline", scripts: {
    typecheck: "node -e \"process.exit(0)\"", lint: "node -e \"process.exit(0)\"",
    test: "node -e \"process.exit(0)\"", build: "node -e \"process.exit(0)\"",
  } }));
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: workspace });
  await git(["init", "--quiet"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "user.name", "Offline fixture"]);
  await git(["add", "source.txt", "package.json"]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  const store = new LearnedMemoryStore({ directory: join(root, "memory") });
  const sessions = new SessionStore({ directory: join(root, "sessions") });
  const session = await sessions.create({ title: "Idle coding", titlePending: false, workspacePath: workspace,
    model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1" } });
  const capabilities = resolveProviderCapabilities("https://compatible.invalid/v1", "offline");
  let requests = 0;
  const provider: ProviderRuntime = { sdk: {} as ProviderRuntime["sdk"], capabilities,
    settings: defaultModelRequestSettings(capabilities), responses: {
      async create(params) {
        requests++;
        const old = String(params.input).includes("old defect");
        return { ...memoryResponse(), output_text: JSON.stringify({ entries: [{
          lesson: old ? "Use pnpm" : "Verify source changes",
          applyWhen: old ? "Node projects" : "When changing source behavior",
        }] }) };
      }, stream,
    } };
  const workflow = new CodingWorkflowRuntime({ workspacePath: workspace });
  const handle = createProductionAgent({ workspacePath: workspace,
    model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" },
    providerRuntime: provider, sessionStore: sessions, sessionId: () => session.id,
    skills: null, mcp: null, codeNavigation: null, learnedMemoryStore: store, memoryIdleDelayMs: idleDelayMs,
    ...(maxSteps === undefined ? {} : { maxSteps }),
    io: createProductionWorkflowAgentIO({ workspacePath: workspace, workflow,
      policy: () => ({ mode: "workspace-write", web: false, shellNetwork: "deny" }),
      async execute() { assert.fail("Unexpected model shell"); },
      async executeVerification() { return { stdout: "offline fast check", stderr: "", exitCode: 0, signal: null }; },
      output: { assistant() {} },
    }),
  });
  assert.ok(handle.learnedMemory instanceof LearnedMemoryRuntime);
  return { root, workspace, store, sessions, session, handle, memory: handle.learnedMemory, workflow,
    requests: () => requests,
    async dispose() { await handle.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

function completed(response: AgentResponse) {
  return { async *[Symbol.asyncIterator]() { yield { type: "response.completed", response }; } };
}

function tool(name: string, args: unknown): AgentResponse {
  return { id: name, status: "completed", usage, output_text: "",
    output: [{ type: "function_call", name, call_id: name, arguments: JSON.stringify(args) }] };
}

test("production verification, Goal settlement, and continuation all hold the same idle pause", async (t) => {
  const time = clock(t);
  const verificationGate = gate(), settlementGate = gate(), continuationGate = gate();
  let codingRequests = 0, verifying = false, settling = false, continuing = false, settlements = 0;
  const owner = await codingFixture(async () => {
    codingRequests++;
    if (codingRequests === 1) return completed(tool("read_file", { path: "source.txt" }));
    if (codingRequests === 2) return completed(tool("apply_patch", { operations: [{ path: "source.txt", action: "update", content: "after\n" }] }));
    if (codingRequests === 4) { continuing = true; await continuationGate.promise; }
    assert.ok(codingRequests <= 4);
    return completed({ id: "done", status: "completed", output: [], output_text: "done", usage });
  });
  const commands: string[] = [];
  const runner = new CodingTaskRunner({ agent: owner.handle.agent, workflow: owner.workflow,
    host: { async getGoal() { return undefined; },
      async executeVerification(command) {
        commands.push(command);
        if (commands.length === 1) { verifying = true; await verificationGate.promise; }
        return { stdout: "offline host verification", stderr: "", exitCode: 0, signal: null };
      },
      async addGoalTime() {
        if (++settlements !== 1) return undefined;
        settling = true; await settlementGate.promise;
        const now = new Date().toISOString();
        return { goal_id: "offline-goal", objective: "Inspect after verification", status: "active", token_budget: null,
          tokens_used: 0, usage_complete: true, time_used_seconds: 0, created_at: now, updated_at: now };
      },
    } });
  let task: ReturnType<typeof runner.run> | undefined;
  try {
    await owner.memory.finishTurn(oldTurn(owner.workspace), "verified");
    task = runner.run({ text: "Fix source behavior" });
    void task.catch(() => undefined);
    await time.until(() => verifying);
    assert.equal(await readFile(join(owner.workspace, "source.txt"), "utf8"), "after\n");
    await time.advance(idleDelayMs);
    assert.equal(owner.requests(), 0, "Host verification is foreground work");
    verificationGate.release();
    await time.until(() => settling);
    assert.equal(owner.workflow.state.result, "verified");
    assert.equal((await owner.store.loadJobs()).length, 2);
    assert.equal(commands.length, 4);
    await time.advance(idleDelayMs);
    assert.equal(owner.requests(), 0, "A verified turn is still owned by the active task");
    settlementGate.release();
    await time.until(() => continuing);
    await time.advance(idleDelayMs);
    assert.equal(owner.requests(), 0, "Goal continuation retains the task pause");
    continuationGate.release();
    assert.equal((await task).workflowResult?.state.result, "verified");
    assert.deepEqual(commands.map((command) => command.match(/\brun\s+(\w+)/u)?.[1]),
      ["typecheck", "lint", "test", "build", "typecheck", "lint", "test", "build"]);
    const jobs = await owner.store.loadJobs();
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => Date.parse(job.notBefore) === Date.now() + idleDelayMs));
    await time.advance(idleDelayMs - 1);
    assert.equal(owner.requests(), 0);
    await time.advance(1);
    await time.until(async () => (await owner.store.loadJobs()).length === 0);
    assert.equal(owner.requests(), 2);
    assert.equal((await owner.store.read("project", owner.workspace)).length, 2);
  } finally {
    verificationGate.release(); settlementGate.release(); continuationGate.release();
    if (task) await Promise.allSettled([task]);
    await owner.dispose();
  }
});

for (const outcome of ["no_changes", "failed", "cancelled", "stopped"] as const) {
  test(`production ${outcome} exits restore the prior queue without learning the new task`, async (t) => {
    const time = clock(t);
    const foregroundGate = gate();
    const controller = new AbortController();
    const failure = new Error("Offline task failed");
    let foreground = false;
    const owner = await codingFixture(async () => {
      foreground = true; await foregroundGate.promise;
      if (outcome === "failed") throw failure;
      if (outcome === "stopped") return completed(tool("read_file", { path: "source.txt" }));
      return completed({ id: "done", status: "completed", output: [], output_text: "done", usage });
    }, outcome === "stopped" ? 1 : undefined);
    const runner = new CodingTaskRunner({ agent: owner.handle.agent, workflow: owner.workflow,
      host: { async getGoal() { return undefined; }, async addGoalTime() { return undefined; },
        async executeVerification() { assert.fail("Unchanged and interrupted tasks have no final verification"); } } });
    let task: ReturnType<typeof runner.run> | undefined;
    try {
      await owner.memory.finishTurn(oldTurn(owner.workspace), "verified");
      task = runner.run({ text: "Inspect a separate issue", signal: controller.signal });
      void task.catch(() => undefined);
      await time.until(() => foreground);
      await time.advance(idleDelayMs);
      assert.equal(owner.requests(), 0);
      if (outcome === "cancelled") controller.abort(new Error("Offline task cancelled"));
      foregroundGate.release();
      if (outcome === "failed") await assert.rejects(task, (error: unknown) => error === failure);
      else if (outcome === "cancelled") await assert.rejects(task, /cancelled/iu);
      else {
        const result = await task;
        if (outcome === "stopped") assert.equal(result.agentResult.stopReason, "step_limit");
        else assert.equal(result.workflowResult?.state.result, "no_changes");
      }
      const jobs = await owner.store.loadJobs();
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.turn.sessionId, "old-session");
      assert.equal(Date.parse(jobs[0]!.notBefore), Date.now() + idleDelayMs);
      await time.advance(idleDelayMs - 1);
      assert.equal(owner.requests(), 0);
      await time.advance(1);
      await time.until(async () => (await owner.store.loadJobs()).length === 0);
      assert.equal(owner.requests(), 1);
      assert.equal((await owner.store.read("project", owner.workspace)).length, 1);
    } finally {
      foregroundGate.release();
      if (task) await Promise.allSettled([task]);
      await owner.dispose();
    }
  });
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const idleTimeout = globalThis.setTimeout;
  const clearIdleTimeout = globalThis.clearTimeout;
  const liveTimers = new Set<ReturnType<typeof realTimeout> | number>();
  // Only long idle/lease waits are virtual. File locks and Windows rename
  // backoff must make progress while asynchronous persistence is awaited.
  t.mock.method(globalThis, "setTimeout", (callback: Parameters<typeof realTimeout>[0], ms = 0, ...args: unknown[]) => {
    if (ms >= idleDelayMs) return idleTimeout(callback, ms, ...args);
    const timer = realTimeout(callback, ms, ...args);
    liveTimers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof realClearTimeout>[0]) => {
    if ((typeof timer === "object" && timer !== null || typeof timer === "number") && liveTimers.delete(timer)) realClearTimeout(timer);
    else clearIdleTimeout(timer);
  });
  t.after(() => { for (const timer of liveTimers) realClearTimeout(timer); });
  return {
    async settle() { for (let attempt = 0; attempt < 40; attempt++) { await delay(); t.mock.timers.tick(0); } },
    async advance(ms: number) { t.mock.timers.tick(ms); await this.settle(); },
    async until(check: () => boolean | Promise<boolean>) {
      for (let attempt = 0; attempt < 1_000; attempt++) {
        t.mock.timers.tick(0);
        if (await check()) return;
        await delay();
      }
      assert.fail("Offline fixture did not reach its observable state");
    },
  };
}

test("the controlled idle clock lets short persistence retry timers complete without advancing idle time", async (t) => {
  clock(t);
  const startedAt = Date.now();
  let retried = false;
  setTimeout(() => { retried = true; }, 10);
  for (let attempt = 0; !retried && attempt < 50; attempt++) await delay();
  assert.equal(retried, true, "Windows rename and lock retries must not wait for a five-minute clock tick");
  assert.equal(Date.now(), startedAt);
});

test("Windows Memory atomic rename retries complete while the idle clock stays fixed", { skip: process.platform !== "win32" }, async (t) => {
  clock(t);
  const root = await mkdtemp(join(tmpdir(), "everpeace-memory-idle-rename-"));
  const store = new LearnedMemoryStore({ directory: join(root, "memory") });
  const realRename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]).endsWith("capture-jobs.json") && ++attempts === 1) {
      throw Object.assign(new Error("Fixture transient Windows sharing violation"), { code: "EBUSY" });
    }
    return realRename(...args);
  });
  try {
    const startedAt = Date.now();
    const now = new Date().toISOString();
    await store.updateJobs(() => [{ id: "reliable", turn: oldTurn(root), outcome: "verified", status: "queued",
      createdAt: now, notBefore: now, attempts: 0, requestPending: false, usageComplete: true }]);
    assert.equal(attempts, 2);
    assert.equal((await store.loadJobs()).length, 1);
    assert.equal(Date.now(), startedAt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const status of ["queued", "running"] as const) {
  test(`restarting a runtime gives an overdue reliable ${status} job a fresh idle period`, async (t) => {
    const time = clock(t);
    const root = await mkdtemp(join(tmpdir(), "everpeace-memory-idle-restart-"));
    const store = new LearnedMemoryStore({ directory: join(root, "memory") });
    const expired = new Date(Date.now() - 1).toISOString();
    await store.updateJobs(() => [{ id: "old-reliable-job", turn: oldTurn(root), outcome: "verified", status,
      createdAt: expired, notBefore: expired, attempts: 0, requestPending: false, usageComplete: true }]);
    let requests = 0;
    const memory = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs,
      client: { responses: { async create() { requests++; return memoryResponse(); } } } });
    try {
      await memory.loadPrompt(root);
      await time.settle();
      assert.equal(requests, 0, "Time while the process was closed is not idle time in this runtime");
      assert.equal((await store.loadJobs())[0]?.status, "queued");
      assert.equal(Date.parse((await store.loadJobs())[0]!.notBefore), Date.now() + idleDelayMs);
      await time.advance(idleDelayMs - 1);
      assert.equal(requests, 0);
      await time.advance(1);
      await time.until(async () => (await store.loadJobs()).length === 0);
      assert.equal(requests, 1);
    } finally { await memory.dispose(); await rm(root, { recursive: true, force: true }); }
  });
}

test("foreground startup preserves unknown recovery debt without starting Memory requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "everpeace-memory-idle-debt-"));
  const store = new LearnedMemoryStore({ directory: join(root, "memory") });
  const expired = new Date(Date.now() - 1).toISOString();
  await store.updateJobs(() => [{ id: "interrupted-job", turn: oldTurn(root), outcome: "verified", status: "running",
    createdAt: expired, notBefore: expired, attempts: 0, requestPending: true, usageComplete: true }]);
  let requests = 0;
  const memory = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0,
    client: { responses: { async create() { requests++; return memoryResponse(); } } } });
  try {
    await memory.beginTask();
    assert.equal((await store.loadJobs())[0]?.status, "failed");
    assert.equal((await memory.status(root)).capture?.usage, null);
    await memory.endTask();
    await memory.dispose();
    assert.equal(requests, 0);
    assert.equal((await store.loadJobs())[0]?.status, "failed");
  } finally { await memory.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("production task startup cannot publish progress after its Memory pause outlives disposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "everpeace-memory-idle-task-close-"));
  const pauseGate = gate();
  let paused = false, progressWrites = 0;
  const capabilities = resolveProviderCapabilities("https://compatible.invalid/v1", "offline");
  const provider: ProviderRuntime = { sdk: {} as ProviderRuntime["sdk"], capabilities,
    settings: defaultModelRequestSettings(capabilities), responses: {
      async create() { assert.fail("Closed startup cannot send a Memory request"); },
      async stream() { assert.fail("Closed startup cannot send a coding request"); },
    } };
  const handle = createProductionAgent({ workspacePath: root,
    model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" },
    providerRuntime: provider, sessionStore: new SessionStore({ directory: join(root, "sessions") }), sessionId: () => undefined,
    skills: null, mcp: null, codeNavigation: null,
    learnedMemoryStore: new LearnedMemoryStore({ directory: join(root, "memory") }), learnedMemoryPolicy: { captureFuture: false },
    io: { async confirmBash() { return false; }, async runBash() { assert.fail("Unexpected shell"); }, writeAssistant() {},
      async setTaskProgress() { progressWrites++; } },
  });
  // Gate this exact foreground pause, not an unrelated startup store write.
  // The real runtime and persistent pause complete before its result is held.
  const memory = handle.learnedMemory!;
  const beginMemoryTask = memory.beginTask!.bind(memory);
  memory.beginTask = async () => {
    await beginMemoryTask();
    paused = true;
    await pauseGate.promise;
  };
  let starting: Promise<void> | undefined, closing: Promise<void> | undefined;
  try {
    await handle.learnedMemory!.loadPrompt(root);
    starting = handle.agent.beginTask({ mode: "default", source: "user" });
    void starting.catch(() => undefined);
    for (let attempt = 0; !paused && attempt < 1_000; attempt++) await delay();
    assert.equal(paused, true);
    closing = handle.dispose();
    void closing.catch(() => undefined);
    pauseGate.release();
    await assert.rejects(starting, /disposed/iu);
    await closing;
    assert.equal(progressWrites, 0);
  } finally {
    pauseGate.release();
    await Promise.allSettled([starting, closing].filter((operation) => operation !== undefined));
    await handle.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

for (const outcome of ["unverified", "failed", "stopped"] satisfies LearnedTurnOutcome[]) {
  test(`a ${outcome} turn resumes only the prior verified queue after a fresh idle delay`, async (t) => {
    const time = clock(t);
    const root = await mkdtemp(join(tmpdir(), "everpeace-memory-idle-turn-"));
    const store = new LearnedMemoryStore({ directory: join(root, "memory") });
    let requests = 0;
    const memory = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs,
      client: { responses: { async create() { requests++; return memoryResponse(); } } } });
    try {
      await memory.finishTurn(oldTurn(root), "verified");
      await memory.beginTurn();
      await time.advance(idleDelayMs);
      assert.equal(requests, 0);
      await memory.finishTurn({ ...oldTurn(root), sessionId: "new-session", userInput: "Inspect a separate issue", toolCallCount: 0 }, outcome);
      const jobs = await store.loadJobs();
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.turn.sessionId, "old-session");
      const resumedAt = Date.now();
      await time.advance(idleDelayMs - 1);
      assert.equal(requests, 0);
      await time.advance(1);
      await time.until(() => requests === 1);
      assert.equal(requests, 1, "The prior verified queue must resume after the skipped turn");
      assert.equal(Date.parse(jobs[0]!.notBefore), resumedAt + idleDelayMs);
      await time.until(async () => (await store.loadJobs()).length === 0);
      assert.equal((await store.read("project", root)).length, 1);
    } finally { await memory.dispose(); await rm(root, { recursive: true, force: true }); }
  });
}

for (const decision of ["approve", "cancel"] as const) {
  test(`production Plan ${decision} pauses and then restores a previously active Memory job`, async (t) => {
    const time = clock(t);
    const root = await mkdtemp(join(tmpdir(), "everpeace-memory-idle-plan-"));
    const store = new LearnedMemoryStore({ directory: join(root, "memory") });
    const memoryGate = gate(), reviewGate = gate();
    let requests = 0, reviewing = false;
    let memorySignal: AbortSignal | undefined;
    const capabilities = resolveProviderCapabilities("https://compatible.invalid/v1", "offline");
    const provider: ProviderRuntime = { sdk: {} as ProviderRuntime["sdk"], capabilities,
      settings: defaultModelRequestSettings(capabilities), responses: {
        async create(_params, options) { requests++; memorySignal = options?.signal as AbortSignal | undefined; await memoryGate.promise; return memoryResponse(); },
        async stream() { return { async *[Symbol.asyncIterator]() {
          yield { type: "response.completed", response: { id: "plan", status: "completed", usage, output_text: "",
            output: [{ type: "function_call", call_id: "plan-review", name: "submit_plan", arguments: JSON.stringify({ title: "Inspect", plan: "Read source and verify offline" }) }] } };
        } }; },
      } };
    const sessions = new SessionStore({ directory: join(root, "sessions") });
    const session = await sessions.create({ title: "Idle lifecycle", titlePending: false, workspacePath: root,
      model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1" } });
    const handle = createProductionAgent({ workspacePath: root,
      model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" },
      providerRuntime: provider, sessionStore: sessions, sessionId: () => session.id,
      skills: null, mcp: null, codeNavigation: null, learnedMemoryStore: store, memoryIdleDelayMs: idleDelayMs,
      io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected shell"); }, writeAssistant() {},
        async requestUserInput() { assert.fail("Unexpected Plan question"); },
        async reviewPlan() { reviewing = true; await reviewGate.promise; return decision; } },
    });
    assert.ok(handle.learnedMemory instanceof LearnedMemoryRuntime);
    const memory = handle.learnedMemory;
    const runner = new CodingTaskRunner({ agent: handle.agent, workflow: new CodingWorkflowRuntime({ workspacePath: root }),
      host: { async getGoal() { return undefined; }, async addGoalTime() { return undefined; },
        async executeVerification() { assert.fail("Plan must not run verification"); } } });
    let task: ReturnType<typeof runner.run> | undefined;
    try {
      await memory.finishTurn(oldTurn(root), "verified");
      await time.advance(idleDelayMs);
      await time.until(() => requests === 1);
      task = runner.run({ text: "Plan a separate inspection", mode: "plan" });
      void task.catch(() => undefined);
      await time.until(() => reviewing);
      assert.equal(memorySignal?.aborted, true);
      memoryGate.release();
      await time.until(async () => (await store.loadJobs())[0]?.status === "queued");
      await time.settle();
      await time.advance(idleDelayMs);
      assert.equal(requests, 1, "Memory must stay paused while the host is reviewing the Plan");
      reviewGate.release();
      const result = await task;
      assert.equal(result.disposition, decision === "approve" ? "plan_approved" : "plan_cancelled");
      const jobs = await store.loadJobs();
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.turn.sessionId, "old-session");
      assert.equal(Date.parse(jobs[0]!.notBefore), Date.now() + idleDelayMs);
      await time.advance(idleDelayMs - 1);
      assert.equal(requests, 1);
      await time.advance(1);
      await time.until(() => requests === 2);
      await time.until(async () => (await store.loadJobs()).length === 0);
    } finally {
      memoryGate.release(); reviewGate.release();
      if (task) await Promise.allSettled([task]);
      await handle.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
