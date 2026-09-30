import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_TOOL_OUTPUT_MAX_BYTES, ToolOutputStore } from "../../../src/agent/context-limits.js";

test("model tool output remains valid JSON and can be read through its continuation handle", () => {
  const store = new ToolOutputStore();
  const output = `HEAD-${"中".repeat(20_000)}-TAIL`;
  const bounded = store.bound(output);
  assert.ok(Buffer.byteLength(bounded, "utf8") <= MODEL_TOOL_OUTPUT_MAX_BYTES);
  const envelope = JSON.parse(bounded) as { status: string; output_id: string; head: string; tail: string };
  assert.equal(envelope.status, "truncated");
  assert.match(envelope.head, /^HEAD-/u);
  assert.match(envelope.tail, /-TAIL$/u);
  const page = store.read(JSON.stringify({ output_id: envelope.output_id, offset_bytes: 0, max_bytes: 128 }));
  assert.equal(page.status, "ok");
  assert.match(String(page.content), /^HEAD-/u);
});
