import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  clearTerminal,
  installResizeRecovery,
  TERMINAL_RESET_SEQUENCE,
  TUI_RENDER_OPTIONS,
} from "../../../src/tui/index.js";

test("clearTerminal clears prior package-runner output before rendering", () => {
  let output = "";

  clearTerminal({
    write(chunk) {
      output += chunk;
    },
  });

  assert.equal(output, TERMINAL_RESET_SEQUENCE);
});

test("resize recovery clears reflowed frames and is removable", () => {
  const output = new EventEmitter() as EventEmitter & {
    chunks: string[];
    write(chunk: string): void;
  };
  output.chunks = [];
  output.write = (chunk) => output.chunks.push(chunk);

  const remove = installResizeRecovery(output);
  output.emit("resize");
  output.emit("resize");
  assert.deepEqual(output.chunks, [TERMINAL_RESET_SEQUENCE, TERMINAL_RESET_SEQUENCE]);

  remove();
  output.emit("resize");
  assert.equal(output.chunks.length, 2);
});

test("TUI stays inline and uses full-frame resize rendering", () => {
  assert.equal(TUI_RENDER_OPTIONS.alternateScreen, false);
  assert.equal(TUI_RENDER_OPTIONS.incrementalRendering, false);
});
