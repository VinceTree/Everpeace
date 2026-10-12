import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ReactAgent, type AgentResponse, type ResponseStreamLike } from "../../../src/agent/react-agent.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import type { TokenUsageSample } from "../../../src/status/model-status.js";

const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const terminal = (output: AgentResponse["output"] = []) => ({
  type: "response.completed",
  response: { id: "terminal", status: "completed", output_text: "done", output, usage },
});
const call = { type: "function_call", name: "bash", call_id: "command", arguments: '{"command":"fixture"}' };
const cleanupError = (error: unknown) => error instanceof Error && error.name === "ModelStreamCleanupError";

function controlled(next: AsyncIterator<Record<string, unknown>>["next"], close?: AsyncIterator<Record<string, unknown>>["return"]): ResponseStreamLike {
  return { [Symbol.asyncIterator]() { return { next, ...(close ? { return: close } : {}) }; } };
}

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "everpeace-stream-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("completed stream cleanup failure prevents tools and retains reliable usage", async (t) => {
  const root = await workspace(t);
  const ledger = new RequestAttemptLedger({ tokenBudget: 100 });
  const samples: Array<TokenUsageSample | null> = [];
  const history: Array<Record<string, unknown>> = [];
  let requests = 0, commands = 0;
  const agent = new ReactAgent({
    workspacePath: root, model: "offline-stream", requestAttemptLedger: ledger,
    client: { responses: {
      async create() { throw new Error("Unexpected buffered fallback"); },
      stream() {
        requests++;
        return controlled(async () => ({ done: false, value: terminal([call]) }), async () => { throw new Error("connection cleanup refused"); });
      },
    } },
    async onUsage(sample) { samples.push(sample); },
    async onHistoryAppend(items) { history.push(...items); },
    io: { async confirmBash() { return true; }, async runBash() { commands++; return { stdout: "", stderr: "", exitCode: 0, signal: null }; }, writeAssistant() {} },
    samplingRetryBudget: 0,
  });
  await assert.rejects(agent.runTurn("run"), cleanupError);
  assert.equal(commands, 0);
  assert.equal(requests, 1);
  assert.deepEqual(samples, [usage]);
  assert.equal(history.some((item) => item.type === "function_call"), false);
  assert.deepEqual(ledger.snapshot().attempts.map((attempt) => attempt.status), ["failed"]);
  assert.equal(ledger.snapshot().complete, true, "cleanup failure must not erase reliable billing");
  assert.equal(ledger.snapshot().remainingTokens, 97);
  await assert.rejects(agent.runTurn("retry"), cleanupError);
  await assert.rejects(agent.beginTask({ mode: "default", source: "user" }), cleanupError);
  await assert.rejects(agent.dispose(), cleanupError);
  assert.equal(requests, 1);
});

test("interrupted stream cleanup failure forbids recovery and sampling retry", async (t) => {
  let requests = 0, resumes = 0, nextCalls = 0;
  const agent = new ReactAgent({
    workspacePath: await workspace(t), model: "offline-stream",
    samplingRetryBudget: 1, streamRecoveryBudget: 1,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      stream() {
        requests++;
        return controlled(async () => {
          if (++nextCalls === 1) return { done: false, value: { type: "response.output_text.delta", delta: "partial" } };
          throw new Error("connection interrupted");
        }, async () => { throw new Error("connection cleanup refused"); });
      },
      recovery: { async resume() { resumes++; return { id: "recovery", output: [], output_text: "done" }; } },
    } },
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected tool"); }, writeAssistant() {} },
  });
  await assert.rejects(agent.runTurn("run"), cleanupError);
  assert.equal(requests, 1);
  assert.equal(resumes, 0);
  await assert.rejects(agent.dispose(), cleanupError);
});

for (const kind of ["not_done", "missing_return"] as const) {
  test(`terminal stream requires confirmed closure: ${kind}`, async (t) => {
    const agent = new ReactAgent({
      workspacePath: await workspace(t), model: "offline-stream", samplingRetryBudget: 0,
      client: { responses: {
        async create() { throw new Error("Unexpected fallback"); },
        stream() { return controlled(async () => ({ done: false, value: terminal() }), kind === "not_done" ? async () => ({ done: false, value: {} }) : undefined); },
      } },
      io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected tool"); }, writeAssistant() {} },
    });
    await assert.rejects(agent.runTurn("run"), cleanupError);
    await assert.rejects(agent.dispose(), cleanupError);
  });
}

