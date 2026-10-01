import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterSlashCommands,
  parseTuiInput,
  SLASH_COMMANDS,
} from "../../../src/tui/commands/slash-commands.js";

test("filterSlashCommands matches a single leading command token by prefix", () => {
  assert.deepEqual(filterSlashCommands("/"), [...SLASH_COMMANDS]);
  assert.deepEqual(filterSlashCommands(" /MO"), ["/model", "/models"]);
  assert.deepEqual(filterSlashCommands("/res"), ["/resume"]);
  assert.deepEqual(filterSlashCommands("/sta"), ["/status"]);
  assert.deepEqual(filterSlashCommands("/per"), ["/permissions"]);
  assert.deepEqual(filterSlashCommands("/wat"), []);
  assert.deepEqual(filterSlashCommands("message /help"), []);
  assert.deepEqual(filterSlashCommands("/help "), []);
  assert.deepEqual(filterSlashCommands("/help\n"), []);
});

test("parseTuiInput separates chat, slash commands, and direct Bash", () => {
  assert.deepEqual(parseTuiInput("hello"), { kind: "chat", text: "hello" });
  assert.deepEqual(parseTuiInput(" /LOGIN "), {
    kind: "slash",
    command: "/login",
  });
  assert.deepEqual(parseTuiInput("/resume"), {
    kind: "slash",
    command: "/resume",
  });
  assert.deepEqual(parseTuiInput("/new"), {
    kind: "slash",
    command: "/new",
  });
  assert.deepEqual(parseTuiInput("/status"), {
    kind: "slash",
    command: "/status",
  });
  assert.deepEqual(parseTuiInput("/tasks"), { kind: "slash", command: "/tasks" });
  assert.deepEqual(parseTuiInput("/compact"), {
    kind: "slash",
    command: "/compact",
  });
  assert.deepEqual(parseTuiInput("/verify pnpm test"), {
    kind: "slash",
    command: "/verify",
    args: "pnpm test",
  });
  assert.deepEqual(parseTuiInput("/diff"), { kind: "slash", command: "/diff" });
  assert.deepEqual(parseTuiInput("/undo"), { kind: "slash", command: "/undo" });
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
