import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { ModelResponseError } from "../../../src/agent/response-errors.js";
import type { LoopEvent } from "../../../src/agent/agent-loop.js";
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
async function harness(t: TestContext, onEvent?: (event: LoopEvent) => void) {
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
    io: { getSessionId: () => session.id, async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected shell request"); }, writeAssistant() {} },
    restore: { onHistoryAppend: (items) => sessions.appendContext(session.id, items), onUsage: (sample) => sessions.appendUsage(session.id, sample), ...(onEvent ? { onEvent } : {}) },
  });
  t.after(async () => { await handle.dispose(); await rm(root, { recursive: true, force: true }); });
  return { ...handle, ledger, sessions, session };
}

test("official DeepSeek SSE preserves completed tool pairing and counts reasoning inside output", async (t) => {
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
