import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canHighlight,
  highlightCode,
  MAX_HIGHLIGHT_LINE_BYTES,
  normalizeLanguage,
  shellLanguage,
} from "../../../src/tui/syntax-highlight.js";

test("syntax highlighting resolves common aliases and emits styled spans", () => {
  assert.equal(normalizeLanguage("ts title=demo"), "typescript");
  assert.equal(normalizeLanguage("ps1"), "powershell");
  assert.equal(shellLanguage("PowerShell"), "powershell");
  assert.equal(shellLanguage("Bash"), "bash");

  const lines = highlightCode("const message: string = '你好';", "ts");
  assert.equal(lines.flat().map((span) => span.text).join(""), "const message: string = '你好';");
  assert.ok(lines.flat().some((span) => span.color !== undefined));
});

test("syntax highlighting falls back safely for unknown languages and large lines", () => {
  assert.deepEqual(highlightCode("plain text", "not-a-language"), [[{ text: "plain text" }]]);
  const oversized = "x".repeat(MAX_HIGHLIGHT_LINE_BYTES + 1);
  assert.equal(canHighlight(oversized), false);
  assert.deepEqual(highlightCode(oversized, "typescript"), [[{ text: oversized }]]);
});
