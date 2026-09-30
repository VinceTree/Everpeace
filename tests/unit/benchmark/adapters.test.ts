import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDshHeadlessAdapter, createEverpeaceBenchmarkAdapter, createProcessHarnessAdapter } from "../../../src/benchmark/adapters.js";
import { runBenchmarkTask } from "../../../src/benchmark/runner.js";
import type { BenchmarkTask } from "../../../src/benchmark/types.js";

async function fixture(): Promise<BenchmarkTask> {
  return { id: "adapter", prompt: "fix safely", workspacePath: await mkdtemp(join(tmpdir(), "everpeace-adapter-")) };
}

test("production adapter delegates to the shared task runner", async () => {
  let phase = "";
  const result = await runBenchmarkTask(await fixture(), createEverpeaceBenchmarkAdapter(async (_task, context) => {
    phase = context.phase;
    return { manualInterventions: 1 };
  }));
  assert.equal(result.status, "passed");
  assert.equal(result.manualInterventions, 1);
  assert.equal(phase, "implement");
});

test("process adapter passes task input as an argument without shell interpolation", async () => {
  const result = await runBenchmarkTask(await fixture(), createProcessHarnessAdapter({
    name: "node-fixture",
    command: process.execPath,
    prefixArgs: ["-e", "process.stdout.write(process.argv[1])"],
    argumentsForTask: (task) => [task.prompt],
    parseResult(stdout) {
      assert.equal(stdout, "fix safely");
      return { usage: { inputTokens: 1, outputTokens: 1, complete: true } };
    },
  }));
  assert.equal(result.status, "passed");
});

test("dsh adapter uses the documented headless profile argument order", async () => {
  const adapter = createDshHeadlessAdapter({
    command: process.execPath,
    prefixArgs: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--"],
    parseResult(stdout) {
      assert.deepEqual(JSON.parse(stdout), ["--profile", "headless", "fix safely"]);
      return {};
    },
  });
  assert.equal((await runBenchmarkTask(await fixture(), adapter)).status, "passed");
});
