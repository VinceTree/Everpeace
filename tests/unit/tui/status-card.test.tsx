import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStatusCard,
} from "../../../src/tui/components/screens/status-card.js";
import { textWidth } from "../../../src/tui/rendering/text-width.js";

const snapshot = {
  version: "0.1.20",
  model_name: "deepseek-flash",
  provider: "DeepSeek" as const,
  base_url: "https://api.deepseek.com",
  workspace_path:
    "C:\\Users\\39850\\Desktop\\coding-agent\\Everpeace\\benchmark\\chalk",
  session_id: "session-with-a-long-identifier",
  context_window: 1_000_000,
  context_tokens: 18_400,
  input_tokens: 12_345,
  output_tokens: 2_345,
  cached_input_tokens: 10_000,
  cache_observed_input_tokens: 12_345,
  cache_write_input_tokens: 2_345,
  cache_usage_complete: true,
  cache_write_usage_complete: true,
  usage_complete: true,
};

test("status card renders the selected Codex-style fields", () => {
  const card = createStatusCard(120, snapshot);
  assert.ok(card);
  const output = card.lines.join("\n");
  assert.match(output, /Version:\s+v0\.1\.20/);
  assert.match(output, /Model:\s+deepseek-flash/);
  assert.match(output, /Provider:\s+DeepSeek/);
  assert.match(output, /Context window:\s+98% left \(18\.4K used \/ 1M\)/);
  assert.match(output, /Input tokens:\s+12,345/);
  assert.match(output, /Output tokens:\s+2,345/);
  assert.match(output, /Cached input:\s+10,000/);
  assert.match(output, /Cache writes:\s+2,345/);
  assert.match(output, /Cache hit rate:\s+81%/);
});

test("status card never reaches the terminal auto-wrap cell", () => {
  for (const columns of [120, 80, 60, 40, 12]) {
    const card = createStatusCard(columns, snapshot);
    assert.ok(card);
    assert.ok(card.width <= columns - 1);
    for (const line of card.lines) assert.equal(textWidth(line), card.width);
  }
});
