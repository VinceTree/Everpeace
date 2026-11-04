import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isolateOfflineModelProxy } from "../../fixtures/offline-model-proxy.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { createProviderClient, createProviderRuntime, disposeProviderClient, getProviderDefinition, listOfficialModelIds } from "../../../src/providers/openai-compatible.js";
import { createProductionAgent } from "../../../src/runtime/production.js";
import { SessionStore } from "../../../src/storage/session-store.js";

const baseURL = getProviderDefinition("opencode-go").baseURL;
const tokenUsage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
function completed(output: unknown[] = [], text = "OK") {
  return { id: "fixture-response", status: "completed", output, output_text: text, usage: tokenUsage };
}
function sse(response: ReturnType<typeof completed>) {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

test("Go discovery uses its public catalog route and preserves supplier model IDs", async (t) => {
  t.after(isolateOfflineModelProxy());
  let requests = 0;
  let expectedUrl = "";
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    requests++;
    assert.equal(String(url), expectedUrl);
    assert.match(new Headers(init?.headers).get("user-agent") ?? "", /^Everpeace\/\d/u);
    return Response.json({ data: [{ id: "deepseek-v4.1-flash" }, { id: "supplier-future-id" }] });
  });
  for (const route of [baseURL, "https://opencode.ai/inference/go/v1/", "https://opencode.ai/zen/go/v1"]) {
    expectedUrl = route.includes("/zen/") ? "https://opencode.ai/zen/go/v1/models" : "https://opencode.ai/inference/go/v1/models";
    const client = createProviderClient(route, "offline-only");
    try { assert.deepEqual(await listOfficialModelIds(client), ["deepseek-v4.1-flash", "supplier-future-id"]); }
    finally { await disposeProviderClient(client); }
  }
  assert.equal(requests, 3);
});

test("Go buffered and streaming requests share a lazy Session identity without enabling capabilities", async (t) => {
  t.after(isolateOfflineModelProxy());
  let sessionId: string | undefined;
  const observed: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), `${baseURL}/responses`);
    const headers = new Headers(init?.headers);
    assert.match(headers.get("user-agent") ?? "", /^Everpeace\/\d/u);
    observed.push(headers.get("x-opencode-session")!);
    const params = JSON.parse(String(init?.body));
    assert.equal(params.model, "deepseek-v4.1-flash");
    for (const field of ["reasoning", "include", "store", "prompt_cache_key", "conversation", "previous_response_id"]) assert.equal(params[field], undefined);
    return params.stream ? sse(completed()) : Response.json(completed());
  });
  const runtime = createProviderRuntime(baseURL, "offline-only", undefined, "deepseek-v4.1-flash", "auto", { sessionId: () => sessionId });
  const params = { model: "deepseek-v4.1-flash", input: "fixture", reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"], store: true, prompt_cache_key: "unused" };
  try {
    assert.equal(runtime.capabilities.responsesProfile, "generic");
    await runtime.responses.create(params, { maxRetries: 0 });
    await runtime.responses.create(params, { maxRetries: 0 });
    assert.match(observed[0]!, /^[0-9a-f-]{36}$/u);
    assert.equal(observed[0], observed[1], "standalone requests retain one runtime identity");
    sessionId = "saved-session";
    const stream = await runtime.responses.stream(params, { maxRetries: 0, headers: { "x-opencode-session": "caller-override" } });
    for await (const _event of stream) { /* Drain the owned response. */ }
    assert.equal(observed[2], sessionId);
    sessionId = "new-session";
    await runtime.responses.create(params, { maxRetries: 0 });
    assert.equal(observed[3], sessionId);
    const independent = createProviderRuntime(baseURL, "offline-only");
    try { await independent.responses.create(params, { maxRetries: 0 }); }
    finally { await independent.dispose?.(); }
    assert.match(observed[4]!, /^[0-9a-f-]{36}$/u);
    assert.notEqual(observed[4], observed[0], "independent operations do not share an invented conversation");
  } finally { await runtime.dispose?.(); }
});

