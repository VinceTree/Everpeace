import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { ModelResponseError } from "../../../src/agent/response-errors.js";
import type { LoopEvent } from "../../../src/agent/agent-loop.js";
import type { AgentIO } from "../../../src/agent/react-agent.js";
import { createProductionAgent } from "../../../src/runtime/production.js";
import { SessionStore } from "../../../src/storage/session-store.js";

const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 3 } };
const call = { type: "function_call", id: "item-1", call_id: "deepseek-call-1", name: "read_file", arguments: '{"path":"fixture.txt"}' };
function response(id: string, output: unknown[], text = "", tokenUsage: unknown = usage) {
  return { id, status: "completed", output, output_text: text, ...(tokenUsage === undefined ? {} : { usage: tokenUsage }) };
}
function sse(events: Array<Record<string, unknown>>): Response {
  // DeepSeek terminates with a semantic event, without a [DONE] sentinel.
  return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
async function harness(t: TestContext, onEvent?: (event: LoopEvent) => void, getPermissions?: AgentIO["getPermissions"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "everpeace-deepseek-contract-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "fixture.txt"), "contract fixture bytes\n");
  const sessions = new SessionStore({ directory: path.join(root, "sessions") });
  const model = { id: "contract", model_name: "deepseek-flash", base_url: "https://api.deepseek.com", api_key: "offline-dummy" };
  const session = await sessions.create({ title: "contract", titlePending: false, workspacePath: workspace, model });
  const ledger = new RequestAttemptLedger({ tokenBudget: 100 });
  const handle = createProductionAgent({
    model, workspacePath: workspace, sessionStore: sessions, sessionId: () => session.id,
    requestAttemptLedger: ledger, skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null,
    io: { ...(getPermissions ? { getPermissions } : {}), getSessionId: () => session.id, async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected shell request"); }, writeAssistant() {} },
    restore: { onHistoryAppend: (items) => sessions.appendContext(session.id, items), onUsage: (sample) => sessions.appendUsage(session.id, sample), ...(onEvent ? { onEvent } : {}) },
  });
  t.after(async () => { await handle.dispose(); await rm(root, { recursive: true, force: true }); });
  return { ...handle, ledger, sessions, session, workspace, model };
}

test("official DeepSeek SSE preserves completed tool pairing and counts reasoning inside output", { skip: process.platform !== "win32" }, async (t) => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    assert.equal(String(url), "https://api.deepseek.com/responses");
    const request = JSON.parse(String(options?.body)) as Record<string, unknown>;
    requests.push(request);
    if (requests.length === 1) return sse([
      { type: "response.created", response: { id: "first", status: "in_progress" } },
      { type: "response.reasoning_text.delta", delta: "Inspect the fixture." },
      { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: '{"path":' },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: '"fixture.txt"}' },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: response("first", [call]) },
    ]);
    assert.equal(requests.length, 2);
    return sse([{ type: "response.output_text.delta", delta: "Inspected." }, { type: "response.completed", response: response("second", [], "Inspected.") }]);
  });
  const { agent, ledger, sessions, session } = await harness(t);
  const result = await agent.runTurn("Read fixture.txt, then acknowledge.");
  assert.equal(result.stopReason, undefined);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(typeof request.instructions, "string");
    assert.equal((request.input as Array<Record<string, unknown>>).at(-1)?.role, "system");
    assert.ok(!(request.input as Array<Record<string, unknown>>).some((item) => item.role === "developer"));
    assert.equal(request.model, "deepseek-flash");
    assert.deepEqual(request.reasoning, { effort: "high" });
    assert.equal(request.max_output_tokens, 32_768);
    for (const field of ["previous_response_id", "conversation", "store", "include", "prompt_cache_key", "prompt_cache_retention"]) assert.equal(request[field], undefined);
  }
  const input = requests[1]!.input as Array<Record<string, unknown>>;
  assert.equal(input.filter((item) => item.type === "function_call" && item.call_id === call.call_id).length, 1);
  const outputs = input.filter((item) => item.type === "function_call_output" && item.call_id === call.call_id);
  assert.equal(outputs.length, 1);
  assert.match(String(outputs[0]!.output), /contract fixture bytes/u);
  assert.equal(ledger.snapshot().remainingTokens, 70);
  assert.equal(ledger.snapshot().reasoningTokens, 6);
  assert.equal(ledger.snapshot().attempts[0]!.usage?.cached_input_tokens, 7);
  const saved = await sessions.load(session.id);
  assert.equal(saved.usage.output_tokens, 10);
  assert.equal(saved.context.filter((item) => item.type === "function_call_output" && item.call_id === call.call_id).length, 1);
});

