import assert from "node:assert/strict";
import test from "node:test";
import {
  ALACRITTY_RESIZE_REFLOW_MAX_ROWS,
  DEFAULT_TERMINAL_RESIZE_REFLOW_MAX_ROWS,
  VSCODE_TERMINAL_RESIZE_REFLOW_MAX_ROWS,
  WEZTERM_RESIZE_REFLOW_MAX_ROWS,
  WINDOWS_TERMINAL_RESIZE_REFLOW_MAX_ROWS,
  estimatedTimelineEntryRows,
  terminalResizeReflowMaxRows,
  visibleHistory,
} from "../../../src/tui/history-window.js";
import type { TimelineEntry } from "../../../src/tui/types.js";

test("history window retains source entries below Codex's row cap", () => {
  const source: TimelineEntry[] = Array.from({ length: 205 }, (_, id) => ({ id, kind: "assistant", text: `reply ${id}` }));
  const selected = visibleHistory(source, { columns: 80, maxRows: 1_000 });
  assert.equal(selected.length, 205);
  assert.equal(selected[0]?.id, 0);
  assert.equal(selected.at(-1)?.id, 204);
  assert.equal(source.length, 205);
  assert.equal(source[0]?.id, 0);
  assert.equal(visibleHistory([], { maxRows: 1_000 }).length, 0);
  assert.equal(visibleHistory(selected), selected);
});

test("history window keeps the newest source rows without trimming the source", () => {
  const source: TimelineEntry[] = Array.from({ length: 501 }, (_, id) => ({ id, kind: "assistant", text: `reply ${id}` }));
  const selected = visibleHistory(source, { columns: 80, maxRows: 1_000 });
  assert.equal(selected.length, 500);
  assert.equal(selected[0]?.id, 1);
  assert.equal(selected.at(-1)?.id, 500);
  assert.equal(source.length, 501);
});

test("history window accounts for wrapped terminal rows", () => {
  const source: TimelineEntry[] = [
    { id: 1, kind: "assistant", text: "1234" },
    { id: 2, kind: "assistant", text: "abcdef" },
  ];
  assert.equal(estimatedTimelineEntryRows(source[1]!, 8), 3);
  assert.deepEqual(visibleHistory(source, { columns: 8, maxRows: 3 }).map((entry) => entry.id), [2]);
});

test("Codex terminal row caps are selected from the terminal environment", () => {
  assert.equal(terminalResizeReflowMaxRows({ VSCODE_INJECTION: "1" }), VSCODE_TERMINAL_RESIZE_REFLOW_MAX_ROWS);
  assert.equal(terminalResizeReflowMaxRows({ WT_SESSION: "id" }), WINDOWS_TERMINAL_RESIZE_REFLOW_MAX_ROWS);
  assert.equal(terminalResizeReflowMaxRows({ TERM_PROGRAM: "WezTerm" }), WEZTERM_RESIZE_REFLOW_MAX_ROWS);
  assert.equal(terminalResizeReflowMaxRows({ TERM_PROGRAM: "Alacritty" }), ALACRITTY_RESIZE_REFLOW_MAX_ROWS);
  assert.equal(terminalResizeReflowMaxRows({}), DEFAULT_TERMINAL_RESIZE_REFLOW_MAX_ROWS);
});
