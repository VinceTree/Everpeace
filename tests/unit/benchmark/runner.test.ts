import { ProcessCleanupError } from "../../../src/tools/process-completion.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createFileBenchmarkArtifactSink } from "../../../src/benchmark/artifacts.js";
import { resolveBenchmarkProcess, runBenchmarkSuite, runBenchmarkTask, runBenchmarkVerification } from "../../../src/benchmark/runner.js";
import type { BenchmarkHarnessAdapter, BenchmarkTask } from "../../../src/benchmark/types.js";

const task = (overrides: Partial<BenchmarkTask> = {}): BenchmarkTask => ({
  id: "fixture",
  prompt: "make the fixture pass",
  workspacePath: process.cwd(),
  ...overrides,
});

test("benchmark command resolution makes the Windows npm shim spawnable without a shell", () => {
  if (process.platform !== "win32") return;
  const invocation = resolveBenchmarkProcess("npm", ["--version"]);
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0] ?? "", /node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/u);
  assert.deepEqual(invocation.args.slice(1), ["--version"]);
  assert.deepEqual(resolveBenchmarkProcess(process.execPath, ["--version"]), {
    command: process.execPath,
    args: ["--version"],
  });
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

test("evaluator-owned acceptance takes precedence over harness-visible verification", async () => {
  const adapter: BenchmarkHarnessAdapter = { name: "fixture-harness", async run() {} };
  const result = await runBenchmarkTask(task({
    verification: { command: "node", args: ["-e", "process.exit(0)"] },
    acceptance: { command: "node", args: ["-e", "process.exit(7)"] },
    maxRepairAttempts: 0,
  }), adapter);
  assert.equal(result.status, "failed");
  assert.equal(result.verification?.exitCode, 7);
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
  assert.equal(result.verification?.cancelled, false);
});

test("verification cancellation is distinct from a timeout", async () => {
  const controller = new AbortController();
  const running = runBenchmarkVerification({ command: "node", args: ["-e", "setTimeout(() => {}, 1000)"] }, process.cwd(), controller.signal);
  controller.abort(new Error("campaign cancelled"));
  const result = await running;
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.error, "Verification was cancelled");
});

test("task cancellation during verification is not reported as a verification timeout", async () => {
  const controller = new AbortController();
  const cancellation = setTimeout(() => controller.abort(new Error("campaign cancelled")), 1_000);
  const result = await runBenchmarkTask(task({
    verification: { command: "node", args: ["-e", "setTimeout(() => {}, 1000)"] },
  }), { name: "fixture-harness", async run() {} }, { signal: controller.signal });
  clearTimeout(cancellation);
  assert.equal(result.status, "error");
  assert.equal(result.error, "Benchmark task was cancelled");
  assert.equal(result.verification?.cancelled, true);
});

test("task timeout stops waiting for an adapter that ignores cancellation", { timeout: 10_000 }, async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let invoked = false;
  let completed = false;
  const adapter: BenchmarkHarnessAdapter = {
    name: "slow-harness",
    async run() {
      invoked = true;
      await pending;
      completed = true;
    },
  };
  try {
    // The adapter cannot finish until released; timing of Git snapshots is irrelevant.
    const result = await runBenchmarkTask(task({ timeoutMs: 1_000 }), adapter);
    assert.equal(result.status, "timed_out");
    assert.equal(invoked, true);
    assert.equal(completed, false);
  } finally { release(); }
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
    runBenchmarkSuite([task()], adapter, { liveApi: true, totalTokenBudget: 1_000 }),
    /per-task token budget/u,
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
    taskTokenBudget: 900,
    repetitions: 3,
    async prepareRun(_task, repetition) { prepared.push(repetition); },
  });
  assert.equal(summary.total, 3);
  assert.equal(summary.repetitions, 3);
  assert.deepEqual(prepared, [1, 2, 3]);
  assert.deepEqual(budgets, [900, 880, 760]);
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
  const diagnostic = result.artifacts?.find((path) => path.endsWith("diagnostic.txt"));
  assert.ok(diagnostic);
  assert.match(await readFile(diagnostic, "utf8"), /\[REDACTED\]/u);
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
  }, { liveApi: true, totalTokenBudget: 1_000, taskTokenBudget: 1_000 });
  assert.equal(calls, 1);
  assert.equal(summary.total, 2);
  assert.equal(summary.executed, 1);
  assert.equal(summary.statisticsComplete, false);
  assert.deepEqual(summary.skipped, [{ taskId: "two", repetition: 1, reason: "usage_unknown" }]);
  assert.equal(summary.results[0]?.status, "failed");
});

