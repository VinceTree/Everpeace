import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticFreshness, diagnosticIdentity, runLiveDiagnostics } from "../../../src/providers/doctor.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import { createProviderRuntime } from "../../../src/providers/openai-compatible.js";

const model = { id: "fixture", base_url: "https://api.deepseek.com", model_name: "original-model-id", api_key: "unused-fixture", responses_profile: "deepseek" as const };
function runtime(unknownAt?: number): { runtime: ProviderRuntime; requests: number[]; closed: number[] } {
  const capabilities = resolveProviderCapabilities(model.base_url, model.model_name, model.responses_profile);
  const requests: number[] = [], closed: number[] = [];
  return { requests, closed, runtime: { sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities), responses: {
    async create() { throw new Error("Unexpected buffered path"); },
    async stream(params, options) {
      const id = requests.length + 1; requests.push(id);
      assert.equal(params.max_output_tokens, 1024); assert.equal(options?.maxRetries, 0); assert.equal(options?.timeout, 30_000);
      return (async function* () {
        try {
          yield { type: "response.created" };
          if (options?.signal instanceof AbortSignal && options.signal.aborted) return;
          yield { type: "response.output_text.delta", delta: "OK" };
          const tool = typeof params.tool_choice === "object";
          yield { type: "response.completed", response: { id: String(id), status: "completed", output_text: tool ? "" : "OK", output: tool ? [{ type: "function_call", name: "diagnostic_echo", call_id: `call-${id}`, arguments: '{"nonce":"probe"}' }, { type: "reasoning", summary: [] }] : [], ...(id === unknownAt ? {} : { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }) } };
        } finally { closed.push(id); }
      })();
    },
  } } };
}
test("staged protocol probe owns all streams, preserves model identity and cancels last", async () => {
  const fixture = runtime(); const result = await runLiveDiagnostics(model, fixture.runtime);
  assert.deepEqual(fixture.requests, [1, 2, 3, 4, 5]); assert.deepEqual(fixture.closed, fixture.requests);
  for (const stage of Object.values(result.stages)) assert.equal(stage.state, "verified");
  assert.equal(result.usageComplete, false); // Cancellation cannot invent provider usage.
  assert.equal(result.model, model.model_name); assert.equal(JSON.stringify(result).includes(model.api_key), false);
  assert.equal(diagnosticFreshness(result, model, Date.parse(result.testedAt)), "current");
  assert.equal(diagnosticFreshness(result, model, Date.parse(result.testedAt) + 8 * 86400_000), "expired");
  assert.notEqual(diagnosticIdentity(model), diagnosticIdentity({ ...model, responses_profile: "generic" }));
});
test("unknown usage stops remaining probes without classifying transport evidence as unsupported", async () => {
  const fixture = runtime(1); const result = await runLiveDiagnostics(model, fixture.runtime);
  assert.deepEqual(fixture.requests, [1]); assert.equal(result.stages.single_tool.state, "not_tested");
  assert.equal(result.stages.usage.state, "inconclusive"); assert.equal(result.usageComplete, false);
});
test("authentication and timeout failures are inconclusive and do not initiate subsequent probes", async () => {
  for (const name of ["AuthenticationError", "TimeoutError"]) {
    const fixture = runtime(); let requests = 0;
    fixture.runtime.responses.stream = async () => { requests++; throw Object.assign(new Error("fixture failure"), { name }); };
    const result = await runLiveDiagnostics(model, fixture.runtime);
    assert.equal(requests, 1); assert.equal(result.stages.streaming_text.state, "inconclusive"); assert.equal(result.stages.cancellation.state, "not_tested");
  }
});
test("doctor stages traverse real SDK streaming and cleanup for official, configured relay and generic profiles", async (t) => {
  for (const [base_url, responses_profile] of [["https://api.deepseek.com", "deepseek"], ["https://relay.invalid/v1", "deepseek"], ["https://relay.invalid/v1", "generic"]] as const) {
    const candidate = { ...model, base_url, responses_profile };
    let requests = 0, closed = 0;
    const mocked = t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      requests++; const params = JSON.parse(String(init?.body)); const tool = typeof params.tool_choice === "object";
      if (requests === 4) assert.equal(params.input.filter((item: { type?: string }) => item.type === "function_call_output").length, 2);
      const events = [{ type: "response.created" }, { type: "response.output_text.delta", delta: "OK" }, { type: "response.completed", response: { id: `fixture-${requests}`, status: "completed", output_text: tool ? "" : "OK", output: tool ? [{ type: "function_call", name: "diagnostic_echo", call_id: `call-${requests}`, arguments: '{"nonce":"probe"}' }, { type: "reasoning", summary: [] }] : [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }];
      return new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); }, cancel() { closed++; } }), { headers: { "Content-Type": "text/event-stream" } });
    });
    const provider = createProviderRuntime(base_url, "test-only", undefined, candidate.model_name, responses_profile);
    try { const result = await runLiveDiagnostics(candidate, provider); assert.equal(requests, 5); assert.equal(closed, 5); for (const stage of Object.values(result.stages)) assert.equal(stage.state, "verified"); }
    finally { await provider.dispose?.(); mocked.mock.restore(); }
  }
});
