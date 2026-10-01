import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundJobManager } from "../../../src/tools/background-jobs.js";

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
