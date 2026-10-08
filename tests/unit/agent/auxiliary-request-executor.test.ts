import assert from "node:assert/strict";
import { test } from "node:test";
import { AuxiliaryRequestExecutor } from "../../../src/agent/auxiliary-request-executor.js";
import { RequestUsageIncompleteError } from "../../../src/agent/request-attempt-ledger.js";
import { ModelStreamCleanupError } from "../../../src/agent/response-errors.js";

const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };

test("independent auxiliary operations continue while their lifetime total stays unknown", async () => {
  const executor = new AuxiliaryRequestExecutor();
  await executor.execute("title", async () => ({}));
  for (const purpose of ["skill", "doctor", "memory"] as const) await executor.execute(purpose, async () => ({ usage }));
  const total = executor.getUsage();
  assert.equal(total.complete, false);
  assert.equal(total.input_tokens, 6);
  assert.equal(total.output_tokens, 3);
});

test("a Memory job cannot request consolidation after unknown usage, while the next job is independent", async () => {
  const executor = new AuxiliaryRequestExecutor();
  const firstJob = new AbortController();
  await executor.execute("memory", async () => ({}), firstJob.signal);
  let requests = 0;
  await assert.rejects(executor.execute("memory", async () => { requests++; return { usage }; }, firstJob.signal), RequestUsageIncompleteError);
  assert.equal(requests, 0);
  assert.equal(executor.getUsage().input_tokens, 0);
  await executor.execute("memory", async () => { requests++; return { usage }; }, new AbortController().signal);
  assert.equal(requests, 1);
  assert.equal(executor.getUsage().input_tokens, 2);
  assert.equal(executor.getUsage().complete, false);
});

test("overlapping auxiliary requests account once regardless of settlement order", async () => {
  const executor = new AuxiliaryRequestExecutor();
  const job = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const first = executor.execute("memory", async () => { await blocked; return {}; }, job.signal);
  await executor.execute("memory", async () => ({ usage }), job.signal);
  release();
  await first;
  await executor.execute("title", async () => ({ usage }));
  assert.equal(executor.getUsage().input_tokens, 4);
  assert.equal(executor.getUsage().output_tokens, 2);
  assert.equal(executor.getUsage().complete, false);
});

test("pre-cancelled auxiliary scopes do not start or manufacture an unknown sample", async () => {
  const executor = new AuxiliaryRequestExecutor();
  const scope = new AbortController();
  const reason = new Error("Cancelled before the request");
  scope.abort(reason);
  await assert.rejects(executor.execute("memory", async () => { assert.fail("No request may start"); }, scope.signal), (error) => error === reason);
  assert.equal(executor.getUsage().complete, true);
  assert.equal(executor.getUsage().input_tokens, 0);
});

test("resource failure denies every later auxiliary operation while retaining reliable billing", async () => {
  const executor = new AuxiliaryRequestExecutor();
  const failure = new ModelStreamCleanupError(new Error("connection timeout during cleanup"), usage);
  await assert.rejects(executor.execute("memory", async () => { throw failure; }, new AbortController().signal), (error) => error === failure);
  for (const purpose of ["title", "skill", "doctor", "memory"] as const) {
    await assert.rejects(executor.execute(purpose, async () => { assert.fail("Faulted owner cannot request"); }, new AbortController().signal), (error) => error === failure);
  }
  assert.equal(executor.getUsage().complete, true);
  assert.equal(executor.getUsage().input_tokens, 2);
  assert.equal(executor.getUsage().output_tokens, 1);
});

test("auxiliary disposal cancels and joins an admitted request before closing the owner", async () => {
  const executor = new AuxiliaryRequestExecutor();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let signal: AbortSignal | undefined;
  const request = executor.execute("title", async (requestSignal) => { signal = requestSignal; entered(); await blocked; requestSignal.throwIfAborted(); return { usage }; });
  const rejected = assert.rejects(request, /disposed/iu);
  await ready;
  let disposed = false;
  const first = executor.dispose(), second = executor.dispose();
  assert.equal(first, second);
  const completion = first.then(() => { disposed = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(signal?.aborted, true);
    await assert.rejects(executor.execute("doctor", async () => { assert.fail("Closed owner cannot start"); }), /disposed/iu);
  } finally { release(); await rejected; await completion; }
  assert.equal(executor.getUsage().complete, false);
});

test("reentrant disposal sees a request before its callback runs and preserves returned reliable usage", async () => {
  const executor = new AuxiliaryRequestExecutor();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let disposed = false;
  const request = executor.execute("skill", async (signal) => {
    void executor.dispose().then(() => { disposed = true; });
    assert.equal(signal.aborted, true);
    entered();
    await blocked;
    return { usage };
  });
  const rejected = assert.rejects(request, /disposed/iu);
  await ready;
  try { assert.equal(disposed, false); }
  finally { release(); await rejected; await executor.dispose(); }
  assert.equal(executor.getUsage().complete, true);
  assert.equal(executor.getUsage().input_tokens, 2);
});
