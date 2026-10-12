import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequestSnapshot } from "../../../src/agent/request-snapshot.js";

test("request snapshot measures and fingerprints the exact immutable payload", () => {
  const request = { model: "deepseek-flash", input: [{ role: "user", content: "fix it" }], max_output_tokens: 32_768 };
  const first = createRequestSnapshot({ request, contextRevision: 3, outputReserveTokens: 32_768, stablePrefix: "stable", dynamicContext: "rules-a" });
  request.input[0]!.content = "mutated later";
  const second = createRequestSnapshot({ request: { ...request, input: [{ role: "user", content: "fix it" }] }, contextRevision: 3, outputReserveTokens: 32_768, stablePrefix: "stable", dynamicContext: "rules-b" });
  assert.equal((first.request.input as Array<{ content: string }>)[0]?.content, "fix it");
  assert.equal(first.stablePrefixFingerprint, second.stablePrefixFingerprint);
  assert.notEqual(first.dynamicContextFingerprint, second.dynamicContextFingerprint);
  assert.equal(first.outputReserveTokens, 32_768);
  assert.ok(first.estimatedInputTokens > 0);
  assert.equal(Object.isFrozen(first.request), true);
});
