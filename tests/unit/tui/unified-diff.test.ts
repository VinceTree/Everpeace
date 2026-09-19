import assert from "node:assert/strict";
import { test } from "node:test";
import { diffPalette } from "../../../src/tui/rendering/palette.js";
import { diffLanguage, parseUnifiedDiff } from "../../../src/tui/rendering/unified-diff.js";

const sample = "diff --git a/src/demo.ts b/src/demo.ts\r\nindex 123..456 100644\r\n--- a/src/demo.ts\r\n+++ b/src/demo.ts\r\n@@ -2,2 +2,2 @@\r\n-old\r\n+new\r\n same";

test("unified diff parsing tracks old and new line numbers across CRLF input", () => {
  const diff = parseUnifiedDiff(sample);
  assert.ok(diff);
  assert.equal(diffLanguage(sample), "typescript");
  assert.deepEqual(
    diff.lines.filter((line) => ["deletion", "addition", "context"].includes(line.kind)).map((line) => ({
      kind: line.kind,
      oldLine: line.oldLine,
      newLine: line.newLine,
    })),
    [
      { kind: "deletion", oldLine: 2, newLine: undefined },
      { kind: "addition", oldLine: undefined, newLine: 2 },
      { kind: "context", oldLine: 3, newLine: 3 },
    ],
  );
});

test("unified diff detection rejects arbitrary plus and minus output", () => {
  assert.equal(parseUnifiedDiff("- stopped\n+ started"), undefined);
  assert.equal(parseUnifiedDiff("--- old\n+++ new\n-no hunk\n+still no hunk"), undefined);
});

test("explicit diff fences may render partial patches without file headers", () => {
  const diff = parseUnifiedDiff("-old\n+new", { allowPartial: true });
  assert.deepEqual(diff?.lines.map((line) => line.kind), ["deletion", "addition"]);
});

test("unified diff parsing resets counters for each file and hunk", () => {
  const value = [
    "--- a/one.ts", "+++ b/one.ts", "@@ -1 +1 @@", "-one", "+first",
    "--- a/two.ts", "+++ b/two.ts", "@@ -8 +12 @@", "-two", "+second",
  ].join("\n");
  const diff = parseUnifiedDiff(value);
  assert.ok(diff);
  assert.deepEqual(
    diff.lines.filter((line) => line.kind === "addition").map((line) => line.newLine),
    [1, 12],
  );
});

test("diff palettes adapt to true color, light backgrounds, ANSI16, and NO_COLOR", () => {
  assert.equal(diffPalette({ colorDepth: 24, noColor: false }).addedBackground, "#213A2B");
  assert.equal(diffPalette({ colorDepth: 24, colorForegroundBackground: "0;15", noColor: false }).addedBackground, "#DAFBE1");
  assert.equal(diffPalette({ colorDepth: 4, noColor: false }).addedForeground, "green");
  assert.deepEqual(diffPalette({ colorDepth: 24, noColor: true }), {});
});