test("Go routing metadata stays confined to exact documented HTTPS service routes", async (t) => {
  t.after(isolateOfflineModelProxy());
  for (const url of ["https://opencode.ai.evil.invalid/inference/go/openai/v1", "https://opencode.ai/inference/openai/v1", "https://opencode.ai/inference/go/openai/v1?custom=true", "https://opencode.ai:444/inference/go/openai/v1", "http://opencode.ai/inference/go/openai/v1", "https://relay.invalid/v1"]) {
    const mocked = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-opencode-session"), null);
      assert.doesNotMatch(headers.get("user-agent") ?? "", /^Everpeace\//u);
      return Response.json(completed());
    });
    const runtime = createProviderRuntime(url, "offline-only", undefined, "deepseek-v4.1-flash", "auto", { sessionId: () => "private-session" });
    try { await runtime.responses.create({ model: "deepseek-v4.1-flash", input: "fixture" }, { maxRetries: 0 }); }
    finally { await runtime.dispose?.(); mocked.mock.restore(); }
  }
});

test("production Go tool rounds and restored Sessions use the persisted Session ID", async (t) => {
  t.after(isolateOfflineModelProxy());
  const root = await mkdtemp(path.join(os.tmpdir(), "everpeace-go-contract-"));
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath);
  await writeFile(path.join(workspacePath, "fixture.txt"), "isolated fixture bytes\n");
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const model = { id: "go-fixture", model_name: "deepseek-v4.1-flash", base_url: baseURL, api_key: "offline-only" };
  const session = await store.create({ title: "fixture", titlePending: false, workspacePath, model });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("x-opencode-session"), session.id);
    const request = JSON.parse(String(init?.body));
    requests++;
    if (requests === 1) return sse(completed([{ type: "function_call", call_id: "read-fixture", name: "read_file", arguments: '{"path":"fixture.txt"}' }], ""));
    const output = request.input.find((item: { type: string }) => item.type === "function_call_output");
    assert.equal(output.call_id, "read-fixture");
    // File access is intentionally unavailable outside Windows. The routing
    // contract still exercises a real tool round and persisted output there.
    if (process.platform === "win32") assert.match(output.output, /isolated fixture bytes/u);
    else assert.match(output.output, /FILE_ACCESS_UNAVAILABLE/u);
    return sse(completed([], "Read."));
  });
  const ledger = new RequestAttemptLedger({ tokenBudget: 100 });
  const makeHandle = (initialHistory?: Array<Record<string, unknown>>) => createProductionAgent({
    model, workspacePath, sessionStore: store, sessionId: () => session.id, requestAttemptLedger: ledger,
    skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null, costSettingsStore: null,
    io: { getSessionId: () => session.id, getPermissions: () => ({ mode: "read-only", web: false }), async confirmBash() { return false; }, async runBash() { throw new Error("Unexpected shell"); }, writeAssistant() {} },
    restore: { ...(initialHistory ? { initialHistory } : {}), onHistoryAppend: (items) => store.appendContext(session.id, items), onUsage: (sample) => store.appendUsage(session.id, sample) },
  });
  try {
    const handle = makeHandle();
    try { assert.equal((await handle.agent.runTurn("Read fixture.txt.")).stopReason, undefined); }
    finally { await handle.dispose(); }
    const saved = await store.load(session.id);
    assert.equal(saved.context.filter((item) => item.type === "function_call_output").length, 1);
    const restored = makeHandle(saved.context);
    try { assert.equal((await restored.agent.runTurn("Acknowledge the same file.")).stopReason, undefined); }
    finally { await restored.dispose(); }
    assert.equal(requests, 3);
    assert.equal(ledger.snapshot().inputTokens + ledger.snapshot().outputTokens, 45);
    assert.equal(await readFile(path.join(workspacePath, "fixture.txt"), "utf8"), "isolated fixture bytes\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
