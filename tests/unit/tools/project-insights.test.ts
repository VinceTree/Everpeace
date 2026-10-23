import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { projectInsights } from "../../../src/tools/project-insights.js";
import { ResourceCleanupError } from "../../../src/util/resource-cleanup-error.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const opened = (text = "export { value } from './source.js';") => ({ exists: true, bytes: Buffer.from(text), extra: Buffer.alloc(0) });
const root = path.resolve("synthetic-insight-fixture");
class InsightCleanupError extends ResourceCleanupError { readonly resource = "process" as const; }

test("insight reads run in bounded batches and apply byte limits in file order", async () => {
  const ready = deferred<void>();
  const reads = Array.from({ length: 4 }, () => deferred<ReturnType<typeof opened>>());
  const names = Array.from({ length: 8 }, (_, index) => `source-${index}.ts`);
  let calls = 0;
  const pending = projectInsights(root, names, undefined, async () => {
    const index = calls++;
    if (calls === 4) ready.resolve();
    return index < 4 ? reads[index]!.promise : opened("x".repeat(64 * 1024));
  });
  await ready.promise;
  assert.equal(calls, 4);
  // Reverse completion order must not change which four files consume the byte budget.
  for (const read of [...reads].reverse()) read.resolve(opened("x".repeat(64 * 1024)));
  const result = await pending;
  assert.equal(calls, 8);
  assert.deepEqual(result.modules.map(module => module.path), names.slice(0, 4));
  assert.equal(result.incomplete, true);
});

test("insight cancellation waits for every in-flight read and starts no further batch", async () => {
  const controller = new AbortController();
  const ready = deferred<void>();
  const reads = Array.from({ length: 4 }, () => deferred<ReturnType<typeof opened>>());
  let calls = 0;
  let settled = false;
  const pending = projectInsights(root, Array.from({ length: 8 }, (_, index) => `cancel-${index}.ts`), controller.signal, async () => {
    const index = calls++;
    if (calls === 4) ready.resolve();
    return reads[index]!.promise;
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = assert.rejects(pending, /fixture cancel/u);
  await ready.promise;
  controller.abort(new Error("fixture cancel"));
  reads[0]!.reject(new Error("read cancelled"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(calls, 4);
  for (const read of reads.slice(1)) read.resolve(opened());
  await rejected;
  assert.equal(calls, 4);
});

test("insight cleanup failure survives concurrent cancellation after all reads settle", async () => {
  const controller = new AbortController();
  const ready = deferred<void>();
  const last = deferred<ReturnType<typeof opened>>();
  const failure = new InsightCleanupError("fixture ownership unresolved");
  let calls = 0;
  const pending = projectInsights(root, ["bad.ts", "late.ts", "ok.ts", "ok2.ts", "never.ts"], controller.signal, async () => {
    const index = calls++;
    if (calls === 4) ready.resolve();
    if (index === 0) throw failure;
    if (index === 1) return last.promise;
    return opened();
  });
  const rejected = assert.rejects(pending, error => error === failure);
  await ready.promise;
  controller.abort(new Error("cancel"));
  last.resolve(opened());
  await rejected;
  assert.equal(calls, 4);
});

test("insights re-read current bytes and reject pre-cancellation without reading", async () => {
  let text = "import value from './first.js';";
  let calls = 0;
  const read = async () => { calls++; return opened(text); };
  const first = await projectInsights(root, ["changing.ts"], undefined, read);
  text = "import value from './second.js';";
  const second = await projectInsights(root, ["changing.ts"], undefined, read);
  assert.deepEqual(first.modules[0]?.imports, ["./first.js"]);
  assert.deepEqual(second.modules[0]?.imports, ["./second.js"]);
  assert.notEqual(first.modules[0]?.sha256, second.modules[0]?.sha256);
  const controller = new AbortController(); controller.abort(new Error("pre-cancel"));
  await assert.rejects(projectInsights(root, ["never.ts"], controller.signal, read), /pre-cancel/u);
  assert.equal(calls, 2);
});
