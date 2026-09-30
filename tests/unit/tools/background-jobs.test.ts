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
