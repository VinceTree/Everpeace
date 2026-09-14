import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTuiInput } from "../../../src/tui/commands.js";

test("parseTuiInput separates chat, slash commands, and direct Bash", () => {
  assert.deepEqual(parseTuiInput("hello"), { kind: "chat", text: "hello" });
  assert.deepEqual(parseTuiInput(" /LOGIN "), {
    kind: "slash",
    command: "/login",
  });
  assert.deepEqual(parseTuiInput("!  git status"), {
    kind: "bash",
    command: "git status",
  });
});

test("parseTuiInput reports empty and unknown commands", () => {
  assert.deepEqual(parseTuiInput("  "), { kind: "empty" });
  assert.deepEqual(parseTuiInput("/wat now"), {
    kind: "unknown",
    command: "/wat",
  });
  assert.deepEqual(parseTuiInput("!"), { kind: "bash", command: "" });
});
