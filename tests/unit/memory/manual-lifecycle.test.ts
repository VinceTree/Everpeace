import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelStreamCleanupError } from "../../../src/agent/response-errors.js";
import { LearnedMemoryRuntime, LearnedMemoryStore } from "../../../src/memory/learned-memory.js";

const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const response = () => ({ id: "offline-memory", status: "completed", output: [], usage,
  output_text: JSON.stringify({ entries: [{ lesson: "Late preference", applyWhen: "Future conversations" }] }) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function heldMemory() {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-manual-"));
  const store = new LearnedMemoryStore({ directory });
  const started = deferred<void>();
  const release = deferred<ReturnType<typeof response>>();
  let requestSignal: AbortSignal | undefined;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false },
    client: { responses: { async create(_params, options) {
      requestSignal = options?.signal;
      started.resolve();
      return release.promise;
    } } },
  });
  return { directory, store, runtime, started, release, signal: () => requestSignal,
    async cleanup(pending: Promise<unknown>) { release.resolve(response()); await pending; await runtime.dispose().catch(() => undefined); await rm(directory, { recursive: true, force: true }); } };
}

test("manual Memory disposal cancels and joins its request and shares one completion", async () => {
  const fixture = await heldMemory();
  const operation = fixture.runtime.remember(fixture.directory, "Remember a preference");
  const outcome = operation.then(() => undefined, (error: unknown) => error);
  try {
    await fixture.started.promise;
    const first = fixture.runtime.dispose(), second = fixture.runtime.dispose();
    let disposed = false;
    const closing = first.then(() => { disposed = true; });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(first, second);
    assert.equal(fixture.signal()?.aborted, true);
    assert.equal(disposed, false, "An unresolved provider request still belongs to Memory");
    fixture.release.resolve(response());
    await closing;
    assert.ok(await outcome, "Cancelled Memory must reject the late result");
    assert.equal((await fixture.store.read("user", fixture.directory)).length, 0);
    assert.deepEqual((await fixture.runtime.status(fixture.directory)).capture?.usage, usage);
  } finally { await fixture.cleanup(outcome); }
});

test("Memory mutations invalidate a pending manual request before it can write", async (t) => {
  const mutations = ["clear", "disable", "pause capture", "archive", "delete", "foreground"] as const;
  for (const mutation of mutations) await t.test(mutation, async () => {
    const fixture = await heldMemory();
    await fixture.store.append("user", fixture.directory, [{ lesson: "Existing preference", applyWhen: "Prior context" }]);
    const existing = (await fixture.store.read("user", fixture.directory))[0]!;
    const outcome = fixture.runtime.remember(fixture.directory, "Remember a preference").then(() => undefined, (error: unknown) => error);
    try {
      await fixture.started.promise;
      if (mutation === "clear") await fixture.runtime.clear("user", fixture.directory);
      if (mutation === "disable") await fixture.runtime.setEnabled(false);
      if (mutation === "pause capture") fixture.runtime.setPolicy({ captureFuture: false });
      if (mutation === "archive") await fixture.runtime.archive("user", fixture.directory, existing.id);
      if (mutation === "delete") await fixture.runtime.deleteEntry("user", fixture.directory, existing.id);
      if (mutation === "foreground") await fixture.runtime.beginTurn();
      fixture.release.resolve(response());
      assert.ok(await outcome, "An invalidated manual request must reject");
      assert.equal(fixture.signal()?.aborted, true);
      assert.equal((await fixture.store.read("user", fixture.directory)).some((entry) => entry.lesson === "Late preference"), false);
      assert.deepEqual((await fixture.runtime.status(fixture.directory)).capture?.usage, usage);
    } finally { await fixture.cleanup(outcome); }
  });
});

test("caller cancellation retains reliable usage while denying a late manual Memory write", async () => {
  const fixture = await heldMemory();
  const controller = new AbortController();
  const outcome = fixture.runtime.remember(fixture.directory, "Remember a preference", controller.signal).then(() => undefined, (error: unknown) => error);
  try {
    await fixture.started.promise;
    controller.abort(new Error("Command cancelled"));
    fixture.release.resolve(response());
    assert.ok(await outcome);
    assert.equal((await fixture.store.read("user", fixture.directory)).length, 0);
    assert.deepEqual((await fixture.runtime.status(fixture.directory)).capture?.usage, usage);
  } finally { await fixture.cleanup(outcome); }
});

