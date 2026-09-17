import assert from "node:assert/strict";
import { test } from "node:test";
import { retainOutput } from "../../../src/tools/command-record.js";

test("output retention bounds lines and bytes while preserving UTF-8 and the tail", () => {
  const lines = retainOutput(Array.from({ length: 10001 }, (_, i) => String(i)).join("\n"));
  assert.equal(lines.truncated, true);
  assert.equal(lines.text.split("\n").length, 10000);
  assert.ok(lines.text.endsWith("10000"));
  const bytes = retainOutput("\u4e2d".repeat(800000));
  assert.equal(bytes.truncated, true);
  assert.ok(Buffer.byteLength(bytes.text) <= 2 * 1024 * 1024);
  assert.ok(!bytes.text.includes("\ufffd"));
  assert.deepEqual(retainOutput("hello"), { text: "hello", truncated: false });
});
