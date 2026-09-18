import assert from "node:assert/strict";
import { test } from "node:test";
import { BashOutputPreviewBuffer } from "../../../src/tools/bash-output-preview.js";

test("Bash output preview preserves the true first and last five lines", () => {
  const preview = new BashOutputPreviewBuffer();
  const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    .join("\r\n");

  for (const chunk of [output.slice(0, 17), output.slice(17, 83), output.slice(83)]) {
    preview.push(chunk);
  }

  assert.deepEqual(preview.snapshot(), {
    headLines: ["line 1", "line 2", "line 3", "line 4", "line 5"],
    tailLines: ["line 16", "line 17", "line 18", "line 19", "line 20"],
    omittedLines: 10,
  });
});

test("Bash output preview handles split CRLF, blank lines, and partial lines", () => {
  const preview = new BashOutputPreviewBuffer();
  preview.push("first\r");
  preview.push("\n\npart");
  preview.push("ial");

  assert.deepEqual(preview.snapshot(), {
    headLines: ["first", "", "partial"],
    tailLines: [],
    omittedLines: 0,
  });
});

test("Bash output preview bounds a huge UTF-8 line while preserving both ends", () => {
  const preview = new BashOutputPreviewBuffer();
  preview.push(`start-${"🦀".repeat(300_000)}-end`);

  const snapshot = preview.snapshot();
  assert.equal(snapshot.headLines.length, 1);
  assert.equal(snapshot.tailLines.length, 0);
  assert.equal(snapshot.omittedLines, 0);
  assert.match(snapshot.headLines[0] ?? "", /^start-/u);
  assert.match(snapshot.headLines[0] ?? "", /bytes omitted/u);
  assert.match(snapshot.headLines[0] ?? "", /-end$/u);
  assert.ok(Buffer.byteLength(snapshot.headLines[0] ?? "") < 1024 * 1024);
});