test("manual Memory rechecks invalidation inside a delayed store write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-delayed-write-"));
  const appending = deferred<void>();
  const release = deferred<void>();
  class PausedStore extends LearnedMemoryStore {
    override async append(...args: Parameters<LearnedMemoryStore["append"]>): Promise<void> {
      appending.resolve();
      await release.promise;
      await super.append(...args);
    }
  }
  const store = new PausedStore({ directory });
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false },
    client: { responses: { async create() { return response(); } } },
  });
  const outcome = runtime.remember(directory, "Remember a preference").then(() => undefined, (error: unknown) => error);
  try {
    await appending.promise;
    await runtime.clear("user", directory);
    release.resolve();
    assert.ok(await outcome);
    assert.equal((await store.read("user", directory)).length, 0);
  } finally { release.resolve(); await outcome; await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("cancellation after a committed Memory write does not report success or roll back the entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-committed-write-"));
  const controller = new AbortController();
  class CommittedStore extends LearnedMemoryStore {
    override async append(...args: Parameters<LearnedMemoryStore["append"]>): Promise<void> {
      await super.append(...args);
      controller.abort(new Error("Command cancelled after commit"));
    }
  }
  const store = new CommittedStore({ directory });
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false },
    client: { responses: { async create() { return response(); } } },
  });
  try {
    await assert.rejects(runtime.remember(directory, "Remember a preference", controller.signal));
    assert.equal((await store.read("user", directory))[0]?.lesson, "Late preference");
    assert.deepEqual((await runtime.status(directory)).capture?.usage, usage);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("disposed or globally disabled Memory denies manual request admission", async (t) => {
  for (const state of ["disposed", "disabled"] as const) await t.test(state, async () => {
    const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-closed-"));
    const store = new LearnedMemoryStore({ directory });
    let requests = 0;
    const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false },
      client: { responses: { async create() { requests++; return response(); } } },
    });
    try {
      if (state === "disposed") await runtime.dispose();
      else await runtime.setEnabled(false);
      await assert.rejects(runtime.remember(directory, "Remember a preference"));
      assert.equal(requests, 0);
      assert.equal((await store.read("user", directory)).length, 0);
      assert.deepEqual((await runtime.status(directory)).capture?.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});

test("manual Memory cleanup failure records usage, closes admission, and survives repeated disposal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-cleanup-failure-"));
  const store = new LearnedMemoryStore({ directory });
  const failure = new ModelStreamCleanupError(new Error("Owned reader could not close"), usage);
  let requests = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false },
    client: { responses: { async create() { requests++; throw failure; } } },
  });
  try {
    await assert.rejects(runtime.remember(directory, "Remember a preference"), (error: unknown) => error === failure);
    assert.deepEqual((await runtime.status(directory)).capture?.usage, usage);
    await assert.rejects(runtime.remember(directory, "Another preference"), (error: unknown) => error === failure);
    assert.equal(requests, 1);
    const first = runtime.dispose(), second = runtime.dispose();
    assert.equal(first, second);
    await assert.rejects(first, (error: unknown) => error === failure);
    await assert.rejects(second, (error: unknown) => error === failure);
  } finally { await runtime.dispose().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
});

test("disposal waits for a manual Memory write and retains storage failure over cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-storage-disposal-"));
  const writing = deferred<void>();
  const release = deferred<void>();
  const failure = new Error("Memory append could not be persisted");
  class FailingStore extends LearnedMemoryStore {
    override async append(..._args: Parameters<LearnedMemoryStore["append"]>): Promise<void> {
      writing.resolve(); await release.promise; throw failure;
    }
  }
  const store = new FailingStore({ directory });
  let requests = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false },
    client: { responses: { async create() { requests++; return response(); } } },
  });
  const outcome = runtime.remember(directory, "Remember a preference").then(() => undefined, (error: unknown) => error);
  try {
    await writing.promise;
    const disposing = runtime.dispose();
    let disposed = false;
    const closed = disposing.then(() => { disposed = true; }, (error: unknown) => { disposed = true; return error; });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(disposed, false);
    release.resolve();
    assert.equal(await outcome, failure);
    assert.equal(await closed, failure);
    assert.equal(runtime.dispose(), disposing);
    await assert.rejects(runtime.remember(directory, "Another preference"), (error: unknown) => error === failure);
    assert.equal(requests, 1);
    assert.deepEqual((await runtime.status(directory)).capture?.usage, usage);
  } finally { release.resolve(); await outcome; await runtime.dispose().catch((error: unknown) => { assert.equal(error, failure); }); await rm(directory, { recursive: true, force: true }); }
});

