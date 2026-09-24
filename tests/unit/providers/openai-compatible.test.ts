import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSessionPromptCacheKey,
  getProviderDefinition,
  isOfficialOpenAiBaseUrl,
  listOfficialModelIds,
  normalizeBaseUrl,
  parseProvider,
  supportsPromptCacheOptions,
} from "../../../src/providers/openai-compatible.js";

test("prompt cache keys are stable and endpoint-gated", () => {
  assert.equal(isOfficialOpenAiBaseUrl("https://api.openai.com/v1/"), true);
  assert.equal(isOfficialOpenAiBaseUrl("https://api.openai.com/v1?proxy=true"), false);
  assert.equal(isOfficialOpenAiBaseUrl("https://models.example.com/v1"), false);
  const first = createSessionPromptCacheKey("session-123");
  const second = createSessionPromptCacheKey("session-123");
  assert.equal(first, second);
  assert.equal(first, "everpeace:v2:session:session-123");
  assert.throws(() => createSessionPromptCacheKey("  "), /cannot be empty/);
  assert.equal(supportsPromptCacheOptions("gpt-5.6"), true);
  assert.equal(supportsPromptCacheOptions("gpt-5.6-codex"), true);
  assert.equal(supportsPromptCacheOptions("gpt-5.5"), false);
  assert.equal(supportsPromptCacheOptions("custom-model"), false);
});

test("official providers use their documented API base URLs", () => {
  assert.equal(
    getProviderDefinition("deepseek").baseURL,
    "https://api.deepseek.com",
  );
  assert.equal(
    getProviderDefinition("openai").baseURL,
    "https://api.openai.com/v1",
  );
});

test("parseProvider accepts only supported official presets", () => {
  assert.equal(parseProvider("DeepSeek"), "deepseek");
  assert.equal(parseProvider("openai"), "openai");
  assert.throws(() => parseProvider("proxy"), /Unsupported provider/);
});

test("listOfficialModelIds preserves IDs returned by /models", async () => {
  const ids = await listOfficialModelIds({
    models: {
      async list() {
        return {
          data: [
            { id: "deepseek-v4-flash" },
            { id: "deepseek-v4-pro" },
          ],
        };
      },
    },
  });

  assert.deepEqual(ids, ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

test("normalizeBaseUrl allows HTTPS and strips trailing slashes", () => {
  assert.equal(
    normalizeBaseUrl(" https://models.example.com/v1/// "),
    "https://models.example.com/v1",
  );
});

test("normalizeBaseUrl allows local HTTP endpoints", () => {
  assert.equal(
    normalizeBaseUrl("http://localhost:11434/v1/"),
    "http://localhost:11434/v1",
  );
  assert.equal(
    normalizeBaseUrl("http://127.0.0.1:8000"),
    "http://127.0.0.1:8000",
  );
  assert.equal(
    normalizeBaseUrl("http://[::1]:8000/v1"),
    "http://[::1]:8000/v1",
  );
});

test("normalizeBaseUrl rejects insecure remote and ambiguous URLs", () => {
  assert.throws(() => normalizeBaseUrl("http://models.example.com/v1"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("not-a-url"), /valid absolute URL/);
  assert.throws(
    () => normalizeBaseUrl("https://user:pass@example.com/v1"),
    /cannot contain credentials/,
  );
  assert.throws(
    () => normalizeBaseUrl("https://example.com/v1?key=value"),
    /cannot contain credentials/,
  );
});
