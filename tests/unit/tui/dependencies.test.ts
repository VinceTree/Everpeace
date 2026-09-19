import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeSessionTitle } from "../../../src/tui/app/dependencies.js";
import { textWidth } from "../../../src/tui/rendering/text-width.js";

test("session titles are single-line, plain text, and width limited", () => {
  assert.equal(sanitizeSessionTitle("# “修复终端缩放问题！”\nextra"), "修复终端缩放问题");
  assert.equal(sanitizeSessionTitle("**Investigate flaky tests.**"), "Investigate flaky tests");
  assert.ok(textWidth(sanitizeSessionTitle("会".repeat(40))) <= 60);
});
