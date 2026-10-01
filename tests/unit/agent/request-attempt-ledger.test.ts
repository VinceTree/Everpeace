import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { RequestExecutor } from "../../../src/agent/request-executor.js";

test("request attempt ledger keeps unknown usage sticky and stops later requests", () => {
  const ledger = new RequestAttemptLedger({ tokenBudget: 100 });
  const first = ledger.begin("coding");
  ledger.settle(first, "completed", { input_tokens: 60, output_tokens: 20, reasoning_tokens: 10, total_tokens: 80 });
  const second = ledger.begin("summary");
  ledger.settle(second, "failed", null);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.inputTokens, 60);
  assert.equal(snapshot.outputTokens, 20);
  assert.equal(snapshot.reasoningTokens, 10);
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.remainingTokens, 20);
  assert.throws(() => ledger.begin("coding"), /usage is incomplete/u);
});

test("request attempt ledger records overshoot without double-counting reasoning", () => {
  const ledger = new RequestAttemptLedger({ tokenBudget: 10 });
  const attempt = ledger.begin("coding");
  ledger.settle(attempt, "completed", { input_tokens: 8, output_tokens: 5, reasoning_tokens: 3, total_tokens: 13 });
  assert.equal(ledger.snapshot().exceededBy, 3);
  assert.throws(() => ledger.begin("coding"), /budget is exhausted/u);
});

test("shared request executor settles thrown and rejected attempts without clearing unknown usage", async () => {
  const ledger = new RequestAttemptLedger();
  const executor = new RequestExecutor(ledger);
  await assert.rejects(executor.execute("title", async () => { throw new Error("transport failed"); }), /transport failed/u);
  await assert.rejects(executor.execute("doctor", async () => ({ status: "completed" })), /usage is incomplete/u);
  assert.deepEqual(ledger.snapshot().attempts.map((attempt) => attempt.status), ["failed", "rejected"]);
  assert.equal(ledger.snapshot().complete, false);
});
