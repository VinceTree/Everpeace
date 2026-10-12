import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { runTask } from "../../src/sdk/index.js";
import { SessionStore } from "../../src/storage/session-store.js";

const root = process.env.EVERPEACE_SDK_TEST_ROOT;
if (!root) throw new Error("The SDK fixture requires an isolated root");
const workspacePath = path.join(root, "workspace");
await mkdir(workspacePath);
const store = new SessionStore({ directory: path.join(root, "sessions") });
const model = { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" };
const registry = { async resolveAll() { return { available: [model], missing: [] }; } };
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => {
  calls++;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const terminal = { type: "response.completed", response: { id: "fixture", status: "completed", output_text: "done", output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\n`));
    },
    async cancel() { throw new Error("SDK response body close refused"); },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
};
try {
  const result = await runTask({ prompt: "Work", workspacePath, registry, sessionStore: store, tokenBudget: 100, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 1, result.error);
  assert.equal(result.classification, "runtime_error");
  assert.equal(result.status, "cleanup_failed");
  assert.equal(result.usageComplete, true);
  assert.equal(result.usage?.inputTokens, 2);
  assert.equal(result.usage?.outputTokens, 1);
  assert.equal(calls, 1);
  assert.ok(result.sessionId);
  const loaded = await store.load(result.sessionId);
  assert.equal(loaded.workflow?.result, "unverified");
  assert.equal(loaded.workflow?.pending_verification, true);
  assert.equal(JSON.stringify(loaded.workflow).includes("SDK response body close refused"), false);
  process.stdout.write("SDK stream cleanup and reliable billing boundaries passed\n");
} finally { globalThis.fetch = originalFetch; }
