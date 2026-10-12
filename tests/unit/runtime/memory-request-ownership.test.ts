import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { AuxiliaryRequestExecutor } from "../../../src/agent/auxiliary-request-executor.js";
import type { ResponsesClientLike } from "../../../src/agent/react-agent.js";
import { ModelStreamCleanupError } from "../../../src/agent/response-errors.js";
import { LearnedMemoryRuntime, LearnedMemoryStore } from "../../../src/memory/learned-memory.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { createProductionAgent } from "../../../src/runtime/production.js";
import { SessionStore } from "../../../src/storage/session-store.js";

const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const zero = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
const response = () => ({ id: "memory-response", status: "completed", output: [], usage,
  output_text: '{"entries":[{"lesson":"Use pnpm","applyWhen":"Node projects"}]}' });

async function fixture(create: ResponsesClientLike["responses"]["create"], onAdmission?: () => void,
  createStore = (directory: string) => new LearnedMemoryStore({ directory })) {
  const root = await mkdtemp(join(tmpdir(), "everpeace-memory-request-owner-"));
  const auxiliary = new AuxiliaryRequestExecutor();
  const store = createStore(join(root, "memory"));
  const capabilities = resolveProviderCapabilities("https://compatible.invalid/v1", "offline");
  const provider: ProviderRuntime = { sdk: {} as ProviderRuntime["sdk"], capabilities,
    settings: defaultModelRequestSettings(capabilities),
    responses: { create, async stream() { throw new Error("Unexpected coding request"); } },
  };
  const handle = createProductionAgent({
    model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" },
    workspacePath: root, providerRuntime: provider, sessionStore: new SessionStore({ directory: join(root, "sessions") }),
    sessionId: () => undefined, skills: null, mcp: null, codeNavigation: null,
    learnedMemoryStore: store, learnedMemoryPolicy: { captureFuture: false }, memoryIdleDelayMs: 0,
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected shell"); }, writeAssistant() {} },
    runMemoryRequest: (run, context) => { onAdmission?.(); return auxiliary.execute("memory", (signal) => run(signal), context.signal, context.signal, context); },
  });
  assert.ok(handle.learnedMemory instanceof LearnedMemoryRuntime);
  return { root, store, auxiliary, handle, memory: handle.learnedMemory,
    async cleanup(expectedFailure?: Error) {
      try {
        const results = await Promise.allSettled([handle.dispose(), auxiliary.dispose()]);
        for (const result of results) {
          if (expectedFailure) {
            assert.equal(result.status, "rejected");
            if (result.status === "rejected") assert.equal(result.reason, expectedFailure);
          } else if (result.status === "rejected") throw result.reason;
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  };
}

test("production Memory and auxiliary usage agree when a reliable response is cancelled", async () => {
  const controller = new AbortController();
  let requests = 0;
  const owner = await fixture(async () => { requests++; controller.abort(new Error("Command cancelled")); return response(); });
  try {
    await assert.rejects(owner.memory.remember(owner.root, "Use pnpm", controller.signal), /cancelled/iu);
    assert.equal(requests, 1);
    assert.deepEqual((await owner.memory.status(owner.root)).capture?.usage, usage);
    assert.equal(owner.auxiliary.getUsage().input_tokens, 2);
    assert.equal(owner.auxiliary.getUsage().complete, true);
    assert.equal((await owner.store.read("user", owner.root)).length, 0);
  } finally { await owner.cleanup(); }
});

test("cancellation before production auxiliary admission has zero Memory usage", async () => {
  const controller = new AbortController();
  let requests = 0;
  const owner = await fixture(async () => { requests++; return response(); }, () => controller.abort(new Error("Cancelled before provider admission")));
  try {
    await assert.rejects(owner.memory.remember(owner.root, "Use pnpm", controller.signal), /Cancelled before provider admission/u);
    assert.equal(requests, 0);
    assert.deepEqual((await owner.memory.status(owner.root)).capture?.usage, zero);
    assert.equal(owner.auxiliary.getUsage().complete, true);
    assert.equal(owner.auxiliary.getUsage().input_tokens, 0);
  } finally { await owner.cleanup(); }
});

test("a closed auxiliary owner does not manufacture a Memory attempt", async () => {
  let requests = 0;
  const owner = await fixture(async () => { requests++; return response(); });
  try {
    await owner.auxiliary.dispose();
    await assert.rejects(owner.memory.remember(owner.root, "Use pnpm"), /disposed/iu);
    assert.equal(requests, 0);
    assert.deepEqual((await owner.memory.status(owner.root)).capture?.usage, zero);
    assert.equal(owner.auxiliary.getUsage().complete, true);
  } finally { await owner.cleanup(); }
});

test("a prior auxiliary resource fault denies Memory without charging the old response again", async () => {
  const failure = new ModelStreamCleanupError(new Error("Owned reader did not close"), usage);
  let requests = 0;
  const owner = await fixture(async () => { requests++; return response(); });
  try {
    await assert.rejects(owner.auxiliary.execute("title", async () => { throw failure; }), (error: unknown) => error === failure);
    await assert.rejects(owner.memory.remember(owner.root, "Use pnpm"), (error: unknown) => error === failure);
    assert.equal(requests, 0);
    assert.deepEqual((await owner.memory.status(owner.root)).capture?.usage, zero);
    assert.equal(owner.auxiliary.getUsage().complete, true);
    assert.equal(owner.auxiliary.getUsage().input_tokens, 2);
  } finally { await owner.cleanup(failure); }
});

test("a real Memory resource fault is charged once and closes both owners", async () => {
  const failure = new ModelStreamCleanupError(new Error("Memory reader did not close"), usage);
  let requests = 0;
  const owner = await fixture(async () => { requests++; throw failure; });
  try {
    await assert.rejects(owner.memory.remember(owner.root, "Use pnpm"), (error: unknown) => error === failure);
    await assert.rejects(owner.memory.remember(owner.root, "Another preference"), (error: unknown) => error === failure);
    assert.equal(requests, 1);
    assert.deepEqual((await owner.memory.status(owner.root)).capture?.usage, usage);
    assert.equal(owner.auxiliary.getUsage().input_tokens, 2);
    assert.equal(owner.auxiliary.getUsage().complete, true);
    await assert.rejects(owner.auxiliary.execute("doctor", async () => { assert.fail("Faulted owner cannot start a request"); }), (error: unknown) => error === failure);
  } finally { await owner.cleanup(failure); }
});

test("an actual Memory transport failure stays unknown across a later independent preference", async () => {
  let requests = 0;
  const owner = await fixture(async () => { if (++requests === 1) throw new Error("Transport interrupted after admission"); return response(); });
  try {
    await assert.rejects(owner.memory.remember(owner.root, "Use pnpm"), /Transport interrupted/u);
    await owner.memory.remember(owner.root, "Another preference");
    assert.equal(requests, 2);
    assert.equal((await owner.memory.status(owner.root)).capture?.usage, null);
    assert.equal(owner.auxiliary.getUsage().input_tokens, 2);
    assert.equal(owner.auxiliary.getUsage().complete, false);
    assert.equal((await owner.store.read("user", owner.root))[0]?.lesson, "Use pnpm");
  } finally { await owner.cleanup(); }
});

test("background Memory retains settled usage after clear cancels the auxiliary response", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  const owner = await fixture(async () => { requests++; await blocked; return response(); });
  try {
    owner.memory.setPolicy({ captureFuture: true });
    await owner.memory.finishTurn({ workspacePath: owner.root, userInput: "Fix a defect", transcript: "Verified local result", assistantText: "done", toolCallCount: 1 }, "verified");
    for (let attempt = 0; requests === 0 && attempt < 3_000; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(requests, 1);
    await owner.memory.clear("project", owner.root);
    release();
    await owner.memory.dispose();
    assert.deepEqual((await owner.memory.status(owner.root)).capture?.usage, usage);
    assert.equal(owner.auxiliary.getUsage().input_tokens, 2);
    assert.equal(owner.auxiliary.getUsage().complete, true);
    assert.equal((await owner.store.read("project", owner.root)).length, 0);
    assert.equal((await owner.store.loadJobs()).length, 0);
  } finally { release(); await owner.cleanup(); }
});

test("production Memory shares accounting across actual SDK decoding, cancellation, and admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "everpeace-memory-accounting-sdk-"));
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("tests/fixtures/memory-accounting-offline.ts")], {
      cwd: root, timeout: 30_000,
      env: { ...process.env, EVERPEACE_MEMORY_ACCOUNTING_ROOT: root, APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root, CODEX_HOME: join(root, "codex"), XDG_CONFIG_HOME: root, XDG_STATE_HOME: root },
    });
    assert.match(result.stdout, /Production SDK Memory accounting and cancellation passed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pausing capture during an in-progress job claim denies provider admission", async () => {
  let claimed = false, paused = false, release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  class PausedStore extends LearnedMemoryStore {
    override async updateJobs(...args: Parameters<LearnedMemoryStore["updateJobs"]>) {
      const jobs = await super.updateJobs(...args);
      if (!paused && jobs.some((job) => job.status === "running")) { paused = true; claimed = true; await blocked; }
      return jobs;
    }
  }
  let requests = 0;
  const owner = await fixture(async () => { requests++; return response(); }, undefined, (directory) => new PausedStore({ directory }));
  try {
    owner.memory.setPolicy({ captureFuture: true });
    await owner.memory.finishTurn({ workspacePath: owner.root, userInput: "Fix a defect", transcript: "Verified local result", assistantText: "done", toolCallCount: 1 }, "verified");
    for (let attempt = 0; !claimed && attempt < 3_000; attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(claimed, true);
    owner.memory.setPolicy({ captureFuture: false });
    release();
    let settled = false;
    for (let attempt = 0; !settled && attempt < 3_000; attempt++) {
      settled = (await owner.store.loadJobs())[0]?.status === "queued";
      if (!settled) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(settled, true);
    await owner.memory.dispose();
    assert.equal(requests, 0);
    assert.deepEqual((await owner.memory.status(owner.root)).capture?.usage, zero);
    assert.equal(owner.auxiliary.getUsage().complete, true);
    assert.equal((await owner.store.loadJobs())[0]?.requestPending, false);
    assert.equal((await owner.store.loadJobs())[0]?.usageComplete, true);
    assert.equal((await owner.store.read("project", owner.root)).length, 0);
  } finally { release(); await owner.cleanup(); }
});
