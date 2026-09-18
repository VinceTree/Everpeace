import assert from "node:assert/strict";
import { test } from "node:test";
import { selectAgentOutputPreview } from "../../../src/tui/command-output-preview.js";

const fullPreview = {
  headLines: ["line 1", "line 2", "line 3", "line 4", "line 5"],
  tailLines: ["line 16", "line 17", "line 18", "line 19", "line 20"],
  omittedLines: 10,
};

test("agent output preview shows head five and tail five at normal height", () => {
  assert.deepEqual(selectAgentOutputPreview(fullPreview, 10), fullPreview);
});

test("agent output preview shrinks symmetrically and keeps an accurate omission count", () => {
  assert.deepEqual(selectAgentOutputPreview(fullPreview, 4), {
    headLines: ["line 1", "line 2"],
    tailLines: ["line 19", "line 20"],
    omittedLines: 16,
  });
  assert.deepEqual(selectAgentOutputPreview(fullPreview, 1), {
    headLines: [],
    tailLines: ["line 20"],
    omittedLines: 19,
  });
});

test("agent output preview renders short output once without an omission marker", () => {
  assert.deepEqual(
    selectAgentOutputPreview(
      {
        headLines: ["line 1", "line 2", "line 3", "line 4", "line 5"],
        tailLines: ["line 6", "line 7"],
        omittedLines: 0,
      },
      10,
    ),
    {
      headLines: [
        "line 1",
        "line 2",
        "line 3",
        "line 4",
        "line 5",
        "line 6",
        "line 7",
      ],
      tailLines: [],
      omittedLines: 0,
    },
  );
});
