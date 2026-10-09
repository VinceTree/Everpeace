import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolFeedbackPolicy } from "../../../src/agent/tool-feedback-policy.js";
import { runAgentLoop, type ToolCall } from "../../../src/agent/agent-loop.js";

const call = (id: string, args = '{"a":1,"b":2}', name = "read_file"): ToolCall => ({ type: "function_call", call_id: id, name, arguments: args });
const error = JSON.stringify({ status: "error", error: "Invalid read_file arguments" });

test("feedback uses canonical arguments, reminds once and never changes baseline output", () => {
  const policy = new ToolFeedbackPolicy();
  assert.equal(policy.observe(call("a"), error, false).output, error);
  assert.equal(policy.observe(call("b", '{"b":2, "a":1}'), error, false).repeated, true);
  policy.reset();
  assert.ok(!policy.observe(call("a"), error, true).output.includes("retry_notice"));
  const second = JSON.parse(policy.observe(call("b", '{"b":2,"a":1}'), error, true).output);
  assert.match(second.remedy, /parameter schema/u);
  assert.match(second.retry_notice, /twice/u);
  assert.ok(!policy.observe(call("c"), error, true).output.includes("retry_notice"));
  policy.observe(call("ok"), '{"status":"ok"}', true);
  assert.equal(policy.observe(call("d"), error, true).repeated, false);
  policy.reset();
  assert.equal(policy.observe(call("e"), error, true).repeated, false);
});

test("polling is excluded and denial feedback cannot authorize bypasses", () => {
  const policy = new ToolFeedbackPolicy();
  for (let n = 0; n < 4; n++) assert.equal(policy.observe(call(String(n), '{}', "poll_background"), error, true).output, error);
  const denied = JSON.parse(policy.observe(call("denied"), '{"status":"denied"}', true).output);
  assert.match(denied.remedy, /Do not retry.*bypass/u);
  const stale = JSON.parse(policy.observe(call("stale"), '{"status":"error","error":"File changed since it was observed"}', true).output);
  assert.match(stale.remedy, /Read the current file again/u);
});

test("parallel feedback is applied in persisted model order even when reads finish out of order", async () => {
  const policy = new ToolFeedbackPolicy();
  const recorded: Array<Record<string, unknown>> = [];
  let steps = 0;
  const finished: string[] = [];
  await runAgentLoop({
    async sample() { return steps++ === 0 ? { output: [call("slow"), call("fast", '{"b":2,"a":1}')], output_text: "" } : { output: [], output_text: "Done" }; },
    async record(items) { recorded.push(...items); },
    async dispatch(c) { if (c.call_id === "slow") await new Promise((resolve) => setTimeout(resolve, 20)); finished.push(c.call_id); return error; },
    feedbackToolOutput(c, out) { return policy.observe(c, out, true).output; },
    canRunInParallel: () => true,
    assistant() {},
  });
  assert.deepEqual(finished, ["fast", "slow"]);
  const outputs = recorded.filter((item) => item.type === "function_call_output");
  assert.deepEqual(outputs.map((item) => item.call_id), ["slow", "fast"]);
  assert.ok(!String(outputs[0]!.output).includes("retry_notice"));
  assert.ok(String(outputs[1]!.output).includes("retry_notice"));
});