test("complete reasoning items survive multiple tool rounds, new user turns and a restored production Session", async (t) => {
  const requests: Record<string, unknown>[] = [];
  const reasoning = (n: number) => ({ type: "reasoning", id: `reason-${n}`, content: [{ type: "reasoning_text", text: `full reasoning ${n}` }] });
  const message = (n: number) => ({ type: "message", role: "assistant", id: `message-${n}`, content: [{ type: "output_text", text: `answer ${n}` }] });
  const calls = [call, { ...call, id: "item-2", call_id: "call-2" }];
  const later = { ...call, id: "item-3", call_id: "call-3" };
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const request = JSON.parse(String(options?.body)) as Record<string, unknown>;
    requests.push(request);
    const n = requests.length;
    const output = n === 1 ? [reasoning(n), ...calls] : n === 2 ? [reasoning(n), later] : [reasoning(n), message(n)];
    return sse([
      { type: "response.reasoning_text.delta", delta: "partial UI text must not replace full content" },
      { type: "response.output_item.done", output_index: 0, item: reasoning(n) },
      { type: "response.completed", response: response(`r-${n}`, output, n >= 3 ? `answer ${n}` : "") },
    ]);
  });
  const f = await harness(t);
  await f.agent.runTurn("Inspect the file and finish.");
  await f.agent.runTurn("Continue with another question.");
  const saved = await f.sessions.load(f.session.id);
  const expected = [1, 2, 3, 4].map(reasoning);
  assert.deepEqual(saved.context.filter((item) => item.type === "reasoning"), expected);
  await f.dispose();
  const restored = createProductionAgent({ model: f.model, workspacePath: f.workspace, sessionStore: f.sessions, sessionId: () => f.session.id, skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null,
    requestAttemptLedger: new RequestAttemptLedger({ tokenBudget: 100 }),
    io: { async confirmBash() { return false; }, async runBash() { throw new Error("No shell"); }, writeAssistant() {} },
    restore: { initialHistory: saved.context, onHistoryAppend: (items) => f.sessions.appendContext(f.session.id, items), onUsage: (sample) => f.sessions.appendUsage(f.session.id, sample) },
  });
  try { await restored.agent.runTurn("Resume the same conversation."); } finally { await restored.dispose(); }
  assert.equal(requests.length, 5);
  const resumedInput = requests[4]!.input as Array<Record<string, unknown>>;
  assert.deepEqual(resumedInput.filter((item) => item.type === "reasoning"), expected);
  assert.deepEqual((requests[1]!.input as Array<Record<string, unknown>>).filter((item) => item.type === "reasoning"), [reasoning(1)]);
  assert.deepEqual((requests[2]!.input as Array<Record<string, unknown>>).filter((item) => item.type === "reasoning"), [reasoning(1), reasoning(2)]);
  assert.deepEqual(resumedInput.filter((item) => item.type === "function_call").map((item) => item.call_id), calls.concat(later).map((item) => item.call_id));
  for (const c of calls.concat(later)) assert.equal(resumedInput.filter((item) => item.type === "function_call_output" && item.call_id === c.call_id).length, 1);
  assert.ok(!JSON.stringify(saved.context).includes("partial UI text"));
  assert.equal(requests[0]!.instructions, requests[4]!.instructions);
  assert.deepEqual(requests[0]!.tools, requests[4]!.tools);
});

