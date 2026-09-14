import assert from "node:assert/strict";
import { test } from "node:test";
import { clearTerminal, TUI_RENDER_OPTIONS } from "../../../src/tui/index.js";

test("clearTerminal clears prior package-runner output before rendering", () => {
  let output = "";

  clearTerminal({
    write(chunk) {
      output += chunk;
    },
  });

  assert.equal(output, "\u001B[2J\u001B[H");
});

test("TUI uses the alternate screen so terminal resizing cannot duplicate inline frames", () => {
  assert.equal(TUI_RENDER_OPTIONS.alternateScreen, true);
});
