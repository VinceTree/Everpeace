import { isolateOfflineModelProxy } from "./offline-model-proxy.js";
import assert from "node:assert/strict";
import { LearnedMemoryStore } from "../../src/memory/learned-memory.js";
import { createDefaultTuiDependencies } from "../../src/tui/app/dependencies.js";

const directory = process.env.EVERPEACE_MEMORY_TEST_ROOT;
if (!directory || process.cwd() !== directory) throw new Error("An isolated Memory fixture directory is required");
const failStorage = process.env.EVERPEACE_MEMORY_TEST_FAILURE === "storage";
const storageFailure = new Error("Manual Memory persistence failed after provider completion");
const store = new LearnedMemoryStore();
await store.saveJobs([{ id: "future-background", createdAt: new Date(0).toISOString(), notBefore: new Date(0).toISOString(),
  attempts: 0, status: "queued", requestPending: false, usageComplete: true, outcome: "verified",
  turn: { workspacePath: directory, userInput: "Repair a defect", transcript: "Verified evidence", assistantText: "done", toolCallCount: 1 },
}]);
const model = { id: "offline", model_name: "deepseek-v4-flash", base_url: "https://api.deepseek.com", api_key: "fixture" };
const dependencies = createDefaultTuiDependencies({
  async resolveAll() { return { available: [model], missing: [] }; }, async listStatuses() { return []; },
  async registerMany() { throw new Error("Unexpected registration"); }, async removeMany() { throw new Error("Unexpected removal"); },
});
let writing!: () => void, release!: () => void;
const startedWrite = new Promise<void>((resolve) => { writing = resolve; });
const releasedWrite = new Promise<void>((resolve) => { release = resolve; });
const originalAppend = LearnedMemoryStore.prototype.append;
const originalFetch = globalThis.fetch;
const restoreProxy = isolateOfflineModelProxy();
let calls = 0;
LearnedMemoryStore.prototype.append = async function(this: LearnedMemoryStore, ...args: Parameters<LearnedMemoryStore["append"]>) {
  writing();
  await releasedWrite;
  if (failStorage) throw storageFailure;
  await originalAppend.apply(this, args);
};
globalThis.fetch = async () => {
  calls++;
  return new Response(JSON.stringify({ id: "offline", status: "completed", output: [],
    output_text: '{"entries":[{"lesson":"Use pnpm","applyWhen":"Node projects"}]}',
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  }), { headers: { "Content-Type": "application/json" } });
};
const operation = dependencies.rememberMemory!(model, directory, "Use pnpm");
const outcome = operation.then(() => undefined, (error: unknown) => error);
try {
  await startedWrite;
  const first = dependencies.dispose!(), second = dependencies.dispose!();
  let disposed = false;
  const closing = first.then(() => { disposed = true; }, (error: unknown) => { disposed = true; return error; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposed, false, "TUI disposal must wait for manual Memory persistence after provider completion");
  assert.equal(first, second);
  release();
  const disposalFailure = await closing;
  const operationFailure = await outcome;
  if (failStorage) {
    assert.equal(operationFailure, storageFailure);
    assert.ok(disposalFailure instanceof AggregateError);
    assert.deepEqual(disposalFailure.errors, [storageFailure]);
    await assert.rejects(second, (error: unknown) => error === disposalFailure);
  } else {
    assert.equal(disposalFailure, undefined);
    assert.ok(operationFailure);
  }
  assert.equal(calls, 1, "A manual request must not start the shared background queue");
  assert.equal((await store.read("user", directory)).length, 0);
  assert.equal((await store.read("project", directory)).length, 0);
  assert.equal((await store.loadJobs())[0]?.status, "queued");
  const usage = dependencies.getAuxiliaryUsage!();
  assert.equal(usage.input_tokens, 2);
  assert.equal(usage.output_tokens, 1);
  assert.equal(usage.complete, true);
  await assert.rejects(dependencies.rememberMemory!(model, directory, "Another preference"));
  assert.equal(calls, 1);
  process.stdout.write("TUI manual Memory disposal and queue isolation passed\n");
} finally {
  release(); await outcome;
  await dependencies.dispose?.().catch((error: unknown) => {
    assert.ok(failStorage && error instanceof AggregateError && error.errors.includes(storageFailure));
  });
  LearnedMemoryStore.prototype.append = originalAppend;
  globalThis.fetch = originalFetch; restoreProxy();
}