test("live adapters can account at the actual request boundary", async () => {
  const summary = await runBenchmarkSuite([task({ id: "one" }), task({ id: "two" })], {
    name: "request-ledger",
    async run(_task, context) {
      const request = context.requestAttemptLedger?.begin("coding");
      assert.notEqual(request, undefined);
      context.requestAttemptLedger?.settle(request!, "completed", {
        input_tokens: 120,
        output_tokens: 30,
        reasoning_tokens: 20,
        total_tokens: 150,
      });
      return { usage: { inputTokens: 999, outputTokens: 999, complete: true } };
    },
  }, { liveApi: true, totalTokenBudget: 150, taskTokenBudget: 150 });

  assert.equal(summary.executed, 1);
  assert.deepEqual(summary.usage, {
    inputTokens: 120,
    outputTokens: 30,
    reasoningTokens: 20,
    cachedInputTokens: 0,
    cacheObservedInputTokens: 0,
    complete: true,
  });
  assert.deepEqual(summary.skipped, [{ taskId: "two", repetition: 1, reason: "budget_exhausted" }]);
});

test("cancelled campaigns skip preparation and all planned runs", async () => {
  const controller = new AbortController();
  controller.abort();
  let prepared = 0;
  const summary = await runBenchmarkSuite([task()], { name: "cancelled", async run() {} }, {
    signal: controller.signal,
    async prepareRun() { prepared += 1; },
  });
  assert.equal(prepared, 0);
  assert.equal(summary.executed, 0);
  assert.equal(summary.stopReason, "Campaign was cancelled");
  assert.deepEqual(summary.skipped, [{ taskId: "fixture", repetition: 1, reason: "cancelled" }]);
});

test("unknown usage stays incomplete after an earlier metered repair attempt", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "everpeace-sticky-usage-"));
  let attempts = 0;
  const result = await runBenchmarkTask(task({
    workspacePath,
    maxRepairAttempts: 2,
    verification: { command: "node", args: ["-e", "process.exit(1)"] },
  }), {
    name: "sticky-usage",
    async run() {
      attempts += 1;
      return attempts === 1
        ? { usage: { inputTokens: 80, outputTokens: 20, complete: true } }
        : {};
    },
  }, { liveApi: true, totalTokenBudget: 1_000, taskTokenBudget: 1_000 });
  assert.equal(attempts, 2);
  assert.deepEqual(result.usage, {
    inputTokens: 80,
    outputTokens: 20,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheObservedInputTokens: 0,
    complete: false,
  });
});

test("a thrown request with unknown usage stops the campaign before another task", async () => {
  let calls = 0;
  const summary = await runBenchmarkSuite([task({ id: "one" }), task({ id: "two" })], {
    name: "thrown-unknown",
    async run(_task, context) {
      calls += 1;
      context.requestAttemptLedger?.begin("coding");
      throw new Error("transport vanished");
    },
  }, { liveApi: true, totalTokenBudget: 1_000, taskTokenBudget: 1_000 });

  assert.equal(calls, 1);
  assert.equal(summary.results[0]?.usage?.complete, false);
  assert.deepEqual(summary.skipped, [{ taskId: "two", repetition: 1, reason: "usage_unknown" }]);
});

test("suite records preparation failures and continues with the remaining run plan", async () => {
  const executed: string[] = [];
  const summary = await runBenchmarkSuite([task({ id: "broken" }), task({ id: "ready" })], {
    name: "preparation",
    async run(value) { executed.push(value.id); },
  }, {
    async prepareRun(value) {
      if (value.id === "broken") throw new Error("fixture proof failed");
      return value;
    },
  });

  assert.deepEqual(executed, ["ready"]);
  assert.equal(summary.executed, 2);
  assert.equal(summary.errored, 1);
  assert.match(summary.results[0]?.preparationError ?? "", /fixture proof failed/u);
});


test("cleanup failure survives cancellation and stops subsequent suite work", async () => {
  const controller = new AbortController();
  let runs = 0;
  let preparations = 0;
  const adapter: BenchmarkHarnessAdapter = {
    name: "cleanup-failure", settlesOnCancellation: true,
    async run() {
      runs++;
      controller.abort(new Error("cancelled"));
      throw new ProcessCleanupError(new Error("termination refused"));
    },
  };
  const result = await runBenchmarkSuite([task({ id: "first" }), task({ id: "second" })], adapter, {
    signal: controller.signal,
    async prepareRun(value) { preparations++; return value; },
  });
  assert.equal(runs, 1);
  assert.equal(preparations, 1);
  assert.equal(result.results[0]?.cleanupFailed, true);
  assert.match(result.results[0]?.error ?? "", /termination refused/u);
  assert.equal(result.results[0]?.verification, undefined);
  assert.equal(result.skipped[0]?.reason, "cleanup_failed");
  assert.equal(result.statisticsComplete, false);
});
