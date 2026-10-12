import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ReactAgent, type AgentIO, type AgentResponse } from "../../../src/agent/react-agent.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { PersistenceError } from "../../../src/storage/persistence-error.js";
import { GoalRuntime } from "../../../src/goal/runtime.js";
import { SessionStore, type SessionGoal } from "../../../src/storage/session-store.js";
import { applyUsageSample, createEmptySessionUsage, type TokenUsageSample } from "../../../src/status/model-status.js";

const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const io: AgentIO = { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected command"); }, writeAssistant() {} };
const done = (): AgentResponse => ({ id: "done", status: "completed", output: [], output_text: "done", usage });

async function fixture(t: TestContext, tokenBudget?: number) {
  const root = await mkdtemp(join(tmpdir(), "everpeace-request-settlement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let goal: SessionGoal | undefined;
  const runtime = new GoalRuntime({ async getGoal() { return goal; }, async setGoal(value) { goal = value; } });
  await runtime.create({ objective: "Complete the task", ...(tokenBudget ? { tokenBudget } : {}) });
  return { root, runtime, goal: () => goal! };
}

test("successful stream recovery preserves the interrupted attempt as unknown", async (t) => {
  const f = await fixture(t);
  const samples: Array<TokenUsageSample | null> = [];
  let requests = 0, resumes = 0;
  const agent = new ReactAgent({ workspacePath: f.root, model: "offline", goalRuntime: f.runtime, io,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      async *stream() { requests++; yield { type: "response.output_text.delta", delta: "partial" }; throw new Error("connection interrupted"); },
      recovery: { async resume() { resumes++; assert.equal(f.goal().usage_complete, false); return done(); } },
    } },
    async onUsage(sample) { samples.push(sample); },
  });
  await agent.runTurn("work");
  assert.deepEqual(samples, [null, usage]);
  assert.equal(f.goal().tokens_used, 3);
  assert.equal(f.goal().usage_complete, false);
  assert.equal(requests, 1);
  assert.equal(resumes, 1);
  const aggregate = samples.reduce(applyUsageSample, createEmptySessionUsage());
  assert.equal(aggregate.complete, false);
  assert.equal(aggregate.input_tokens, 2);
  await agent.dispose();
});

test("bounded Goal stops before recovering an attempt with unknown usage", async (t) => {
  const f = await fixture(t, 100);
  const samples: Array<TokenUsageSample | null> = [];
  let requests = 0, resumes = 0;
  const agent = new ReactAgent({ workspacePath: f.root, model: "offline", goalRuntime: f.runtime, io,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      async *stream() { requests++; yield { type: "response.output_text.delta", delta: "partial" }; throw new Error("connection interrupted"); },
      recovery: { async resume() { resumes++; return done(); } },
    } },
    async onUsage(sample) { samples.push(sample); },
  });
  const result = await agent.runTurn("work");
  assert.equal(result.stopReason, "usage_limited");
  assert.equal(f.goal().status, "usage_limited");
  assert.deepEqual(samples, [null]);
  assert.equal(requests, 1);
  assert.equal(resumes, 0);
  await agent.dispose();
});

test("ledger stop still persists the failed attempt in Goal and Session", async (t) => {
  const f = await fixture(t, 100);
  const store = new SessionStore({ directory: join(f.root, "sessions") });
  const session = await store.create({ title: "fixture", titlePending: false, workspacePath: f.root, model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1" } });
  const ledger = new RequestAttemptLedger({ tokenBudget: 100 });
  let requests = 0;
  const agent = new ReactAgent({ workspacePath: f.root, model: "offline", goalRuntime: f.runtime, requestAttemptLedger: ledger, io,
    client: { responses: { async create() { requests++; throw new Error("connection interrupted"); } } },
    async onUsage(sample) { await store.appendUsage(session.id, sample); },
  });
  const result = await agent.runTurn("work");
  assert.equal(result.stopReason, "usage_limited");
  assert.equal(f.goal().status, "usage_limited");
  assert.equal((await store.load(session.id)).usage.complete, false);
  assert.equal(ledger.snapshot().complete, false);
  assert.equal(requests, 1);
  await agent.dispose();
});

test("recovery failure and sampling retry each settle their own usage", async (t) => {
  const f = await fixture(t);
  const samples: Array<TokenUsageSample | null> = [];
  let requests = 0, resumes = 0;
  const agent = new ReactAgent({ workspacePath: f.root, model: "offline", goalRuntime: f.runtime, io, samplingRetryBudget: 1,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      async *stream() {
        if (++requests === 1) { yield { type: "response.output_text.delta", delta: "partial" }; throw new Error("connection interrupted"); }
        yield { type: "response.completed", response: done() };
      },
      recovery: { async resume() { resumes++; throw new Error("recovery unavailable"); } },
    } },
    async onUsage(sample) { samples.push(sample); },
  });
  await agent.runTurn("work");
  assert.deepEqual(samples, [null, null, usage]);
  assert.equal(f.goal().usage_complete, false);
  assert.equal(f.goal().tokens_used, 3);
  assert.equal(requests, 2);
  assert.equal(resumes, 1);
  await agent.dispose();
});

