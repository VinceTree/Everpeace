import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderCapabilityProfile } from "../../../src/benchmark/capabilities.js";

test("provider capability profiles record observed features without routing", () => {
  const profile = createProviderCapabilityProfile(
    "https://api.openai.com/v1",
    "gpt-5.6",
    { streaming: true, nativeCompaction: true, parallelToolCalls: true },
  );

  assert.equal(profile.provider, "OpenAI");
  assert.equal(profile.streaming, true);
  assert.equal(profile.nativeCompaction, true);
  assert.equal(profile.parallelToolCalls, true);
  assert.equal(profile.promptCache, true);
  assert.equal(profile.contextWindow, 1_050_000);
});

test("unknown compatible providers stay conservative until capabilities are observed", () => {
  const profile = createProviderCapabilityProfile("https://example.test/v1", "custom-model");

  assert.equal(profile.provider, "OpenAI-compatible");
  assert.equal(profile.contextWindow, null);
  assert.equal(profile.streaming, false);
  assert.equal(profile.streamRecovery, false);
  assert.equal(profile.nativeCompaction, false);
  assert.equal(profile.promptCache, false);
});
