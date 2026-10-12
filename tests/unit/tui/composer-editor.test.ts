import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createComposerState,
  insertComposerText,
  killComposerToLineEnd,
  killComposerToLineStart,
  moveComposerLeft,
  moveComposerLineEnd,
  moveComposerLineStart,
  moveComposerVertically,
  yankComposer,
} from "../../../src/tui/composer/editor.js";

test("End and Ctrl+E move the composer cursor to the current line end", () => {
  let state = createComposerState("first\nsecond");
  state = moveComposerLeft(moveComposerLeft(state));
  state = moveComposerLineEnd(state);
  state = insertComposerText(state, "!");

  assert.equal(state.value, "first\nsecond!");
  assert.equal(state.cursor, Array.from(state.value).length);
});

test("Home and vertical movement preserve the desired column", () => {
  let state = createComposerState("12345\n12\n12345");
  state = moveComposerLineStart(state);
  state = insertComposerText(state, "X");
  state = moveComposerVertically(state, -1);
  state = moveComposerVertically(state, -1);

  assert.equal(state.cursor, 1);
  assert.equal(state.value, "12345\n12\nX12345");
});

test("Ctrl+U follows Codex line-kill behavior and Ctrl+Y restores killed text", () => {
  let state = createComposerState("first\nsecond");
  state = killComposerToLineStart(state);
  assert.equal(state.value, "first\n");

  state = yankComposer(state);
  assert.equal(state.value, "first\nsecond");

  state = moveComposerLineStart(state);
  state = killComposerToLineStart(state);
  assert.equal(state.value, "firstsecond");
});

test("Ctrl+K kills to line end and then removes the following newline", () => {
  let state = createComposerState("first\nsecond");
  state = moveComposerLineStart(state);
  state = moveComposerVertically(state, -1);
  state = killComposerToLineEnd(state);
  assert.equal(state.value, "\nsecond");

  state = killComposerToLineEnd(state);
  assert.equal(state.value, "second");
});
