import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { BackgroundJobManager } from "../../../src/tools/background-jobs.js";
import type { BashOutputPreview, BashResult } from "../../../src/tools/bash.js";
import { ToolFeedbackError } from "../../../src/tools/tool-feedback.js";

const successfulResult: BashResult = { stdout: "done", stderr: "", exitCode: 0, signal: null };
const cancelledResult: BashResult = { stdout: "partial", stderr: "", exitCode: null, signal: null, cancelled: true };

function deferredResult() {
  let resolve!: (result: BashResult) => void;
  const promise = new Promise<BashResult>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("background jobs are bounded, pollable, and cancellable", async () => {
  const resolvers: Array<(value: { stdout: string; stderr: string; exitCode: number | null; signal: null; cancelled?: boolean }) => void> = [];
  const manager = new BackgroundJobManager((_command, signal) => new Promise((resolve) => {
    resolvers.push(resolve);
    signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true }), { once: true });
  }));
  const first = manager.start("one");
  const second = manager.start("two");
  assert.equal(manager.poll(first.job_id)?.status, "running");
  assert.throws(() => manager.start("three"), /at most 2/iu);
  await manager.stop(first.job_id);
  resolvers[1]?.({ stdout: "done", stderr: "", exitCode: 0, signal: null });
  const jobs = await manager.waitAll();
  assert.equal(jobs.find((job) => job.job_id === first.job_id)?.status, "cancelled");
  assert.equal(jobs.find((job) => job.job_id === second.job_id)?.status, "completed");
});

test("background jobs inherit task cancellation and expose running output", async () => {
  const task = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const manager = new BackgroundJobManager((_command, signal, _timeout, onOutput) => new Promise((resolve) => {
    observedSignal = signal;
    onOutput({ headLines: ["building"], tailLines: [], omittedLines: 0 });
    signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true }), { once: true });
  }));
  const job = manager.start("build", task.signal);
  assert.deepEqual(manager.poll(job.job_id)?.preview?.headLines, ["building"]);
  task.abort(new Error("cancelled by user"));
  const jobs = await manager.waitAll();
  assert.equal(observedSignal?.aborted, true);
  assert.equal(jobs[0]?.status, "cancelled");
});

test("disposing background jobs waits for aborted workers to settle", async () => {
  let settled = false;
  const manager = new BackgroundJobManager((_command, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      setTimeout(() => {
        settled = true;
        resolve({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true });
      }, 10);
    }, { once: true });
  }));
  manager.start("writer");
  const jobs = await manager.dispose();
  assert.equal(settled, true);
  assert.equal(jobs[0]?.status, "cancelled");
});

test("background jobs report one bounded completion after terminal state is established", async () => {
  const completions: Array<{ job_id: string; status: string; exit_code: number | null; finished_at: string }> = [];
  const manager = new BackgroundJobManager(async (command) => command === "fail"
    ? { stdout: "", stderr: "failed", exitCode: 7, signal: null }
    : { stdout: "done", stderr: "", exitCode: 0, signal: null });
  const completed = manager.start("pass", undefined, (value) => completions.push(value));
  const failed = manager.start("fail", undefined, (value) => completions.push(value));
  await manager.waitAll();
  assert.deepEqual(completions.map((value) => [value.job_id, value.status, value.exit_code]), [
    [completed.job_id, "completed", 0],
    [failed.job_id, "failed", 7],
  ]);
  assert.ok(completions.every((value) => Boolean(value.finished_at)));
  assert.equal(completions.length, 2);
});

test("background settlement reports timeout and cancellation without trusting observers", async () => {
  const completions: Array<{ job_id: string; status: string; exit_code: number | null }> = [];
  const manager = new BackgroundJobManager((command, signal) => {
    if (command === "timeout") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: null, signal: null, timedOut: true });
    }
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ stdout: "", stderr: "", exitCode: null, signal: null, cancelled: true }), { once: true });
    });
  });
  const timedOut = manager.start("timeout", undefined, (value) => completions.push(value));
  const cancelled = manager.start("cancel", undefined, (value) => completions.push(value));
  await manager.stop(cancelled.job_id);
  await manager.waitAll();
  assert.deepEqual(completions.map((value) => [value.job_id, value.status, value.exit_code]), [
    [timedOut.job_id, "timed_out", null],
    [cancelled.job_id, "cancelled", null],
  ]);

  const isolated = new BackgroundJobManager(async () => ({ stdout: "ok", stderr: "", exitCode: 0, signal: null }));
  const job = isolated.start("pass", undefined, () => { throw new Error("observer failed"); });
  await isolated.waitAll();
  assert.equal(isolated.poll(job.job_id)?.status, "completed");
});

