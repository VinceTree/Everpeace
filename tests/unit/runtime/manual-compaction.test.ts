import assert from "node:assert/strict";
import { SENSITIVE_CONTEXT_MARKER } from '../../../src/permissions/sensitive-access.js';
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createProductionAgent } from "../../../src/runtime/production.js";
import { GoalRuntime } from "../../../src/goal/runtime.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { LoopStoppedError } from "../../../src/agent/agent-loop.js";
import { ModelStreamCleanupError } from "../../../src/agent/response-errors.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { checkpointText } from "../../fixtures/conversation-checkpoint.js";

const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const compacted = [{ type: "compaction", encrypted_content: "offline" }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext, options: { native?: boolean; ledger?: boolean; tokenBudget?: number; afterCompactionPersist?(): Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "everpeace-manual-compaction-"));
  const native = options.native !== false;
  const model = { id: "offline", model_name: native ? "gpt-5.6" : "offline-ds", base_url: native ? "https://api.openai.com/v1" : "https://api.deepseek.com", api_key: "fixture" };
  const capabilities = resolveProviderCapabilities(model.base_url, model.model_name);
  const store = new SessionStore({ directory: join(root, "sessions") });
  const session = await store.create({ title: "compaction fixture", titlePending: false, workspacePath: root, model: { id: model.id, model_name: model.model_name, base_url: model.base_url } });
  const initialHistory = [
    { role: "user", content: `Original constraints ${"evidence ".repeat(1_000)}` },
    { role: "assistant", content: "first diagnosis" },
    { role: "user", content: "keep the public API" },
    { role: "assistant", content: "second diagnosis" },
    { role: "user", content: "continue" },
  ];
  await store.appendContext(session.id, initialHistory);
  const goal = new GoalRuntime({ async getGoal() { return (await store.load(session.id)).goal; }, async setGoal(value) { await store.setGoal(session.id, value); } });
  await goal.create({ objective: "Fix the code", tokenBudget: options.tokenBudget ?? 100 });
  let coding = 0, summaries = 0, landed = 0;
  const summaryRequests: Record<string, unknown>[] = [];
  const provider: ProviderRuntime = {
    sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities),
    responses: {
      async create(params) {
        summaryRequests.push(structuredClone(params));
        assert.equal(params.tool_choice, "none");
        summaries++;
        return { id: "summary", status: "completed", output: [], output_text: checkpointText(), usage };
      },
      async stream() { coding++; return (async function* () { yield { type: "response.completed", response: { id: "coding", status: "completed", output: [], output_text: "done", usage } }; })(); },
      ...(native ? { async compact(params: Record<string, unknown>) { summaryRequests.push(structuredClone(params)); summaries++; return { output: compacted, usage }; } } : {}),
    },
  };
  const handle = createProductionAgent({ model, workspacePath: root, providerRuntime: provider,
    sessionStore: store, sessionId: () => session.id, skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null,
    ...(options.ledger === false ? {} : { requestAttemptLedger: new RequestAttemptLedger() }),
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected shell"); }, writeAssistant() {},
      async getGoal() { return (await store.load(session.id)).goal; }, async setGoal(value) { await store.setGoal(session.id, value); } },
    restore: { initialHistory,
      async onHistoryAppend(items) { await store.appendContext(session.id, items); },
      async onUsage(sample) { await store.appendUsage(session.id, sample); },
      async onContextCompacted(items, automatic, sample) { landed++; await store.compactContext(session.id, items, automatic, sample); await options.afterCompactionPersist?.(); },
    },
  });
  let cleanupFailure: Error | undefined;
  t.after(async () => {
    try {
      if (cleanupFailure) await assert.rejects(handle.dispose(), (error) => error === cleanupFailure);
      else await handle.dispose();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  return { handle, provider, store, session, goal, summaryRequests, counts: () => ({ coding, summaries, landed }), expectCleanupFailure(value: Error) { cleanupFailure = value; } };
}

test("native and summary compaction receive the current full objective without advancing blocker turns", async (t) => {
  for (const native of [true, false]) for (const status of ["active", "paused"] as const) await t.test(`${native ? "native" : "DeepSeek"} ${status}`, async (t) => {
    const f = await fixture(t, { native });
    if (status === "paused") await f.goal.update("paused");
    const turnId = (await f.goal.get())?.goal_turn_id;
    await f.handle.agent.compact();
    const request = f.summaryRequests[0]!;
    const text = [request.instructions,
      ...(Array.isArray(request.input) ? request.input.map((item: Record<string, unknown>) => item.content) : [])].filter(value => typeof value === "string").join("\n");
    assert.ok(text.includes('"objective":"Fix the code"'));
    assert.ok(text.includes(`"status":"${status}"`));
    if (status === "active") assert.match(text, /full-objective audit/u);
    else assert.doesNotMatch(text, /Call update_goal with complete only/u);
    assert.equal((await f.goal.get())?.status, status);
    assert.equal((await f.goal.get())?.goal_turn_id, turnId);
  });
});

test("manual native and DeepSeek compaction charge the active Goal and persisted Session exactly once", async (t) => {
  for (const native of [true, false]) await t.test(native ? "native" : "DeepSeek", async (t) => {
    const f = await fixture(t, { native });
    await f.handle.agent.compact();
    assert.equal((await f.goal.get())?.tokens_used, 3);
    assert.equal((await f.store.load(f.session.id)).usage.input_tokens, 2);
    await f.handle.agent.runTurn("check the retained context");
    const loaded = await f.store.load(f.session.id);
    assert.equal(loaded.goal?.tokens_used, 6);
    assert.equal(loaded.usage.input_tokens, 4);
    assert.equal(loaded.usage.output_tokens, 2);
    assert.equal(loaded.usage.complete, true);
    assert.deepEqual(f.counts(), { coding: 1, summaries: 1, landed: 1 });
  });
});

test("manual compaction stops unknown usage before capability fallback even without a task ledger", async (t) => {
  const f = await fixture(t, { ledger: false });
  let requests = 0;
  f.provider.responses.compact = async () => {
    if (++requests === 1) throw Object.assign(new Error("prompt_cache_options unsupported"), { status: 400, param: "prompt_cache_options" });
    return { output: compacted, usage };
  };
  await assert.rejects(f.handle.agent.compact(), (error) => error instanceof LoopStoppedError && error.reason === "usage_limited");
  const loaded = await f.store.load(f.session.id);
  assert.equal(loaded.goal?.status, "usage_limited");
  assert.equal(loaded.usage.complete, false);
  assert.match(JSON.stringify(loaded.context), /Original constraints/u);
  await assert.rejects(f.handle.agent.compact(), (error) => error instanceof LoopStoppedError && error.reason === "usage_limited");
  assert.equal(requests, 1);
  assert.equal(f.counts().landed, 0);
});

test("pre-cancelled manual compaction does not request a model or mutate usage and context", async (t) => {
  const f = await fixture(t);
  const before = await f.store.load(f.session.id);
  const controller = new AbortController();
  const reason = new Error("User cancelled before compaction");
  controller.abort(reason);
  await assert.rejects(f.handle.agent.compact(controller.signal), (error) => error === reason);
  assert.equal(f.counts().summaries, 0);
  const after = await f.store.load(f.session.id);
  assert.deepEqual(after.context, before.context);
  assert.deepEqual(after.usage, before.usage);
  assert.deepEqual(after.goal, before.goal);
});

test("manual compaction keeps turns, task resets and settings out until it settles", async (t) => {
  const f = await fixture(t, { ledger: false });
  const entered = deferred<void>(), release = deferred<void>();
  f.provider.responses.compact = async () => { entered.resolve(); await release.promise; return { output: compacted, usage }; };
  const running = f.handle.agent.compact();
  try {
    await entered.promise;
    await assert.rejects(f.handle.agent.runTurn("overlapping task"), /compaction/iu);
    await assert.rejects(f.handle.agent.beginTask({ mode: "default", source: "user" }), /compaction/iu);
    assert.throws(() => f.handle.agent.setRequestSettings(f.provider.settings), /compaction/iu);
    assert.equal(f.handle.agent.requestSteering("overlap"), false);
    await assert.rejects(f.handle.agent.compact(), /compaction/iu);
    assert.equal(f.counts().coding, 0);
  } finally { release.resolve(); await running; }
  await f.handle.agent.runTurn("after compaction");
  assert.equal(f.counts().coding, 1);
});

test("production disposal cancels and waits for manual compaction before releasing ownership", async (t) => {
  const f = await fixture(t);
  const entered = deferred<void>(), release = deferred<void>();
  let requestSignal: AbortSignal | undefined;
  f.provider.responses.compact = async (_params, options) => {
    requestSignal = options?.signal instanceof AbortSignal ? options.signal : undefined;
    entered.resolve();
    await release.promise;
    requestSignal?.throwIfAborted();
    return { output: compacted, usage };
  };
  const running = f.handle.agent.compact();
  const rejected = running.then(() => false, () => true);
  await entered.promise;
  let disposed = false;
  const disposal = f.handle.dispose().then(() => { disposed = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(requestSignal?.aborted, true);
    await assert.rejects(f.handle.agent.runTurn("after disposal"), /disposed/iu);
  } finally { release.resolve(); await rejected; await disposal; }
  assert.equal(await rejected, true);
  assert.equal(f.counts().landed, 0);
  await assert.rejects(f.handle.agent.compact(), /disposed/iu);
});

test("production disposal also cancels and joins an active coding request", async (t) => {
  const f = await fixture(t);
  const entered = deferred<void>(), release = deferred<void>();
  let requestSignal: AbortSignal | undefined;
  f.provider.responses.stream = async (_params, options) => {
    requestSignal = options?.signal instanceof AbortSignal ? options.signal : undefined;
    return (async function* () {
      entered.resolve();
      await release.promise;
      requestSignal?.throwIfAborted();
      yield { type: "response.completed", response: { id: "done", output: [], output_text: "done", usage } };
    })();
  };
  const running = f.handle.agent.runTurn("waiting request");
  const rejected = running.then(() => false, () => true);
  await entered.promise;
  let disposed = false;
  const disposal = f.handle.dispose().then(() => { disposed = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(requestSignal?.aborted, true);
  } finally { release.resolve(); await rejected; await disposal; }
  assert.equal(await rejected, true);
  await assert.rejects(f.handle.agent.runTurn("another request"), /disposed/iu);
});

test("manual compaction resource failure remains fatal for disposal and future operations", async (t) => {
  const f = await fixture(t);
  const failure = new ModelStreamCleanupError(new Error("request ownership unresolved"), usage);
  f.expectCleanupFailure(failure);
  f.provider.responses.compact = async () => { throw failure; };
  await assert.rejects(f.handle.agent.compact(), (error) => error === failure);
  assert.equal((await f.goal.get())?.tokens_used, 3);
  assert.equal((await f.store.load(f.session.id)).usage.input_tokens, 2);
  await assert.rejects(f.handle.agent.runTurn("another request"), (error) => error === failure);
});

test("known manual compaction usage exhausts the Goal and stops another compaction before admission", async (t) => {
  const f = await fixture(t, { tokenBudget: 3 });
  await f.handle.agent.compact();
  assert.equal((await f.goal.get())?.status, "budget_limited");
  await assert.rejects(f.handle.agent.compact(), (error) => error instanceof LoopStoppedError && error.reason === "budget_limited");
  assert.deepEqual(f.counts(), { coding: 0, summaries: 1, landed: 1 });
  const loaded = await f.store.load(f.session.id);
  assert.equal(loaded.usage.complete, true);
  assert.equal(loaded.usage.input_tokens, 2);
});

test("cancellation during durable context persistence cannot report compaction success or duplicate usage", async (t) => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture(t, { async afterCompactionPersist() { entered.resolve(); await release.promise; } });
  const controller = new AbortController();
  const reason = new Error("Cancelled while persisting context");
  const running = f.handle.agent.compact(controller.signal);
  const rejected = assert.rejects(running, (error) => error === reason);
  await entered.promise;
  controller.abort(reason);
  let disposed = false;
  const disposal = f.handle.dispose().then(() => { disposed = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
  } finally { release.resolve(); await rejected; await disposal; }
  const loaded = await f.store.load(f.session.id);
  assert.deepEqual(loaded.context.filter(item => item.content !== SENSITIVE_CONTEXT_MARKER), compacted);
  assert.ok(loaded.context.some(item => item.content === SENSITIVE_CONTEXT_MARKER));
  assert.equal(loaded.usage.input_tokens, 2);
  assert.equal(loaded.usage.output_tokens, 1);
  assert.equal(loaded.usage.complete, true);
  assert.equal(loaded.goal?.tokens_used, 3);
});
