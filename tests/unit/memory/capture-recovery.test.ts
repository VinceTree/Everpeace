import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ModelStreamCleanupError } from "../../../src/agent/response-errors.js";
import { LearnedMemoryRuntime, LearnedMemoryStore } from "../../../src/memory/learned-memory.js";

type CaptureJobs = Awaited<ReturnType<LearnedMemoryStore["loadJobs"]>>;
const knownUsage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function enqueue(runtime: LearnedMemoryRuntime, directory: string): Promise<void> {
  await runtime.finishTurn({ workspacePath: directory, userInput: "Fix the defect", transcript: "Verified local evidence",
    assistantText: "done", toolCallCount: 1 }, "verified");
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await new Promise<void>((done) => setTimeout(done, 10));
  }
  assert.fail("Memory did not reach the observed durable state");
}

function staleJob(directory: string) {
  return { id: "interrupted", turn: { workspacePath: directory, userInput: "Fix the defect", transcript: "Verified evidence", assistantText: "done", toolCallCount: 1 },
    outcome: "verified", createdAt: new Date(0).toISOString(), notBefore: new Date(0).toISOString(), attempts: 0, status: "running" };
}

test("interrupted or unknown Memory jobs do not regain admission after runtime reconstruction", async (t) => {
  const cases = [
    { name: "legacy running job", fields: {} },
    { name: "unsettled request", fields: { requestPending: true, usageComplete: true } },
    { name: "settled unknown request", fields: { requestPending: false, usageComplete: false } },
    { name: "queued unknown job", fields: { status: "queued", requestPending: false, usageComplete: false } },
    { name: "legacy queued retry", fields: { status: "queued", attempts: 1 } },
    { name: "legacy queued cancellation", fields: { status: "queued", error: "Foreground work resumed" } },
    { name: "legacy queued extracted response", fields: { status: "queued", extracted: [] } },
    { name: "invalid queued pending marker", fields: { status: "queued", requestPending: "false", usageComplete: true } },
    { name: "invalid queued completion marker", fields: { status: "queued", requestPending: false, usageComplete: "true" } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-recovery-"));
    await writeFile(join(directory, "capture-jobs.json"), JSON.stringify([{ ...staleJob(directory), ...scenario.fields }]));
    const store = new LearnedMemoryStore({ directory });
    let requests = 0;
    const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
      client: { responses: { async create() { requests++; return { id: "unexpected", output: [], output_text: '{"entries":[]}' }; } } },
    });
    try {
      await waitFor(async () => {
        const jobs = await store.loadJobs();
        return requests > 0 || jobs.length === 0 || jobs.some((job) => job.status === "failed");
      });
      assert.equal(requests, 0, "Interrupted accounting must be settled before any replacement request");
      assert.equal((await store.loadJobs())[0]?.status, "failed");
      assert.equal((await runtime.status(directory)).capture?.usage, null);
    } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});

test("a reliably settled interrupted Memory job resumes its extracted entries without repeating extraction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-recovery-"));
  await writeFile(join(directory, "capture-jobs.json"), JSON.stringify([{ ...staleJob(directory), requestPending: false, usageComplete: true,
    extracted: [{ lesson: "Restore the settled result", applyWhen: "Continuing a verified task" }] }]));
  const store = new LearnedMemoryStore({ directory });
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create() { assert.fail("Extraction was already persisted"); } } },
  });
  try {
    await waitFor(async () => (await store.read("project", directory)).length === 1 && (await store.loadJobs()).length === 0);
    assert.equal((await store.read("project", directory))[0]?.lesson, "Restore the settled result");
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("never-started legacy queues and reliably settled interrupted jobs retain request admission", async (t) => {
  for (const scenario of ["legacy queued", "settled running"] as const) await t.test(scenario, async () => {
    const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-safe-recovery-"));
    const job = { ...staleJob(directory), ...(scenario === "legacy queued"
      ? { status: "queued" } : { requestPending: false, usageComplete: true }) };
    await writeFile(join(directory, "capture-jobs.json"), JSON.stringify([job]));
    const store = new LearnedMemoryStore({ directory });
    let requests = 0;
    const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
      client: { responses: { async create() { requests++; return { id: "known", output: [], output_text: '{"entries":[]}', usage: knownUsage }; } } },
    });
    try {
      await waitFor(async () => (await store.loadJobs()).length === 0);
      await runtime.dispose();
      assert.equal(requests, 1);
      assert.deepEqual((await runtime.status(directory)).capture?.usage, knownUsage);
    } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
  });
});