test("a failed terminal recovery retains its known usage before sampling retry", async (t) => {
  const f = await fixture(t);
  const samples: Array<TokenUsageSample | null> = [];
  let requests = 0;
  const agent = new ReactAgent({ workspacePath: f.root, model: "offline", goalRuntime: f.runtime, io, samplingRetryBudget: 1,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      async *stream() {
        if (++requests === 1) { yield { type: "response.output_text.delta", delta: "partial" }; throw new Error("connection interrupted"); }
        yield { type: "response.completed", response: done() };
      },
      recovery: { async resume() { return { ...done(), status: "failed", error: { code: "server_error" } }; } },
    } },
    async onUsage(sample) { samples.push(sample); },
  });
  await agent.runTurn("work");
  assert.deepEqual(samples, [null, usage, usage]);
  assert.equal(f.goal().tokens_used, 6);
  assert.equal(f.goal().usage_complete, false);
  await agent.dispose();
});

test("bounded Goal prevents native compaction fallback after unknown usage", async (t) => {
  const f = await fixture(t, 100);
  let compacts = 0, requests = 0;
  const samples: Array<TokenUsageSample | null> = [];
  const agent = new ReactAgent({ workspacePath: f.root, model: "gpt-5.6", goalRuntime: f.runtime, io,
    initialHistory: [{ role: "user", content: "prior context" }], contextWindow: 100, initialContextTokens: 90,
    promptCacheKey: "fixture", promptCacheOptions: { mode: "implicit", ttl: "30m" },
    client: { responses: {
      async create() { requests++; return done(); },
      async compact() {
        compacts++;
        if (compacts === 1) throw Object.assign(new Error("prompt_cache_options unsupported"), { status: 400, param: "prompt_cache_options" });
        return { output: [{ type: "compaction", encrypted_content: "fixture" }], usage };
      },
    } },
    async onUsage(sample) { samples.push(sample); },
  });
  const result = await agent.runTurn("work");
  assert.equal(result.stopReason, "usage_limited");
  assert.equal(f.goal().status, "usage_limited");
  assert.equal(compacts, 1);
  assert.equal(requests, 0);
  assert.deepEqual(samples, [null]);
  await agent.dispose();
});

test("compaction fallback preserves sticky unknown usage without charging the final sample twice", async (t) => {
  const f = await fixture(t);
  const store = new SessionStore({ directory: join(f.root, "sessions") });
  const session = await store.create({ title: "fixture", titlePending: false, workspacePath: f.root, model: { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1" } });
  const samples: Array<TokenUsageSample | null> = [];
  let compacts = 0, requests = 0;
  const agent = new ReactAgent({ workspacePath: f.root, model: "gpt-5.6", goalRuntime: f.runtime, io,
    initialHistory: [{ role: "user", content: "prior context" }], contextWindow: 100, initialContextTokens: 90,
    promptCacheKey: "fixture", promptCacheOptions: { mode: "implicit", ttl: "30m" },
    client: { responses: {
      async create() {
        requests++;
        assert.equal(f.goal().tokens_used, 3);
        assert.equal(f.goal().usage_complete, false);
        return done();
      },
      async compact() {
        if (++compacts === 1) throw Object.assign(new Error("prompt_cache_options unsupported"), { status: 400, param: "prompt_cache_options" });
        assert.equal(f.goal().usage_complete, false);
        return { output: [{ type: "compaction", encrypted_content: "fixture" }], usage };
      },
    } },
    async onUsage(sample) { samples.push(sample); await store.appendUsage(session.id, sample); },
    async onContextCompacted(items, automatic, sample) { await store.compactContext(session.id, items, automatic, sample); },
  });
  await agent.runTurn("work");
  assert.equal(compacts, 2);
  assert.equal(requests, 1);
  assert.deepEqual(samples, [null, usage]);
  assert.equal(f.goal().tokens_used, 6);
  assert.equal(f.goal().usage_complete, false);
  const loaded = await store.load(session.id);
  assert.equal(loaded.usage.input_tokens, 4);
  assert.equal(loaded.usage.output_tokens, 2);
  assert.equal(loaded.usage.complete, false);
  await agent.dispose();
});

test("usage persistence failure during steering remains fatal without another request or usage sample", async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const samples: Array<TokenUsageSample | null> = [];
  const agent = new ReactAgent({ workspacePath: f.root, model: "offline", io,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      async *stream() { requests++; yield { type: "response.completed", response: done() }; },
    } },
    async onUsage(sample) {
      samples.push(sample);
      agent.requestSteering("continue after this request");
      throw new Error("network storage timeout");
    },
  });
  await assert.rejects(agent.runTurn("work"), PersistenceError);
  assert.equal(requests, 1);
  assert.deepEqual(samples, [usage]);
  await agent.dispose();
});
