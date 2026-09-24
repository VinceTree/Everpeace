import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyUsageSample,
  createEmptySessionUsage,
  normalizeTokenUsageSample,
  resetContextUsage,
  resolveModelStatusMetadata,
} from "../../../src/status/model-status.js";

test("model metadata follows official base URLs and known model IDs", () => {
  assert.deepEqual(
    resolveModelStatusMetadata("https://api.deepseek.com/", "deepseek-flash"),
    { provider: "DeepSeek", context_window: 1_000_000 },
  );
  assert.deepEqual(
    resolveModelStatusMetadata("https://api.openai.com/v1", "gpt-5.6-terra"),
    { provider: "OpenAI", context_window: 1_050_000 },
  );
  assert.deepEqual(
    resolveModelStatusMetadata(
      "https://api.openai.com/v1/",
      "gpt-5-2025-08-07",
    ),
    { provider: "OpenAI", context_window: 400_000 },
  );
});

test("unknown official models and compatible endpoints do not guess context limits", () => {
  assert.deepEqual(
    resolveModelStatusMetadata("https://api.openai.com/v1", "future-model"),
    { provider: "OpenAI", context_window: null },
  );
  assert.deepEqual(
    resolveModelStatusMetadata("https://models.example.com/v1", "gpt-5"),
    { provider: "OpenAI-compatible", context_window: null },
  );
});

test("session usage accumulates billable tokens while tracking current context separately", () => {
  const first = applyUsageSample(createEmptySessionUsage(), {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
  });
  const second = applyUsageSample(first, {
    input_tokens: 150,
    output_tokens: 30,
    total_tokens: 180,
  });
  assert.deepEqual(second, {
    input_tokens: 250,
    output_tokens: 50,
    context_tokens: 180,
    complete: true,
  });
  assert.deepEqual(resetContextUsage(second, false), {
    ...second,
    context_tokens: 0,
  });
  assert.deepEqual(resetContextUsage(second, true), {
    ...second,
    context_tokens: null,
  });
});

test("missing provider usage marks totals partial and context unknown", () => {
  assert.deepEqual(applyUsageSample(createEmptySessionUsage(), null), {
    input_tokens: 0,
    output_tokens: 0,
    context_tokens: null,
    complete: false,
  });
});

test("prompt cache usage is normalized and accumulated separately", () => {
  const sample = normalizeTokenUsageSample({
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cached_tokens: 64, cache_write_tokens: 36 },
  });
  assert.deepEqual(sample, {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    cached_input_tokens: 64,
    cache_write_input_tokens: 36,
  });
  assert.deepEqual(applyUsageSample(createEmptySessionUsage(), sample), {
    input_tokens: 100,
    output_tokens: 20,
    context_tokens: 120,
    cached_input_tokens: 64,
    cache_write_input_tokens: 36,
    cache_usage_complete: true,
    complete: true,
  });
});
