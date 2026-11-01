import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { isolateOfflineModelProxy } from "../../fixtures/offline-model-proxy.js";
import { setImmediate } from "node:timers/promises";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { ModelStreamCleanupError } from "../../../src/agent/response-errors.js";
import { createProviderRuntime } from "../../../src/providers/openai-compatible.js";

const terminal = new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [], output_text: "done", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } })}\n\n`);

const offlineProxyRestorations: Array<() => void> = [];
beforeEach(() => { offlineProxyRestorations.push(isolateOfflineModelProxy()); });
afterEach(() => { offlineProxyRestorations.pop()?.(); });

test("production provider joins the response body cancellation after the SDK iterator returns", async (t) => {
  let closing!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { closing = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(terminal); }, cancel() { closing(); return gate; } });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  const provider = createProviderRuntime("https://compatible.invalid/v1", "fixture", undefined, "fixture");
  const controller = new AbortController();
  const stream = await provider.responses.stream({ model: "fixture", input: [] }, { signal: controller.signal, maxRetries: 0 });
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "response.completed");
  let settled = false;
  controller.abort();
  const closed = iterator.return!().then((value) => { settled = true; return value; });
  try { await started; await setImmediate(); assert.equal(settled, false); }
  finally { release(); }
  assert.equal((await closed).done, true);
  assert.equal(body.locked, false);
});

test("production Agent preserves body cancellation failure even when the SDK swallows it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "everpeace-provider-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(terminal); }, async cancel() { throw new Error("body cancellation refused"); } });
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(body, { headers: { "Content-Type": "text/event-stream" } }); });
  const provider = createProviderRuntime("https://compatible.invalid/v1", "fixture", undefined, "fixture");
  const ledger = new RequestAttemptLedger({ tokenBudget: 100 });
  const agent = new ReactAgent({ workspacePath: root, model: "fixture", requestAttemptLedger: ledger,
    client: { responses: {
      create(params, options) { return provider.responses.create(params, { ...options }); },
      stream(params, options) { return provider.responses.stream(params, { ...options }); },
    } },
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected command"); }, writeAssistant() {} },
  });
  await assert.rejects(agent.runTurn("work"), ModelStreamCleanupError);
  assert.equal(ledger.snapshot().complete, true);
  assert.equal(ledger.snapshot().remainingTokens, 97);
  assert.equal(calls, 1);
  assert.equal(body.locked, false);
  await assert.rejects(agent.dispose(), ModelStreamCleanupError);
});

test("external cancellation closes an SDK read already waiting for another event", { timeout: 2000 }, async (t) => {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(terminal); }, cancel() { cancellations++; } });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  const provider = createProviderRuntime("https://compatible.invalid/v1", "fixture", undefined, "fixture");
  const controller = new AbortController();
  const stream = await provider.responses.stream({ model: "fixture", input: [] }, { signal: controller.signal, maxRetries: 0 });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  const waiting = iterator.next();
  await setImmediate();
  controller.abort();
  assert.equal((await waiting).done, true);
  assert.equal(cancellations, 1);
  assert.equal(body.locked, false);
});

test("body cancellation rejection without an Error value still denies closure", async (t) => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(terminal); }, cancel() { return Promise.reject(undefined); } });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
  const provider = createProviderRuntime("https://compatible.invalid/v1", "fixture", undefined, "fixture");
  const controller = new AbortController();
  const stream = await provider.responses.stream({ model: "fixture", input: [] }, { signal: controller.signal, maxRetries: 0 });
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  controller.abort();
  await assert.rejects(iterator.return!(), ModelStreamCleanupError);
  assert.equal(body.locked, false);
});
