import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { RequestExecutor } from "../../../src/agent/request-executor.js";
import { benchmarkLedgerUsage, benchmarkRequestAccounting } from "../../../src/benchmark/request-accounting.js";
import { optimizationConcurrency } from "../../../scripts/benchmark/run-optimization.js";

test("request accounting retains missing reasons and observed cache only", async () => {
  const ledger = new RequestAttemptLedger();
  const executor = new RequestExecutor(ledger);
  await executor.execute("coding", async () => ({ usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 } } }));
  await executor.execute("summary", async () => ({}));
  await assert.rejects(executor.execute("coding", async () => ({ usage: {} })), /incomplete/u);
  assert.deepEqual(benchmarkRequestAccounting(ledger.snapshot()), { requests: 2, unknownRequests: 1, rejectedRequests: 1, reasons: { "summary:missing_usage": 1 } });
  assert.deepEqual(benchmarkLedgerUsage(ledger.snapshot()), { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, complete: false, cachedInputTokens: 4, cacheObservedInputTokens: 10 });
  assert.equal(benchmarkLedgerUsage(new RequestAttemptLedger().snapshot()).cachedInputTokens, undefined);
});

test("bounded optimization rejects concurrent or mixed budgets before credentials", () => {
  assert.equal(optimizationConcurrency(100, 1000), 1);
  assert.equal(optimizationConcurrency(null, null, "4"), 4);
  assert.throws(() => optimizationConcurrency(100, 1000, "2"), /parallel-pairs=1/u);
  assert.throws(() => optimizationConcurrency(100, null), /both/u);
});
