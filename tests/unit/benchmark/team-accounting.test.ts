import assert from "node:assert/strict";
import test from "node:test";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";

test("evaluation imports settled team evidence once, retaining member identities and sticky unknown", () => {
  const ledger = new RequestAttemptLedger({ tokenBudget: 10 });
  const evidence = [
    { id: 1, purpose: "coding" as const, status: "completed" as const, usage: { input_tokens: 4, output_tokens: 3, reasoning_tokens: 2, total_tokens: 7 }, agentId: "root", modelId: "same-model" },
    { id: 2, purpose: "coding" as const, status: "failed" as const, usage: null, agentId: "member", modelId: "same-model" },
    { id: 3, purpose: "summary" as const, status: "completed" as const, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, agentId: "other", modelId: "same-model" },
  ];
  ledger.importSettledAttempts("team", evidence); ledger.importSettledAttempts("team", evidence);
  const snapshot = ledger.snapshot(); assert.equal(snapshot.attempts.length, 3); assert.equal(snapshot.inputTokens + snapshot.outputTokens, 9);
  assert.equal(snapshot.reasoningTokens, 2); assert.equal(snapshot.remainingTokens, 1); assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.attempts.map((attempt) => attempt.agentId), ["root", "member", "other"]);
  assert.throws(() => ledger.begin("coding"), /incomplete/u);
});
