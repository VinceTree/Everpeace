import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReuseOpaqueProviderContext,
  defaultModelRequestSettings,
  hasOpaqueProviderContext,
  requestReasoningEffort,
  resolveProviderCapabilities,
} from "../../../src/providers/capabilities.js";
import { sanitizeProviderRequest } from "../../../src/providers/openai-compatible.js";

test("official DeepSeek uses summary compaction and a bounded reasoning request", () => {
  const capabilities = resolveProviderCapabilities("https://api.deepseek.com/v1/");
  assert.equal(capabilities.provider, "deepseek");
  assert.equal(capabilities.compaction, "summary");
  assert.equal(capabilities.encryptedReasoning, false);
  assert.equal(requestReasoningEffort(capabilities, "max"), "high");
  assert.deepEqual(defaultModelRequestSettings(capabilities), {
    reasoningEffort: "high",
    maxOutputTokens: 32_768,
  });
});

test("DeepSeek request sanitization removes OpenAI-only state and cache fields", () => {
  const params = sanitizeProviderRequest(resolveProviderCapabilities("https://api.deepseek.com"), {
    model: "deepseek-flash",
    input: "hello",
    include: ["reasoning.encrypted_content"],
    store: false,
    parallel_tool_calls: true,
    prompt_cache_key: "secret-affinity",
    prompt_cache_retention: "24h",
    reasoning: { effort: "high" },
    max_output_tokens: 100_000,
  });
  assert.deepEqual(params, {
    model: "deepseek-flash",
    input: "hello",
    reasoning: { effort: "high" },
    max_output_tokens: 32_768,
  });
});

test("unknown compatible endpoints do not inherit reasoning capabilities", () => {
  const capabilities = resolveProviderCapabilities("https://gateway.example/v1");
  assert.equal(capabilities.provider, "compatible");
  assert.equal(capabilities.compaction, "summary");
  assert.equal(requestReasoningEffort(capabilities, "high"), undefined);
});

test("official OpenAI reasoning is model-scoped instead of inferred from the SDK", () => {
  assert.equal(resolveProviderCapabilities("https://api.openai.com/v1", "gpt-5.6-terra").reasoningEffort, true);
  assert.equal(resolveProviderCapabilities("https://api.openai.com/v1", "gpt-4o").reasoningEffort, false);
});

test("opaque provider context is detected before cross-provider restore", () => {
  assert.equal(hasOpaqueProviderContext([{ type: "reasoning", content: [{ encrypted_content: "opaque" }] }]), true);
  assert.equal(hasOpaqueProviderContext([{ type: "reasoning", content: [{ type: "reasoning_text", text: "plain" }] }]), false);
  assert.equal(canReuseOpaqueProviderContext("https://api.deepseek.com", "https://api.deepseek.com/v1"), true);
  assert.equal(canReuseOpaqueProviderContext("https://first.example/v1", "https://second.example/v1"), false);
  assert.equal(canReuseOpaqueProviderContext("https://first.example/v1/", "https://first.example/v1"), true);
});
