import assert from "node:assert/strict";
import { test } from "node:test";
import { settleGoTerminalUsage } from "../../../src/providers/response-stream.js";
import { RequestExecutor } from "../../../src/agent/request-executor.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";

const usage = { input_tokens: 8, output_tokens: 2, total_tokens: 10 };
async function* events(rows: Record<string, unknown>[]) { yield* rows; }
async function collect(events: AsyncIterable<Record<string, unknown>>) { const rows = []; for await (const row of events) rows.push(row); return rows; }
const terminal = (billing?: unknown) => ({ type: "response.completed", response: { id: "resp_test", status: "completed", output: [{ type: "message" }], usage: billing } });

test("Go late terminal usage is joined without losing output or repeating inference", async () => {
  const first = terminal(null), tail = { type: "response.completed", response: { id: "resp_test", status: "completed", usage } };
  const rows = await collect(settleGoTerminalUsage(events([first, tail])));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.response, { ...first.response, usage });
  const ledger = new RequestAttemptLedger();
  await new RequestExecutor(ledger).execute("coding", async () => rows[0]!.response as typeof first.response);
  assert.equal(ledger.snapshot().inputTokens, 8); assert.equal(ledger.snapshot().attempts.length, 1);
});

test("Go genuinely omitted usage remains unknown and keeps terminal diagnostics", async () => {
  const rows = await collect(settleGoTerminalUsage(events([{ type: "response.failed", response: { id: "resp_failed", status: "failed", usage: null, error: { code: "server_error", message: "private message" } } }])));
  const ledger = new RequestAttemptLedger(), executor = new RequestExecutor(ledger);
  await executor.execute("coding", async () => rows[0]!.response as { usage?: unknown });
  assert.deepEqual(ledger.snapshot().attempts[0]?.response, { id: "resp_failed", status: "failed", errorCode: "server_error" });
  assert.equal(ledger.snapshot().complete, false);
  assert.ok(!JSON.stringify(ledger.snapshot()).includes("private message"));
  await assert.rejects(executor.execute("coding", async () => { assert.fail("Unknown usage cannot retry"); }));
});

test("Go usage cannot be borrowed from a different response or changed terminal state", async () => {
  for (const response of [{ id: "other", status: "completed", usage }, { id: "resp_test", status: "failed", usage }]) {
    await assert.rejects(collect(settleGoTerminalUsage(events([terminal(null), { type: "response.completed", response }]))), /Conflicting/u);
  }
});