for (const status of ["incomplete", "failed"] as const) {
  test(`DeepSeek ${status} terminal events retain usage and never execute partial calls`, async (t) => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return sse([
        { type: "response.output_item.added", output_index: 0, item: call },
        { type: `response.${status}`, response: { ...response("stopped", [call]), status, incomplete_details: { reason: "max_output_tokens" }, error: { code: "fixture_failure" } } },
      ]);
    });
    const { agent, ledger, sessions, session } = await harness(t);
    await assert.rejects(agent.runTurn("Read fixture.txt"), ModelResponseError);
    assert.equal(requests, 1);
    assert.equal(ledger.snapshot().complete, true);
    assert.equal(ledger.snapshot().remainingTokens, 85);
    assert.equal((await sessions.load(session.id)).context.some((item) => item.type === "function_call_output"), false);
  });
}

test("DeepSeek missing usage stops the bounded task before a second provider request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return sse([{ type: "response.completed", response: { id: "unknown", status: "completed", output: [call], output_text: "" } }]); });
  const { agent, ledger } = await harness(t);
  const result = await agent.runTurn("Read and continue");
  assert.equal(result.stopReason, "usage_limited");
  assert.equal(requests, 1);
  assert.equal(ledger.snapshot().complete, false);
});

test("DeepSeek transport EOF without a terminal event cannot retry with unknown usage", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return sse([{ type: "response.output_text.delta", delta: "unfinished" }]); });
  const { agent, ledger } = await harness(t);
  assert.equal((await agent.runTurn("Continue")).stopReason, "usage_limited");
  assert.equal(requests, 1);
  assert.equal(ledger.snapshot().complete, false);
});

test("DeepSeek cancellation joins the SSE body and prevents a second request", async (t) => {
  const controller = new AbortController();
  let requests = 0, cancellations = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    const body = new ReadableStream<Uint8Array>({
      start(target) { target.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created","response":{"id":"pending","status":"in_progress"}}\n\n')); },
      cancel() { cancellations++; },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  });
  const { agent, ledger } = await harness(t, (event) => {
    if (event.type === "model_progress" && event.milestone === "first_event") controller.abort();
  });
  await assert.rejects(agent.runTurn("Wait for a model response", controller.signal), { name: "AbortError" });
  assert.equal(requests, 1);
  assert.equal(cancellations, 1);
  assert.equal(ledger.snapshot().complete, false);
});


test("wire prefix stays byte-identical when only DeepSeek host state changes", async (t) => {
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    requests.push(String(options?.body));
    return sse([{ type: "response.completed", response: response("done", [], "OK") }]);
  });
  let mode: "read-only" | "workspace-write" = "read-only";
  const f = await harness(t, undefined, () => ({ mode, web: false }));
  await f.agent.runTurn("first user input");
  mode = "workspace-write";
  await f.agent.runTurn("second user input");
  // Conversation and sourced records grow between turns; only the stable
  // instruction/tool prefix before input is eligible for byte identity.
  const boundary = requests[0]!.indexOf('"input":');
  assert.ok(boundary > 0);
  const byteBoundary = Buffer.byteLength(requests[0]!.slice(0, boundary), "utf8");
  assert.ok(Buffer.from(requests[0]!).subarray(0, byteBoundary).equals(Buffer.from(requests[1]!).subarray(0, byteBoundary)));
  const first = JSON.parse(requests[0]!);
  const second = JSON.parse(requests[1]!);
  assert.deepEqual(first.tools, second.tools);
  assert.equal(first.instructions, second.instructions);
  assert.notEqual(first.input.at(-1).content, second.input.at(-1).content);
});
