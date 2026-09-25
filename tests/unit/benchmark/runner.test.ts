import assert from "node:assert/strict";
import { test } from "node:test";
import { runBenchmarkSuite, runBenchmarkTask } from "../../../src/benchmark/runner.js";
import type { BenchmarkHarnessAdapter, BenchmarkTask } from "../../../src/benchmark/types.js";

const task = (overrides: Partial<BenchmarkTask> = {}): BenchmarkTask => ({
  id: "fixture",
  prompt: "make the fixture pass",
  workspacePath: process.cwd(),
  ...overrides,
});

test("benchmark task runs a harness and verifies its result", async () => {
  const adapter: BenchmarkHarnessAdapter = {
    name: "fixture-harness",
    async run(_task, context) {
      context.onPhase("sampling");
      context.onEvent({ type: "response_received", response: { output: [], output_text: "done" } });
      context.onPhase("completed");
    },
  };
  const result = await runBenchmarkTask(task({
    verification: { command: "node", args: ["-e", "process.stdout.write('ok')"] },
  }), adapter);

  assert.equal(result.status, "passed");
  assert.equal(result.verification?.passed, true);
  assert.equal(result.metrics.responses, 1);
  assert.deepEqual(result.metrics.phases, ["sampling", "completed"]);
});

test("verification defaults to the task workspace", async () => {
  const adapter: BenchmarkHarnessAdapter = {
    name: "fixture-harness",
    async run() {},
  };
  const result = await runBenchmarkTask(task({
    verification: {
      command: "node",
      args: ["-e", "process.stdout.write(process.cwd())"],
    },
  }), adapter);

  assert.equal(result.status, "passed");
  assert.equal(result.verification?.stdout, process.cwd());
});

test("verification failure is reported separately from harness errors", async () => {
  const adapter: BenchmarkHarnessAdapter = {
    name: "fixture-harness",
    async run() {},
  };
  const result = await runBenchmarkTask(task({
    verification: { command: "node", args: ["-e", "process.exit(3)"] },
  }), adapter);

  assert.equal(result.status, "failed");
  assert.equal(result.verification?.exitCode, 3);
  assert.equal(result.verification?.passed, false);
});

test("verification timeout terminates the process tree", async () => {
  const adapter: BenchmarkHarnessAdapter = {
    name: "fixture-harness",
    async run() {},
  };
  const result = await runBenchmarkTask(task({
    timeoutMs: 2_000,
    verification: {
      command: "node",
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 10,
    },
  }), adapter);

  assert.equal(result.status, "timed_out");
  assert.equal(result.verification?.timedOut, true);
});

test("task timeout stops waiting for an adapter that ignores cancellation", async () => {
  const adapter: BenchmarkHarnessAdapter = {
    name: "slow-harness",
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
  const started = Date.now();
  const result = await runBenchmarkTask(task({ timeoutMs: 10 }), adapter);

  assert.equal(result.status, "timed_out");
  assert.ok(Date.now() - started < 90);
});

test("unsafe actions fail the run and suite aggregates reliability metrics", async () => {
  const adapter: BenchmarkHarnessAdapter = {
    name: "unsafe-harness",
    async run(_task, context) {
      context.onEvent({ type: "retrying", attempt: 1, delayMs: 1, category: "server" });
      return { unsafeActions: 1, manualInterventions: 2 };
    },
  };
  const summary = await runBenchmarkSuite([task({ id: "one" }), task({ id: "two" })], adapter);

  assert.equal(summary.total, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.completionRate, 0);
  assert.equal(summary.totalRetries, 2);
  assert.equal(summary.totalManualInterventions, 4);
  assert.equal(summary.unsafeActions, 2);
});