test("request checkpoint failure never admits or automatically retries a Memory request", async (t) => {
  for (const transition of ["start", "settle"] as const) for (const phase of ["before write", "after write"] as const) {
    await t.test(`${transition}: ${phase}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-checkpoint-"));
      let injected = false;
      class CheckpointStore extends LearnedMemoryStore {
        override async updateJobs(update: (jobs: CaptureJobs) => CaptureJobs): Promise<CaptureJobs> {
          let checkpoint = false;
          const result = await super.updateJobs((jobs) => {
            const changed = update(jobs);
            checkpoint = !injected && changed.some((job) => job.status === "running" && jobs.some((previous) =>
              previous.id === job.id && previous.status === "running" && (transition === "start"
                ? previous.requestPending === false && job.requestPending === true
                : previous.requestPending === true && job.requestPending === false)));
            if (checkpoint) {
              injected = true;
              if (phase === "before write") throw new Error("Request checkpoint write failed");
            }
            return changed;
          });
          if (checkpoint && phase === "after write") throw new Error("Request checkpoint lock release failed");
          return result;
        }
      }
      const store = new CheckpointStore({ directory });
      let requests = 0;
      const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
        client: { responses: { async create() {
          requests++;
          return { id: "known", output: [], output_text: '{"entries":[]}', usage: knownUsage };
        } } },
      });
      try {
        await enqueue(runtime, directory);
        await waitFor(async () => (await store.loadJobs())[0]?.status === "failed");
        await runtime.dispose();
        assert.equal(injected, true, JSON.stringify(await store.loadJobs()));
        assert.equal(requests, transition === "start" ? 0 : 1);
        assert.deepEqual((await runtime.status(directory)).capture?.usage,
          transition === "start" ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 } : knownUsage);
        assert.equal((await store.loadJobs())[0]?.attempts, 1);
      } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
  }
});

test("persistent storage failure reports failed capture while preserving the unsettled marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-storage-failure-"));
  const failedWrites = deferred<void>();
  let failures = 0;
  class FailingStore extends LearnedMemoryStore {
    override async updateJobs(update: (jobs: CaptureJobs) => CaptureJobs): Promise<CaptureJobs> {
      return super.updateJobs((jobs) => {
        const changed = update(jobs);
        if (jobs.some((job) => job.requestPending === true)) {
          failures++;
          if (failures === 2) failedWrites.resolve();
          throw new Error("Capture storage is unavailable");
        }
        return changed;
      });
    }
  }
  const store = new FailingStore({ directory });
  let requests = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create() { requests++; return { id: "known", output: [], output_text: '{"entries":[]}', usage: knownUsage }; } } },
  });
  try {
    await enqueue(runtime, directory);
    await failedWrites.promise;
    await runtime.dispose();
    assert.equal(requests, 1);
    assert.equal((await runtime.status(directory)).capture?.state, "failed");
    assert.deepEqual((await runtime.status(directory)).capture?.usage, knownUsage);
    assert.match((await runtime.status(directory)).capture?.error ?? "", /storage|saved/i);
    const job = (await store.loadJobs())[0]!;
    assert.equal(job.status, "running");
    assert.equal(job.requestPending, true);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("cleanup failure keeps reliable usage and precedence when settlement and failure persistence both fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-cleanup-storage-"));
  const failedWrites = deferred<void>();
  let failures = 0;
  class FailingStore extends LearnedMemoryStore {
    override async updateJobs(update: (jobs: CaptureJobs) => CaptureJobs): Promise<CaptureJobs> {
      return super.updateJobs((jobs) => {
        const changed = update(jobs);
        if (jobs.some((job) => job.requestPending === true)) {
          failures++;
          if (failures === 2) failedWrites.resolve();
          throw new Error("Capture storage is unavailable");
        }
        return changed;
      });
    }
  }
  const store = new FailingStore({ directory });
  const failure = new ModelStreamCleanupError(new Error("Owned reader failed to close"), knownUsage);
  let requests = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create() { requests++; throw failure; } } },
  });
  try {
    await enqueue(runtime, directory);
    await failedWrites.promise;
    await assert.rejects(runtime.dispose(), (error: unknown) => error === failure);
    assert.equal(requests, 1);
    const capture = (await runtime.status(directory)).capture!;
    assert.equal(capture.state, "failed");
    assert.deepEqual(capture.usage, knownUsage);
    assert.match(capture.error ?? "", /Owned reader failed to close/);
    assert.equal((await store.loadJobs())[0]?.requestPending, true);
  } finally { await runtime.dispose().catch((error: unknown) => { assert.equal(error, failure); }); await rm(directory, { recursive: true, force: true }); }
});

test("cancellation during the durable start checkpoint waits and preserves a never-started job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-checkpoint-cancel-"));
  const checkpoint = deferred<void>();
  const release = deferred<void>();
  class PausedStore extends LearnedMemoryStore {
    override async updateJobs(update: (jobs: CaptureJobs) => CaptureJobs): Promise<CaptureJobs> {
      let started = false;
      const result = await super.updateJobs((jobs) => {
        const changed = update(jobs);
        started = changed.some((job) => job.status === "running" && job.requestPending === true
          && jobs.some((previous) => previous.id === job.id && previous.requestPending === false));
        return changed;
      });
      if (started) { checkpoint.resolve(); await release.promise; }
      return result;
    }
  }
  const store = new PausedStore({ directory });
  let requests = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create() { requests++; assert.fail("Cancelled before provider admission"); } } },
  });
  try {
    await enqueue(runtime, directory);
    await checkpoint.promise;
    let disposed = false;
    const disposing = runtime.dispose().then(() => { disposed = true; });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(disposed, false, "Disposal must join the in-flight durable checkpoint");
    release.resolve();
    await disposing;
    assert.equal(requests, 0);
    const job = (await store.loadJobs())[0]!;
    assert.equal(job.status, "queued");
    assert.equal(job.requestPending, false);
    assert.equal(job.usageComplete, true);
    assert.equal(job.attempts, 0);
    assert.deepEqual((await runtime.status(directory)).capture?.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  } finally { release.resolve(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("late reliable usage is retained without writing a result after cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-late-cancel-"));
  const started = deferred<void>();
  const response = deferred<{ id: string; output: []; output_text: string; usage: typeof knownUsage }>();
  const store = new LearnedMemoryStore({ directory });
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create() { started.resolve(); return response.promise; } } },
  });
  try {
    await enqueue(runtime, directory);
    await started.promise;
    const disposing = runtime.dispose();
    response.resolve({ id: "late", output: [], output_text: '{"entries":[{"lesson":"Late result","applyWhen":"Cancelled work"}]}', usage: knownUsage });
    await disposing;
    assert.deepEqual((await runtime.status(directory)).capture?.usage, knownUsage);
    assert.equal((await store.read("project", directory)).length, 0);
    const job = (await store.loadJobs())[0]!;
    assert.equal(job.status, "queued");
    assert.equal(job.requestPending, false);
    assert.equal(job.usageComplete, true);
  } finally {
    response.resolve({ id: "cleanup", output: [], output_text: '{"entries":[]}', usage: knownUsage });
    await runtime.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test("a lost lease cannot be settled or removed by the previous Memory owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-lease-"));
  const started = deferred<void>();
  const response = deferred<{ id: string; output: []; output_text: string; usage: typeof knownUsage }>();
  const store = new LearnedMemoryStore({ directory });
  let requests = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create() { requests++; started.resolve(); return response.promise; } } },
  });
  try {
    await enqueue(runtime, directory);
    await started.promise;
    const replacementLease = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    await store.updateJobs((jobs) => jobs.map((job) => ({ ...job, notBefore: replacementLease })));
    response.resolve({ id: "late", output: [], output_text: '{"entries":[{"lesson":"Old owner","applyWhen":"Lost lease"}]}', usage: knownUsage });
    await waitFor(async () => (await runtime.status(directory)).capture?.state === "failed");
    await runtime.dispose();
    assert.equal(requests, 1);
    assert.deepEqual((await runtime.status(directory)).capture?.usage, knownUsage);
    assert.equal((await store.read("project", directory)).length, 0);
    const job = (await store.loadJobs())[0]!;
    assert.equal(job.status, "running");
    assert.equal(job.notBefore, replacementLease);
    assert.equal(job.requestPending, true);
    assert.equal(job.error, undefined);
  } finally {
    response.resolve({ id: "cleanup", output: [], output_text: '{"entries":[]}', usage: knownUsage });
    await runtime.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test("a second runtime respects a live request lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-live-lease-"));
  const started = deferred<void>();
  const response = deferred<{ id: string; output: []; output_text: string; usage: typeof knownUsage }>();
  const store = new LearnedMemoryStore({ directory });
  let requests = 0;
  const client = { responses: { async create() { requests++; started.resolve(); return response.promise; } } };
  const first = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false, client });
  let second: LearnedMemoryRuntime | undefined;
  try {
    await enqueue(first, directory);
    await started.promise;
    const lease = (await store.loadJobs())[0]!;
    second = new LearnedMemoryRuntime({ store: new LearnedMemoryStore({ directory }), model: "offline", idleDelayMs: 0, unrefTimers: false, client });
    await second.loadPrompt(directory);
    assert.equal(requests, 1);
    assert.deepEqual((await store.loadJobs())[0], lease);
    response.resolve({ id: "done", output: [], output_text: '{"entries":[]}', usage: knownUsage });
    await waitFor(async () => (await store.loadJobs()).length === 0);
    assert.equal(requests, 1);
  } finally {
    response.resolve({ id: "cleanup", output: [], output_text: '{"entries":[]}', usage: knownUsage });
    await first.dispose(); await second?.dispose(); await rm(directory, { recursive: true, force: true });
  }
});

test("a failed unknown job retains the accounting gap across another reconstruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-unknown-retained-"));
  const store = new LearnedMemoryStore({ directory });
  let requests = 0;
  const client = { responses: { async create() { requests++; throw new Error("No reliable request usage"); } } };
  const first = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false, client });
  let second: LearnedMemoryRuntime | undefined;
  try {
    await enqueue(first, directory);
    await waitFor(async () => (await store.loadJobs())[0]?.status === "failed");
    await first.dispose();
    const job = (await store.loadJobs())[0]!;
    assert.equal(job.requestPending, false);
    assert.equal(job.usageComplete, false);
    second = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false, client });
    await second.loadPrompt(directory);
    assert.equal(requests, 1);
    assert.equal((await second.status(directory)).capture?.usage, null);
  } finally { await first.dispose(); await second?.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("an actual process interruption leaves a durable request marker and prevents automatic replay", { timeout: 30_000 }, async (t) => {
  for (const phase of ["extraction", "consolidation"] as const) await t.test(phase, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "everpeace-memory-crash-"));
    const child = fork(resolve("tests/fixtures/memory-capture-crash.ts"), [directory, phase], {
      cwd: directory, execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (value: string) => { stderr += value; });
    const closed = once(child, "close");
    let runtime: LearnedMemoryRuntime | undefined;
    try {
      const [message] = await Promise.race([
        once(child, "message", { signal: t.signal }),
        closed.then(() => { throw new Error(`The Memory fixture exited before admission: ${stderr}`); }),
      ]);
      assert.deepEqual(message, { type: "request_started" });
      const jobs = JSON.parse(await readFile(join(directory, "capture-jobs.json"), "utf8")) as CaptureJobs;
      assert.equal(jobs[0]?.requestPending, true, "The request checkpoint must be durable before provider admission");
      assert.equal(jobs[0]?.usageComplete, true);
      assert.equal(jobs[0]?.extracted?.length, phase === "consolidation" ? 2 : undefined);
      child.kill("SIGKILL");
      await closed;
      const store = new LearnedMemoryStore({ directory });
      await store.updateJobs((current) => current.map((job) => ({ ...job, notBefore: new Date(0).toISOString() })));
      let requests = 0;
      runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
        client: { responses: { async create() { requests++; return { id: "unexpected", output: [], output_text: '{"entries":[]}' }; } } },
      });
      await waitFor(async () => requests > 0 || (await store.loadJobs()).some((job) => job.status === "failed"));
      assert.equal(requests, 0);
      assert.equal((await store.loadJobs())[0]?.status, "failed");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await runtime?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
