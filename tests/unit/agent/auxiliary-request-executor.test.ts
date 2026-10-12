import assert from "node:assert/strict";
import { test } from "node:test";
import { AuxiliaryRequestExecutor } from "../../../src/agent/auxiliary-request-executor.js";
import { RequestAttemptLedger, RequestUsageIncompleteError } from "../../../src/agent/request-attempt-ledger.js";
import { RequestExecutor } from "../../../src/agent/request-executor.js";
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

test("shared Memory accounting retains a reliable sample when auxiliary cancellation rejects the result", async () => {
  const auxiliary = new AuxiliaryRequestExecutor();
  const ledger = new RequestAttemptLedger();
  const accounting = { ledger, executor: new RequestExecutor(ledger) };
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(auxiliary.execute("memory", async () => {
    requests++;
    controller.abort(new Error("Cancelled after the response"));
    return { usage };
  }, controller.signal, controller.signal, accounting), /Cancelled after the response/u);
  assert.equal(requests, 1);
  assert.equal(ledger.snapshot().attempts.length, 1);
  assert.equal(ledger.snapshot().complete, true);
  assert.equal(ledger.snapshot().inputTokens, 2);
  assert.equal(auxiliary.getUsage().input_tokens, 2);
  assert.equal(auxiliary.getUsage().complete, true);
  await auxiliary.dispose();
});

test("shared Memory accounting starts only after the auxiliary owner admits its callback", async () => {
  const auxiliary = new AuxiliaryRequestExecutor();
  const ledger = new RequestAttemptLedger();
  const accounting = { ledger, executor: new RequestExecutor(ledger) };
  const controller = new AbortController();
  const request = auxiliary.execute("memory", async () => { assert.fail("Cancelled provider cannot start"); }, controller.signal, controller.signal, accounting);
  const rejected = assert.rejects(request, /Cancelled before callback/u);
  controller.abort(new Error("Cancelled before callback"));
  await rejected;
  assert.equal(ledger.snapshot().attempts.length, 0);
  assert.equal(ledger.snapshot().complete, true);
  assert.equal(auxiliary.getUsage().complete, true);
  await auxiliary.dispose();
});

test("shared accounting enforces its original budget and records each sample once across signals", async () => {
  const auxiliary = new AuxiliaryRequestExecutor();
  const ledger = new RequestAttemptLedger({ tokenBudget: 3 });
  const accounting = { ledger, executor: new RequestExecutor(ledger) };
  let requests = 0;
  await auxiliary.execute("memory", async () => { requests++; return { usage }; }, new AbortController().signal, undefined, accounting);
  await assert.rejects(auxiliary.execute("memory", async () => { requests++; return { usage }; }, new AbortController().signal, undefined, accounting), /budget is exhausted/u);
  assert.equal(requests, 1);
  assert.deepEqual(ledger.snapshot().attempts.map((attempt) => attempt.status), ["completed", "rejected"]);
  assert.equal(ledger.snapshot().remainingTokens, 0);
  assert.equal(ledger.snapshot().inputTokens, 2);
  assert.equal(auxiliary.getUsage().input_tokens, 2);
  assert.equal(auxiliary.getUsage().complete, true);
  await auxiliary.dispose();
});

test("shared accounting refuses to replace an established executor on the same ledger", async () => {
  const auxiliary = new AuxiliaryRequestExecutor();
  const ledger = new RequestAttemptLedger();
  const accounting = { ledger, executor: new RequestExecutor(ledger) };
  await auxiliary.execute("memory", async () => ({ usage }), undefined, undefined, accounting);
  await assert.rejects(auxiliary.execute("memory", async () => { assert.fail("Changed owner cannot start a request"); }, undefined, undefined,
    { ledger, executor: new RequestExecutor(ledger) }), /scope changed executors/u);
  assert.equal(ledger.snapshot().attempts.length, 1);
  assert.equal(auxiliary.getUsage().input_tokens, 2);
  await auxiliary.dispose();
});

test("a shared unknown Memory scope cannot regain admission with another signal", async () => {
  const auxiliary = new AuxiliaryRequestExecutor();
  const ledger = new RequestAttemptLedger();
  const accounting = { ledger, executor: new RequestExecutor(ledger) };
  let requests = 0;
  await auxiliary.execute("memory", async () => { requests++; return {}; }, new AbortController().signal, undefined, accounting);
  await assert.rejects(auxiliary.execute("memory", async () => { requests++; return { usage }; }, new AbortController().signal, undefined, accounting), RequestUsageIncompleteError);
  assert.equal(requests, 1);
  assert.deepEqual(ledger.snapshot().attempts.map((attempt) => attempt.status), ["completed", "rejected"]);
  assert.equal(ledger.snapshot().complete, false);
  assert.equal(auxiliary.getUsage().complete, false);
  const independent = new RequestAttemptLedger();
  await auxiliary.execute("memory", async () => { requests++; return { usage }; }, undefined, undefined,
    { ledger: independent, executor: new RequestExecutor(independent) });
  assert.equal(requests, 2);
  assert.equal(independent.snapshot().complete, true);
  assert.equal(auxiliary.getUsage().complete, false);
  assert.equal(auxiliary.getUsage().input_tokens, 2);
  await auxiliary.dispose();
});