test("a pre-cancelled manual Memory request has no provider attempt or unknown usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-pre-cancelled-"));
  const store = new LearnedMemoryStore({ directory });
  let requests = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false },
    client: { responses: { async create() { requests++; return response(); } } },
  });
  try {
    await assert.rejects(runtime.remember(directory, "Remember a preference", AbortSignal.abort()));
    assert.equal(requests, 0);
    assert.deepEqual((await runtime.status(directory)).capture?.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("manual Memory preserves startup and post-response storage faults through disposal", async (t) => {
  for (const stage of ["startup", "post-response"] as const) await t.test(stage, async () => {
    const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-read-failure-"));
    const failure = new Error(`Memory settings unavailable at ${stage}`);
    let failNextRead = stage === "startup";
    class FailingStore extends LearnedMemoryStore {
      override async isEnabled(): Promise<boolean> {
        if (failNextRead) { failNextRead = false; throw failure; }
        return super.isEnabled();
      }
    }
    const store = new FailingStore({ directory });
    let requests = 0;
    const runtime = new LearnedMemoryRuntime({ store, model: "offline", policy: { captureFuture: false },
      client: { responses: { async create() { requests++; failNextRead = true; return response(); } } },
    });
    try {
      await assert.rejects(runtime.remember(directory, "Remember a preference"), (error: unknown) => error === failure);
      await assert.rejects(runtime.remember(directory, "Another preference"), (error: unknown) => error === failure);
      assert.equal(requests, stage === "startup" ? 0 : 1);
      assert.equal((await store.read("user", directory)).length, 0);
      await assert.rejects(runtime.dispose(), (error: unknown) => error === failure);
    } finally { await runtime.dispose().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
  });
});

test("manual request abort callbacks observe the same reentrant disposal completion", async () => {
  const fixture = await heldMemory();
  const outcome = fixture.runtime.remember(fixture.directory, "Remember a preference").then(() => undefined, (error: unknown) => error);
  let reentrant: Promise<void> | undefined;
  try {
    await fixture.started.promise;
    fixture.signal()!.addEventListener("abort", () => { reentrant = fixture.runtime.dispose(); }, { once: true });
    const closing = fixture.runtime.dispose();
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(reentrant, closing);
    fixture.release.resolve(response());
    await closing;
    assert.ok(await outcome);
  } finally { await fixture.cleanup(outcome); }
});

test("Memory disposal joins an already started clear and preserves its storage fault", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-clear-disposal-"));
  const started = deferred<void>(), release = deferred<void>();
  const failure = new Error("Memory clear could not be persisted");
  class FailingStore extends LearnedMemoryStore {
    override async clear(): Promise<void> { started.resolve(); await release.promise; throw failure; }
  }
  const runtime = new LearnedMemoryRuntime({ store: new FailingStore({ directory }), model: "offline", policy: { captureFuture: false },
    client: { responses: { async create() { throw new Error("Unexpected provider call"); } } },
  });
  const outcome = runtime.clear("user", directory).then(() => undefined, (error: unknown) => error);
  try {
    await started.promise;
    let disposed = false;
    const closing = runtime.dispose().then(() => { disposed = true; }, (error: unknown) => { disposed = true; return error; });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(disposed, false);
    release.resolve();
    assert.equal(await outcome, failure);
    assert.equal(await closing, failure);
  } finally { release.resolve(); await outcome; await runtime.dispose().catch(() => undefined); await rm(directory, { recursive: true, force: true }); }
});

test("automatic Memory rechecks clearing before delayed candidate and entry commits", async (t) => {
  for (const stage of ["candidate", "entry"] as const) await t.test(stage, async () => {
    const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-capture-write-"));
    const started = deferred<void>(), release = deferred<void>();
    class PausedStore extends LearnedMemoryStore {
      override async updateCandidates(...args: Parameters<LearnedMemoryStore["updateCandidates"]>) {
        if (stage === "candidate" && args[1]?.beforeCommit) { started.resolve(); await release.promise; }
        return super.updateCandidates(...args);
      }
      override async append(...args: Parameters<LearnedMemoryStore["append"]>): Promise<void> {
        if (stage === "entry") { started.resolve(); await release.promise; }
        await super.append(...args);
      }
    }
    const store = new PausedStore({ directory });
    let requests = 0;
    const runtime = new LearnedMemoryRuntime({ store, model: "offline", unrefTimers: false,
      client: { responses: { async create() { requests++; return response(); } } },
    });
    try {
      await runtime.finishTurn({ workspacePath: directory, userInput: "Fix a defect", transcript: "Verified local result", assistantText: "done", toolCallCount: 1 }, "verified");
      await started.promise;
      await runtime.clear("project", directory);
      release.resolve();
      await runtime.dispose();
      assert.equal(requests, 1);
      assert.equal((await store.read("project", directory)).length, 0);
      assert.equal((await store.loadCandidates()).length, 0);
      assert.equal((await store.loadJobs()).length, 0);
      assert.notEqual((await runtime.status(directory)).capture?.state, "succeeded");
      assert.deepEqual((await runtime.status(directory)).capture?.usage, usage);
    } finally { release.resolve(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});
