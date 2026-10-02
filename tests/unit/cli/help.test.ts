import assert from "node:assert/strict";
import { test } from "node:test";
import { EXEC_HELP, HELP } from "../../../src/cli/help.js";

test("help documents exec inputs, limits, JSONL, and stable exit codes", () => {
  assert.match(HELP, /everpeace exec \[prompt\]/);
  assert.match(EXEC_HELP, /-C <directory>/);
  assert.match(EXEC_HELP, /--model <id-or-name>/);
  assert.match(EXEC_HELP, /--token-budget <n>/);
  assert.match(EXEC_HELP, /--timeout-ms <n>/);
  assert.match(EXEC_HELP, /--max-steps <n>/);
  assert.match(EXEC_HELP, /positional argument or through piped stdin/);
  assert.match(EXEC_HELP, /versioned JSONL/);
  for (const code of [0, 1, 2, 3, 4, 5, 130, 143]) {
    assert.match(EXEC_HELP, new RegExp(`^  ${code}\\s`, "m"));
  }
});
