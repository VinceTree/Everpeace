import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { runTask } from "../../src/sdk/index.js";
import { SessionStore } from "../../src/storage/session-store.js";

const root = process.env.EVERPEACE_SDK_TEST_ROOT;
if (!root) throw new Error("The SDK fixture requires an isolated root");
const workspacePath = path.join(root, "workspace");
await fs.mkdir(workspacePath);
const store = new SessionStore({ directory: path.join(root, "sessions") });
let calls = 0;
const server = http.createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const tools = (body.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(tools.includes("submit_plan"));
    assert.equal(tools.includes("apply_patch"), false);
    assert.equal(tools.includes("bash"), false);
    calls++;
    assert.ok(calls <= 2);
    const name = calls === 1 ? "submit_plan" : "request_user_input";
    const args = calls === 1 ? { title: "SDK plan", plan: "Inspect the source and verify changes offline." }
      : { questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "One module" }, { label: "Large", description: "Several modules" }] }] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `response-${calls}`, object: "response", status: "completed", output: [{ id: `call-${calls}`, type: "function_call", name, call_id: `call-${calls}`, arguments: JSON.stringify(args) }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } })}\n\n`);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const model = { id: "offline", model_name: "offline", base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "fixture" };
const registry = { async resolveAll() { return { available: [model], missing: [] }; } };
try {
  const planned = await runTask({ prompt: "Plan a change", plan: true, workspacePath, registry, sessionStore: store, timeoutMs: 10_000 });
  assert.equal(planned.status, "plan", planned.error);
  assert.equal(planned.exitCode, 0);
  assert.equal(planned.assistantText, "Inspect the source and verify changes offline.");
  assert.equal((await store.load(planned.sessionId!)).workflow, undefined);
  const question = await runTask({ prompt: "Clarify the scope", plan: true, workspacePath, registry, sessionStore: store, timeoutMs: 10_000 });
  assert.equal(question.classification, "interaction_required", question.error);
  assert.equal(question.exitCode, 5);
  const loaded = await store.load(question.sessionId!);
  assert.ok(loaded.context.some((item) => item.type === "function_call_output" && String(item.output).includes("interaction_required")));
  assert.equal(calls, 2);
  process.stdout.write("SDK Plan output and question boundaries passed\n");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
