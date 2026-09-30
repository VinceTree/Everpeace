import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileBenchmarkArtifactSink } from "../../../src/benchmark/artifacts.js";
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

test("live repeated benchmarks require a token budget and isolated preparation", async () => {
  const adapter: BenchmarkHarnessAdapter = { name: "live", async run() {} };
  await assert.rejects(
    runBenchmarkSuite([task()], adapter, { liveApi: true }),
    /total token budget/u,
  );
  await assert.rejects(
    runBenchmarkSuite([task()], adapter, { repetitions: 3, totalTokenBudget: 1_000 }),
    /prepareRun/u,
  );
});

test("benchmark repetitions aggregate token, reasoning, and cache metrics", async () => {
  const prepared: number[] = [];
  const budgets: number[] = [];
  const adapter: BenchmarkHarnessAdapter = {
    name: "metered",
    async run(_task, context) {
      budgets.push(context.tokenBudgetRemaining ?? 0);
      return {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 10,
          cachedInputTokens: 60,
          cacheObservedInputTokens: 100,
          complete: true,
        },
      };
    },
  };
  const summary = await runBenchmarkSuite([task()], adapter, {
    liveApi: true,
    totalTokenBudget: 1_000,
    repetitions: 3,
    async prepareRun(_task, repetition) { prepared.push(repetition); },
  });
  assert.equal(summary.total, 3);
  assert.equal(summary.repetitions, 3);
  assert.deepEqual(prepared, [1, 2, 3]);
  assert.deepEqual(budgets, [1_000, 880, 760]);
  assert.deepEqual(summary.usage, {
    inputTokens: 300,
    outputTokens: 60,
    reasoningTokens: 30,
    cachedInputTokens: 180,
    cacheObservedInputTokens: 300,
    complete: true,
  });
});

test("verification failures enter a bounded diagnose loop with prior output", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-benchmark-"));
  const verificationScript = join(workspacePath, "verify.mjs");
  await writeFile(verificationScript, "import { existsSync } from 'node:fs'; process.exit(existsSync('passed') ? 0 : 1);\n");
  const phases: string[] = [];
  const taskPhases: string[] = [];
  let attempts = 0;
  const adapter: BenchmarkHarnessAdapter = {
    name: "repair-harness",
    async run(_task, context) {
      attempts += 1;
      phases.push(`${context.phase}:${context.attempt}`);
      if (context.previousVerification !== undefined) {
        assert.equal(context.previousVerification.passed, false);
      }
      if (context.attempt === 2) await writeFile(join(workspacePath, "passed"), "ok");
    },
  };
  const result = await runBenchmarkTask(task({
    workspacePath,
    maxRepairAttempts: 1,
    verification: {
      command: process.execPath,
      args: [verificationScript],
    },
  }), adapter, { onTaskPhase: (phase, attempt) => taskPhases.push(`${phase}:${attempt}`) });

  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(phases, ["implement:1", "diagnose:2"]);
  assert.deepEqual(taskPhases, ["implement:1", "verify:1", "diagnose:2", "verify:2", "summarize:2"]);
  assert.equal(result.verificationAttempts?.length, 2);
  assert.equal(result.workspaceBefore?.workspacePath, workspacePath);
});

test("benchmark artifacts are bounded to safe names and redact common credentials", async () => {
  const artifactDirectory = await mkdtemp(join(tmpdir(), "everpeace-artifacts-"));
  const sink = createFileBenchmarkArtifactSink(artifactDirectory);
  const result = await runBenchmarkTask(task({ maxRepairAttempts: 0 }), {
    name: "artifact-harness",
    async run(_task, context) {
      await context.writeArtifact?.("diagnostic.txt", "api_key=secret-value");
    },
  }, { artifactSink: sink });

  assert.equal(result.status, "passed");
  assert.ok(result.artifacts?.some((path) => path.endsWith("diagnostic.txt")));
  assert.match(await readFile(join(artifactDirectory, "diagnostic.txt"), "utf8"), /\[REDACTED\]/u);
  assert.ok(await readFile(join(artifactDirectory, "result.json"), "utf8"));
});

test("live repair attempts receive the remaining budget and stop at exact exhaustion", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-budget-"));
  const budgets: number[] = [];
  const adapter: BenchmarkHarnessAdapter = {
    name: "budgeted",
    async run(_task, context) {
      budgets.push(context.tokenBudgetRemaining ?? -1);
      return { usage: { inputTokens: 80, outputTokens: 20, complete: true } };
    },
  };
  const result = await runBenchmarkTask(task({
    workspacePath,
    maxRepairAttempts: 3,
    verification: { command: "node", args: ["-e", "process.exit(1)"] },
  }), adapter, { liveApi: true, totalTokenBudget: 100 });
  assert.deepEqual(budgets, [100]);
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /budget was exhausted/u);
});

test("a live suite stops after unknown usage without starting the next task", async () => {
  let calls = 0;
  const summary = await runBenchmarkSuite([task({ id: "one" }), task({ id: "two" })], {
    name: "unknown-usage",
    async run() { calls += 1; return {}; },
  }, { liveApi: true, totalTokenBudget: 1_000 });
  assert.equal(calls, 1);
  assert.equal(summary.total, 1);
  assert.equal(summary.results[0]?.status, "failed");
});
