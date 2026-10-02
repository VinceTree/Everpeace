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

test("prepared output bounds retained text and exposes explicit retention loss", async () => {
  const { prepareToolOutput, RETAINED_TOOL_OUTPUT_MAX_BYTES, readStoredToolOutput, parseReadToolOutputArguments } = await import("../../../src/agent/context-limits.js");
  const prepared = prepareToolOutput("😀中\r\n".repeat(300_000), "shell");
  assert.ok(prepared.attachment);
  assert.ok(prepared.attachment.bytes.byteLength <= RETAINED_TOOL_OUTPUT_MAX_BYTES);
  assert.doesNotMatch(prepared.attachment.bytes.toString("utf8"), /�/u);
  assert.ok(Buffer.byteLength(prepared.output, "utf8") <= MODEL_TOOL_OUTPUT_MAX_BYTES);
  assert.equal(JSON.parse(prepared.output).retention_truncated, true);
  const final = readStoredToolOutput(prepared.attachment, parseReadToolOutputArguments(JSON.stringify({ output_id: prepared.attachment.output_id, offset_bytes: prepared.attachment.bytes.byteLength })));
  assert.equal(final.retention_truncated, true);
  assert.equal(final.complete, false);
  assert.equal(final.next_offset_bytes, undefined);
});

test("UTF-8 continuation advances through aligned Chinese and emoji pages and rejects tiny pages", async () => {
  const { utf8Page } = await import("../../../src/agent/context-limits.js");
  const bytes = Buffer.from("中😀\r\nabc", "utf8");
  assert.throws(() => utf8Page(bytes, 0, 1), RangeError);
  assert.throws(() => utf8Page(bytes, 3, 3), RangeError);
  assert.deepEqual(utf8Page(bytes, 0, 3), { content: "中", start: 0, end: 3 });
  assert.deepEqual(utf8Page(bytes, 3, 4), { content: "😀", start: 3, end: 7 });
  assert.deepEqual(utf8Page(bytes, 1, 4), { content: "😀", start: 3, end: 7 });
  assert.deepEqual(utf8Page(bytes, bytes.byteLength + 100, 1), { content: "", start: bytes.byteLength, end: bytes.byteLength });
});

test("tool output sanitation preserves layout before preview, retention, and byte pagination", async () => {
  const { prepareToolOutput, readStoredToolOutput, parseReadToolOutputArguments } = await import("../../../src/agent/context-limits.js");
  const original = `  before\r\nAPI_KEY=fixture-sensitive-value\r\n  after\n${"中".repeat(20_000)}`;
  const prepared = prepareToolOutput(original, "shell");
  assert.ok(prepared.attachment);
  assert.doesNotMatch(prepared.output, /fixture-sensitive-value/u);
  assert.doesNotMatch(prepared.attachment.bytes.toString("utf8"), /fixture-sensitive-value/u);
  assert.match(prepared.attachment.bytes.toString("utf8"), /^  before\r\n/u);
  assert.match(prepared.attachment.bytes.toString("utf8"), /\r\n  after\n/u);
  assert.equal(prepared.attachment.original_bytes, Buffer.byteLength(original, "utf8"));
  const first = readStoredToolOutput(prepared.attachment, parseReadToolOutputArguments(JSON.stringify({ output_id: prepared.attachment.output_id, max_bytes: 25 })));
  const second = readStoredToolOutput(prepared.attachment, parseReadToolOutputArguments(JSON.stringify({ output_id: prepared.attachment.output_id, offset_bytes: first.next_offset_bytes, max_bytes: 25 })));
  assert.doesNotMatch(`${String(first.content)}${String(second.content)}`, /fixture-sensitive-value/u);
});

test("read arguments validate identifiers, optional session, and byte ranges", async () => {
  const { parseReadToolOutputArguments, READ_TOOL_OUTPUT_MAX_BYTES } = await import("../../../src/agent/context-limits.js");
  assert.deepEqual(parseReadToolOutputArguments('{"output_id":"opaque","session_id":"old-session"}'), { output_id: "opaque", session_id: "old-session", offset_bytes: 0, max_bytes: READ_TOOL_OUTPUT_MAX_BYTES });
  for (const input of ["null", "[]", "{}", '{"output_id":"../secret"}', '{"output_id":"opaque","session_id":"../outside"}']) {
    assert.throws(() => parseReadToolOutputArguments(input));
  }
  for (const value of [-1, 0, 1.5, READ_TOOL_OUTPUT_MAX_BYTES + 1]) {
    assert.throws(() => parseReadToolOutputArguments(JSON.stringify({ output_id: "opaque", max_bytes: value })), RangeError);
  }
});

test("process fallback only retains explicitly committed prepared outputs and expires the oldest", async () => {
  const { prepareToolOutput } = await import("../../../src/agent/context-limits.js");
  const store = new ToolOutputStore();
  const first = prepareToolOutput("a".repeat(40_000), "shell");
  assert.ok(first.attachment);
  assert.equal(store.read(JSON.stringify({ output_id: first.attachment.output_id })).status, "not_found");
  store.retain(first);
  assert.equal(store.read(JSON.stringify({ output_id: first.attachment.output_id })).status, "ok");
  for (let index = 0; index < 16; index++) store.retain(prepareToolOutput(`b${index}${"x".repeat(40_000)}`, "shell"));
  assert.equal(store.read(JSON.stringify({ output_id: first.attachment.output_id })).status, "not_found");
  store.clear();
});

test("escaped output pages fit the model response bound and reconstruct retained text exactly", async () => {
  const { prepareToolOutput, readStoredToolOutput, parseReadToolOutputArguments, READ_TOOL_OUTPUT_MAX_BYTES } = await import("../../../src/agent/context-limits.js");
  const original = `${'"\\\u0000\u0001\n\r\t'.repeat(12_000)}中😀`;
  const prepared = prepareToolOutput(original, "shell");
  assert.ok(prepared.attachment);
  let offset = 0;
  let complete = false;
  const contents: string[] = [];
  while (!complete) {
    const page = readStoredToolOutput(prepared.attachment, parseReadToolOutputArguments(JSON.stringify({ output_id: prepared.attachment.output_id, offset_bytes: offset })), { source: "session_history", notice: "Reference material. ".repeat(50), historical_data: true });
    assert.equal(page.status, "ok");
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= MODEL_TOOL_OUTPUT_MAX_BYTES);
    assert.ok(Buffer.byteLength(String(page.content), "utf8") <= READ_TOOL_OUTPUT_MAX_BYTES);
    contents.push(String(page.content));
    complete = page.complete === true;
    if (!complete) {
      assert.ok(typeof page.next_offset_bytes === "number" && page.next_offset_bytes > offset);
      offset = page.next_offset_bytes;
    }
  }
  assert.equal(contents.join(""), prepared.attachment.bytes.toString("utf8"));
  assert.equal(contents.join(""), original);
});
