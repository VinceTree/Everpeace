import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearTerminal,
  SYNCHRONIZED_OUTPUT_END,
  SYNCHRONIZED_OUTPUT_START,
  TERMINAL_RESET_SEQUENCE,
  TUI_RENDER_OPTIONS,
} from "../../../src/tui/index.js";

test("clearTerminal performs an explicit screen and scrollback reset", () => {
  let output = "";

  clearTerminal({
    write(chunk) {
      output += chunk;
    },
  });

  assert.equal(output, TERMINAL_RESET_SEQUENCE);
});

test("TUI stays inline for native scrollback navigation", () => {
  assert.equal(TUI_RENDER_OPTIONS.alternateScreen, false);
  assert.equal(TUI_RENDER_OPTIONS.incrementalRendering, false);
  assert.equal(SYNCHRONIZED_OUTPUT_START, "\u001B[?2026h");
  assert.equal(SYNCHRONIZED_OUTPUT_END, "\u001B[?2026l");
});