test("recovered stream stays open until consumption and joined cleanup finish", async (t) => {
  let requests = 0, resumes = 0, closed = false;
  const agent = new ReactAgent({
    workspacePath: await workspace(t), model: "offline-stream", samplingRetryBudget: 0, streamRecoveryBudget: 1,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      async *stream() { requests++; yield { type: "response.output_text.delta", delta: "partial" }; throw new Error("connection interrupted"); },
      recovery: { async resume(_params, _state, options) {
        resumes++;
        return controlled(async () => {
          await Promise.resolve();
          assert.equal(options?.signal?.aborted, false, "recovery signal was aborted before its stream settled");
          return { done: false, value: terminal() };
        }, async () => {
          assert.equal(options?.signal?.aborted, true);
          closed = true;
          return { done: true, value: undefined };
        });
      } },
    } },
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected tool"); }, writeAssistant() {} },
  });
  const result = await agent.runTurn("recover");
  assert.equal(result.stopReason, undefined);
  assert.equal(closed, true);
  assert.equal(requests, 1);
  assert.equal(resumes, 1);
  await agent.dispose();
});

test("recovery cleanup failure takes priority over the original interruption", async (t) => {
  let requests = 0, resumes = 0;
  const agent = new ReactAgent({
    workspacePath: await workspace(t), model: "offline-stream", samplingRetryBudget: 1, streamRecoveryBudget: 1,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      async *stream() { requests++; yield { type: "response.output_text.delta", delta: "partial" }; throw new Error("original connection interruption"); },
      recovery: { async resume() {
        resumes++;
        return controlled(async () => ({ done: false, value: terminal() }), async () => { throw new Error("recovery cleanup refused"); });
      } },
    } },
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected tool"); }, writeAssistant() {} },
  });
  await assert.rejects(agent.runTurn("recover"), (error) => cleanupError(error) && /recovery cleanup refused/.test(String(error)));
  assert.equal(requests, 1);
  assert.equal(resumes, 1);
  await assert.rejects(agent.dispose(), cleanupError);
});

test("stream cleanup failure during cancellation remains fatal", async (t) => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const agent = new ReactAgent({
    workspacePath: await workspace(t), model: "offline-stream", samplingRetryBudget: 0,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      stream(_params, options) {
        return controlled(() => new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          started();
        }), async () => { throw new Error("cancel cleanup refused"); });
      },
    } },
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected tool"); }, writeAssistant() {} },
  });
  const turn = agent.runTurn("cancel", controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(turn, cleanupError);
  await assert.rejects(agent.dispose(), cleanupError);
});

test("tools wait for stream closure before dispatch", async (t) => {
  let closing!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { closing = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0, commands = 0;
  const agent = new ReactAgent({
    workspacePath: await workspace(t), model: "offline-stream",
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      stream() {
        requests++;
        const output = requests === 1 ? [call] : [];
        return controlled(async () => ({ done: false, value: terminal(output) }), async () => {
          if (output.length) { closing(); await gate; }
          return { done: true, value: undefined };
        });
      },
    } },
    io: { async confirmBash() { return true; }, async runBash() { commands++; return { stdout: "", stderr: "", exitCode: 0, signal: null }; }, writeAssistant() {} },
  });
  const turn = agent.runTurn("run");
  try { await started; assert.equal(commands, 0); assert.equal(requests, 1); }
  finally { release(); }
  await turn;
  assert.equal(commands, 1);
  assert.equal(requests, 2);
  await agent.dispose();
});

test("idle stream joins a pending next even when return confirms done first", async (t) => {
  let closing!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { closing = resolve; });
  const pending = new Promise<IteratorResult<Record<string, unknown>>>((resolve) => { release = () => resolve({ done: true, value: undefined }); });
  let settled = false;
  const agent = new ReactAgent({
    workspacePath: await workspace(t), model: "offline-stream", samplingRetryBudget: 0, streamIdleTimeoutMs: 10,
    client: { responses: {
      async create() { throw new Error("Unexpected fallback"); },
      stream() { return controlled(() => pending, async () => { closing(); return { done: true, value: undefined }; }); },
    } },
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected tool"); }, writeAssistant() {} },
  });
  const turn = agent.runTurn("idle");
  const rejected = assert.rejects(turn, /stream was idle/);
  void turn.then(() => { settled = true; }, () => { settled = true; });
  try { await started; await setImmediate(); assert.equal(settled, false); }
  finally { release(); }
  await rejected;
  await agent.dispose();
});
