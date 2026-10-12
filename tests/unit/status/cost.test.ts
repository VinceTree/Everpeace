import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateRequestCost, CostWarningTracker, summarizeCosts, CostSettingsStore, isCostEstimate, type CostEstimate } from "../../../src/status/cost.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { RequestExecutor } from "../../../src/agent/request-executor.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("request prices snapshot cached input and output without billing reasoning twice", () => {
  const pricing = { currency: "USD", input: 2, cachedInput: 1, output: 4 };
  const estimate = estimateRequestCost({ input_tokens: 1_000_000, output_tokens: 500_000, total_tokens: 1_500_000, cached_input_tokens: 200_000, reasoning_tokens: 100_000 }, pricing);
  assert.equal(estimate.amount, 3.8); pricing.input = 10; assert.equal(estimate.pricing?.input, 2);
  assert.equal(estimateRequestCost(null, pricing).state, "unknown");
  assert.equal(estimateRequestCost({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }, pricing).state, "partial");
});
test("settled request estimates include failures and auxiliary purposes, deduplicate recovery and warn once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "everpeace-cost-fixture-"));
  try {
    const prices = new CostSettingsStore(path.join(root, "cost.json"));
    await prices.configure("fixture", { currency: "USD", input: 1, cachedInput: 1, output: 1, warningThreshold: 0.00001 });
    const store = new SessionStore({ directory: path.join(root, "sessions") });
    const session = await store.create({ title: "Cost fixture", titlePending: false, workspacePath: root, model: { id: "fixture", model_name: "fixture", base_url: "https://fixture.invalid" } });
    const records: CostEstimate[] = []; const tracker = new CostWarningTracker();
    const executor = new RequestExecutor(new RequestAttemptLedger(), { modelId: "fixture", tracker, price: () => prices.price("fixture"), async settled(record) { records.push(record); await store.appendCost(session.id, record); } });
    for (const purpose of ["coding", "summary", "title", "memory", "skill", "doctor"] as const) await executor.execute(purpose, async () => ({ usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }));
    await assert.rejects(executor.execute("coding", async () => { throw new Error("transport fixture"); }));
    await prices.configure("fixture", { currency: "EUR", input: 5, cachedInput: 5, output: 5 });
    assert.equal(records[0]?.pricing?.currency, "USD"); assert.equal(records.filter((record) => record.warning).length, 1);
    const recovered = await store.load(session.id); assert.deepEqual(recovered.costs, records);
    const summary = summarizeCosts([...recovered.costs!, ...records]); assert.equal(summary.requests, 7); assert.equal(summary.unknownRequests, 1);
    assert.equal(summary.currencies.length, 1); assert.equal(summary.currencies[0]?.partial, true);
    tracker.reset(); assert.equal(tracker.add(records[0]!), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("root, worker and auxiliary requests share a warning while currencies and request identities remain separate", async () => {
  const records: CostEstimate[] = [], tracker = new CostWarningTracker();
  for (const [modelId, currency] of [["root", "USD"], ["worker", "USD"], ["auxiliary", "EUR"]]) {
    const executor = new RequestExecutor(new RequestAttemptLedger(), { modelId: modelId!, tracker, async price() { return { currency: currency!, input: 1, cachedInput: 1, output: 1, warningThreshold: 0.1 }; }, async settled(record) { records.push(record); } });
    await executor.execute(modelId === "auxiliary" ? "memory" : "coding", async () => ({ usage: { input_tokens: 100_000, output_tokens: 1, total_tokens: 100_001 } }));
  }
  assert.equal(records.filter((record) => record.warning && record.pricing?.currency === "USD").length, 1);
  const totals = summarizeCosts([...records, ...records]); assert.equal(totals.requests, 3); assert.equal(totals.currencies.length, 2); assert.equal(totals.unknownRequests, 0);
  assert.equal(isCostEstimate({ ...records[0], api_key: "forbidden-field" }), false);
  assert.throws(() => summarizeCosts([records[0]!, { ...records[0]!, amount: 999 }]));
  assert.equal(estimateRequestCost({ input_tokens: 10, output_tokens: 10, total_tokens: 20 }, null).state, "unknown");
});
