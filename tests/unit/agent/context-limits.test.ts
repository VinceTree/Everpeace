import assert from "node:assert/strict";
import { test } from "node:test";
import { boundModelToolOutput, MODEL_TOOL_OUTPUT_MAX_BYTES } from "../../../src/agent/context-limits.js";

test("model tool output retains its head and tail within the byte limit", () => {
  const output = `HEAD-${"中".repeat(20_000)}-TAIL`;
  const bounded = boundModelToolOutput(output);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= MODEL_TOOL_OUTPUT_MAX_BYTES);
  assert.match(bounded, /^HEAD-/u);
  assert.match(bounded, /-TAIL$/u);
  assert.match(bounded, /tool output truncated/u);
});