test("synchronous startup failure settles one registered job and detaches its parent", async () => {
  const parent = new AbortController();
  const completions: string[] = [];
  const manager = new BackgroundJobManager(() => { throw new Error("launch failed"); });
  const job = manager.start("broken", parent.signal, (completion) => {
    const snapshot = manager.poll(completion.job_id);
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot.finished_at, completion.finished_at);
    assert.equal(snapshot.result?.error, "launch failed");
    completions.push(completion.job_id);
  });
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  await manager.waitAll();
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.deepEqual(completions, [job.job_id]);
  assert.equal((await manager.stop(job.job_id))?.status, "failed");
  assert.deepEqual(completions, [job.job_id]);
  await manager.dispose();
});

test("pre-cancelled start does not invoke the worker or retain a job", async () => {
  const parent = new AbortController();
  const reason = new Error("already cancelled");
  parent.abort(reason);
  let starts = 0, completions = 0;
  const manager = new BackgroundJobManager(async () => { starts++; return successfulResult; });
  assert.throws(() => manager.start("unused", parent.signal, () => { completions++; }), (error) => error === reason);
  assert.equal(starts, 0);
  assert.equal(completions, 0);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.deepEqual(await manager.waitAll(), []);
  await assert.rejects(manager.waitAll(parent.signal), (error) => error === reason);
  await manager.dispose();
});

test("registered startup slots enforce the running limit during worker reentry", async (t) => {
  const gate = deferredResult();
  const starts: string[] = [];
  let overflow: unknown;
  let manager: BackgroundJobManager;
  manager = new BackgroundJobManager((command) => {
    starts.push(command);
    if (command === "outer") {
      manager.start("inner");
      try { manager.start("overflow"); } catch (error) { overflow = error; }
    }
    return gate.promise;
  });
  t.after(async () => { gate.resolve(cancelledResult); await manager.dispose(); });
  manager.start("outer");
  assert.deepEqual(starts, ["outer", "inner"]);
  assert.ok(overflow instanceof ToolFeedbackError);
  assert.equal(overflow.code, "BACKGROUND_LIMIT");
  gate.resolve(successfulResult);
  assert.equal((await manager.waitAll()).length, 2);
});

test("dispose invoked during startup owns and waits for the registered worker", async (t) => {
  const gate = deferredResult();
  let manager: BackgroundJobManager;
  let cleanup: Promise<unknown> | undefined;
  let cleanupFinished = false;
  let workerSignal: AbortSignal | undefined;
  manager = new BackgroundJobManager((_command, signal) => {
    workerSignal = signal;
    cleanup = manager.dispose().then((jobs) => { cleanupFinished = true; return jobs; });
    return gate.promise;
  });
  t.after(async () => { gate.resolve(cancelledResult); await manager.dispose(); });
  const job = manager.start("reentrant disposal");
  assert.equal(workerSignal?.aborted, true);
  assert.ok(cleanup);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupFinished, false);
  assert.equal(manager.poll(job.job_id)?.status, "running");
  gate.resolve(cancelledResult);
  await cleanup;
  assert.equal(cleanupFinished, true);
  assert.equal(manager.poll(job.job_id)?.status, "cancelled");
});

test("terminal snapshots publish result and finish time together", async () => {
  const worker = Promise.resolve(successfulResult);
  const manager = new BackgroundJobManager(() => worker);
  const job = manager.start("quick");
  await new Promise<void>((resolve, reject) => {
    void worker.then(() => queueMicrotask(() => {
      try {
        const snapshot = manager.poll(job.job_id);
        assert.ok(snapshot);
        if (snapshot.status !== "running") {
          assert.ok(snapshot.finished_at);
          assert.equal(snapshot.result?.stdout, "done");
        }
        resolve();
      } catch (error) { reject(error); }
    }));
  });
  const settled = await manager.waitAll();
  assert.ok(settled[0]?.finished_at);
  assert.equal(settled[0]?.status, "completed");
  await manager.dispose();
});

