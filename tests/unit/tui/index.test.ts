import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearTerminal,
  SYNCHRONIZED_OUTPUT_END,
  SYNCHRONIZED_OUTPUT_START,
  TERMINAL_RESET_SEQUENCE,
  TUI_RENDER_OPTIONS,
  settleTuiLifecycle,
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

test("TUI lifecycle awaits service cleanup and always restores terminal modes", async (t) => {
  await t.test("normal exit", async () => {
    const events: string[] = [];
    const result = await settleTuiLifecycle(
      { async dispose() { await Promise.resolve(); events.push("dispose"); } },
      async () => { events.push("run"); return 7; },
      () => events.push("reset"),
    );
    assert.equal(result, 7);
    assert.deepEqual(events, ["run", "dispose", "reset"]);
  });

  await t.test("cleanup failure", async () => {
    const events: string[] = [];
    await assert.rejects(
      settleTuiLifecycle(
        { async dispose() { events.push("dispose"); throw new Error("close failed"); } },
        async () => { events.push("run"); return 0; },
        () => events.push("reset"),
      ),
      /close failed/u,
    );
    assert.deepEqual(events, ["run", "dispose", "reset"]);
  });

  await t.test("startup failure", async () => {
    const events: string[] = [];
    await assert.rejects(
      settleTuiLifecycle(
        { async dispose() { events.push("dispose"); } },
        async () => { events.push("run"); throw new Error("startup failed"); },
        () => events.push("reset"),
      ),
      /startup failed/u,
    );
    assert.deepEqual(events, ["run", "dispose", "reset"]);
  });
});
