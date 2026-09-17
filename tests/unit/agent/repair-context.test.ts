import assert from "node:assert/strict";
import { test } from "node:test";
import { repairToolContext } from "../../../src/agent/repair-context.js";

test("repairs incomplete older tool batches before following user messages, idempotently", () => {
  const call = { type: "function_call", call_id: "missing", name: "bash", arguments: "{}" };
  const history = [call, { role: "user", content: "continue" }, { type: "function_call", call_id: "last" }];
  const repaired = repairToolContext(history);
  assert.equal(repaired[1]?.call_id, "missing");
  assert.match(String(repaired[1]?.output), /unknown/);
  assert.equal(repaired[2]?.role, "user");
  assert.equal(repaired.at(-1)?.call_id, "last");
  assert.deepEqual(repairToolContext(repaired), repaired);
  assert.equal(history.length, 3);
});

test("preserves complete parallel batches and actual output", () => {
  const history = [
    { type: "function_call", call_id: "a" },
    { type: "function_call", call_id: "b" },
    { type: "message", role: "assistant", content: "working" },
    { type: "function_call_output", call_id: "b", output: "real b" },
    { type: "function_call_output", call_id: "a", output: "real a" },
  ];
  assert.deepEqual(repairToolContext(history), history);
});