test("settled jobs ignore late previews and keep result snapshots isolated", async () => {
  let output!: (preview: BashOutputPreview) => void;
  const result = { ...successfulResult };
  const manager = new BackgroundJobManager(async (_command, _signal, _timeout, onOutput) => {
    output = onOutput;
    output({ headLines: ["original"], tailLines: [], omittedLines: 0 });
    return result;
  });
  const job = manager.start("quick");
  await manager.waitAll();
  const snapshot = manager.poll(job.job_id);
  assert.ok(snapshot?.preview && snapshot.result);
  snapshot.preview.headLines[0] = "caller mutation";
  snapshot.result.stdout = "caller output";
  result.stdout = "worker mutation";
  output({ headLines: ["late"], tailLines: [], omittedLines: 0 });
  assert.deepEqual(manager.poll(job.job_id)?.preview?.headLines, ["original"]);
  assert.equal(manager.poll(job.job_id)?.result?.stdout, "done");
  await manager.dispose();
});

test("overlapping cleanup blocks new workers until every registered worker settles", async (t) => {
  const gates = [deferredResult(), deferredResult()];
  let starts = 0, cancellations = 0, cleanupsFinished = 0;
  let preview!: (output: BashOutputPreview) => void;
  const manager = new BackgroundJobManager((_command, signal, _timeout, onOutput) => {
    const index = starts++;
    signal.addEventListener("abort", () => { cancellations++; }, { once: true });
    preview = onOutput;
    return gates[index]?.promise ?? Promise.resolve(successfulResult);
  });
  t.after(async () => { gates.forEach((gate) => gate.resolve(cancelledResult)); await manager.dispose(); });
  manager.start("first");
  const second = manager.start("second");
  const stopped = manager.stop(second.job_id);
  const firstCleanup = manager.stopAll().then((jobs) => { cleanupsFinished++; return jobs; });
  const secondCleanup = manager.stopAll().then((jobs) => { cleanupsFinished++; return jobs; });
  const blocked = () => assert.throws(() => manager.start("late"), (error) => error instanceof ToolFeedbackError && error.code === "BACKGROUND_CLEANUP");
  blocked();
  preview({ headLines: ["cleanup output"], tailLines: [], omittedLines: 0 });
  assert.deepEqual(manager.poll(second.job_id)?.preview?.headLines, ["cleanup output"]);
  gates[0]!.resolve(cancelledResult);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupsFinished, 0);
  blocked();
  assert.equal(cancellations, 2);
  gates[1]!.resolve(cancelledResult);
  const [one, two, single] = await Promise.all([firstCleanup, secondCleanup, stopped]);
  assert.deepEqual(one, two);
  assert.equal(single?.status, "cancelled");
  assert.equal(cleanupsFinished, 2);
  assert.equal(starts, 2);
  manager.start("next task");
  assert.equal(starts, 3);
  await manager.waitAll();
});

test("dispose closes admission immediately and repeated calls wait for the same cleanup", async (t) => {
  const gate = deferredResult();
  let cancelled = 0, finished = false;
  const manager = new BackgroundJobManager((_command, signal) => {
    signal.addEventListener("abort", () => { cancelled++; }, { once: true });
    return gate.promise;
  });
  t.after(async () => { gate.resolve(cancelledResult); await manager.dispose(); });
  const job = manager.start("worker");
  const first = manager.dispose();
  const second = manager.dispose();
  void first.then(() => { finished = true; });
  assert.equal(first, second);
  assert.equal(cancelled, 1);
  assert.equal(finished, false);
  assert.throws(() => manager.start("after dispose"), (error) => error instanceof ToolFeedbackError && error.code === "BACKGROUND_DISPOSED");
  gate.resolve(cancelledResult);
  assert.deepEqual(await first, await second);
  assert.equal((await manager.stop(job.job_id))?.status, "cancelled");
  assert.throws(() => manager.start("still disposed"), /disposed/iu);
});
