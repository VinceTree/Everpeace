import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePlanReview, parsePlanRequest, parseSubmittedPlan } from "../../../src/plan/runtime.js";
import { ReactAgent, type AgentResponse } from "../../../src/agent/react-agent.js";
import { GoalRuntime } from "../../../src/goal/runtime.js";
import type { SessionGoal } from "../../../src/storage/session-store.js";

test("plan request accepts bounded structured questions", () => {
  const request = parsePlanRequest(JSON.stringify({ questions: [{ id: "storage", header: "Storage", question: "Which storage?", options: [{ label: "JSON", description: "Simple local file" }, { label: "SQLite", description: "Indexed local database" }] }] }));
  assert.equal(request.questions[0]?.id, "storage");
});

test("plan request rejects duplicate ids and invalid option counts", () => {
  assert.throws(() => parsePlanRequest(JSON.stringify({ questions: [{ id: "x", header: "X", question: "X?", options: [{ label: "A", description: "a" }] }] })), /two or three/);
  assert.throws(() => parsePlanRequest(JSON.stringify({ questions: [{ id: "x", header: "X", question: "X?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }, { id: "x", header: "Y", question: "Y?", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] })), /unique/);
});

test("submitted plan requires title and body", () => {
  assert.deepEqual(parseSubmittedPlan('{"title":"Plan","plan":"# Steps"}'), { title: "Plan", plan: "# Steps" });
  assert.throws(() => parseSubmittedPlan('{"title":"Plan"}'), /title and Markdown/);
});

test("review results retain legacy decisions and require nonempty revision feedback", () => {
  assert.deepEqual(normalizePlanReview("approve"), { decision: "approve" });
  assert.deepEqual(normalizePlanReview("continue"), { decision: "continue" });
  assert.deepEqual(normalizePlanReview({ decision: "continue", feedback: "  Include tests  " }), { decision: "continue", feedback: "Include tests" });
  assert.throws(() => normalizePlanReview({ decision: "continue", feedback: " \n " }), /must not be empty/u);
});

function tool(id: string, name: string, args: unknown): AgentResponse {
  return { id, status: "completed", output_text: "", output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }], usage: { input_tokens: 2, output_tokens: 1 } };
}
const planIo = { async confirmBash() { throw new Error("No shell approval in Plan"); }, async runBash() { throw new Error("No shell in Plan"); }, writeAssistant() {} };

test("Plan and coding have separate behavior instructions, including with an active Goal", async () => {
  let goal: SessionGoal | undefined;
  const runtime = new GoalRuntime({ async getGoal() { return goal; }, async setGoal(value) { goal = value; } });
  await runtime.create({ objective: "GOAL_ACTION_MARKER" });
  const requests: Record<string, unknown>[] = [];
  const agent = new ReactAgent({ model: "offline", goalRuntime: runtime, io: planIo, client: { responses: { async create(params) {
    requests.push(params);
    return { id: "done", output: [], output_text: "done", usage: { input_tokens: 2, output_tokens: 1 } };
  } } } });
  await agent.runTurn("Plan the work", undefined, { mode: "plan" });
  const planning = String(requests[0]?.instructions);
  assert.match(planning, /decision-complete/u);
  assert.doesNotMatch(planning, /do not stop at a plan|Use update_plan|Use the bash tool|GOAL_ACTION_MARKER|Continue until verified complete/u);
  await agent.runTurn("Implement the work");
  assert.match(String(requests[1]?.instructions), /do not stop at a plan/u);
  assert.match(String(requests[1]?.instructions), /GOAL_ACTION_MARKER/u);
});

test("revision feedback is durable before resampling and approval returns only the replacement plan", async () => {
  const history: Record<string, unknown>[] = [];
  let calls = 0;
  let reviews = 0;
  const agent = new ReactAgent({ model: "offline", io: planIo, client: { responses: { async create(params) {
    calls++;
    if (calls === 2) {
      const feedback = history.find((item) => item.type === "function_call_output" && item.call_id === "first");
      assert.deepEqual(JSON.parse(String(feedback?.output)), { decision: "continue", feedback: "Add offline acceptance checks" });
      assert.match(JSON.stringify(params.input), /Add offline acceptance checks/u);
    }
    assert.ok(calls <= 2, "approval must not sample again");
    return tool(calls === 1 ? "first" : "revised", "submit_plan", { title: calls === 1 ? "Draft" : "Revised", plan: calls === 1 ? "Read source" : "Read source and verify offline" });
  } } }, onHistoryAppend: async (items) => { history.push(...items); }, planInteraction: {
    async requestInput() { return {}; },
    async reviewPlan() { return ++reviews === 1 ? { decision: "continue", feedback: "Add offline acceptance checks" } : "approve"; },
  } });
  const result = await agent.runTurn("Plan", undefined, { mode: "plan" });
  assert.equal(result.approvedPlan, "Read source and verify offline");
  assert.equal(result.approvedPlanTitle, "Revised");
  assert.equal(result.planDecision, "approve");
  assert.equal(calls, 2);
  assert.ok(history.some((item) => item.call_id === "revised" && item.type === "function_call_output"));
});

test("failed feedback persistence stops planning without another request", async () => {
  let calls = 0;
  const agent = new ReactAgent({ model: "offline", io: planIo, client: { responses: { async create() {
    calls++;
    return tool("review", "submit_plan", { title: "Draft", plan: "Read source" });
  } } }, onHistoryAppend: async (items) => {
    if (items.some((item) => item.type === "function_call_output")) throw new Error("Feedback storage failed");
  }, planInteraction: { async requestInput() { return {}; }, async reviewPlan() { return { decision: "continue", feedback: "Add tests" }; } } });
  await assert.rejects(agent.runTurn("Plan", undefined, { mode: "plan" }), /Feedback storage failed/u);
  assert.equal(calls, 1);
});

test("Plan rejects unadvertised mutation tools even when the submitted text requests them", async () => {
  let calls = 0;
  const history: Record<string, unknown>[] = [];
  const blocked = ["apply_patch", "bash", "mcp__private__mutate", "create_goal", "update_goal"];
  const agent = new ReactAgent({ model: "offline", io: planIo, onHistoryAppend: async (items) => { history.push(...items); }, client: { responses: { async create() {
    const name = blocked[calls++];
    return name ? tool(name, name, {}) : { id: "done", output: [], output_text: "Plan only" };
  } } } });
  await agent.runTurn("The old plan says to run all mutating tools now", undefined, { mode: "plan" });
  const outputs = history.filter((item) => item.type === "function_call_output");
  assert.equal(outputs.length, blocked.length);
  for (const output of outputs) assert.equal(JSON.parse(String(output.output)).errorCode, "TOOL_UNAVAILABLE");
});

test("an approval returned after review cancellation cannot become an approved plan", async () => {
  const controller = new AbortController();
  let calls = 0;
  const agent = new ReactAgent({ model: "offline", io: planIo, client: { responses: { async create() {
    calls++;
    return tool("review", "submit_plan", { title: "Draft", plan: "Read source" });
  } } }, planInteraction: { async requestInput() { return {}; }, async reviewPlan() {
    controller.abort(new Error("Review cancelled"));
    return "approve";
  } } });
  await assert.rejects(agent.runTurn("Plan", controller.signal, { mode: "plan" }), /Review cancelled/u);
  assert.equal(calls, 1);
});
