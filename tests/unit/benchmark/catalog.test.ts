import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseBenchmarkTaskCatalog } from "../../../src/benchmark/catalog.js";

const source = {
  repositoryUrl: "https://github.com/example/project",
  commit: "0123456789abcdef0123456789abcdef01234567",
  issue: "42",
  license: "MIT",
};

test("benchmark catalog parses pinned public issue tasks without executing commands", () => {
  const tasks = parseBenchmarkTaskCatalog(JSON.stringify({
    tasks: [{
      id: "fix-parser",
      prompt: "Fix the parser regression.",
      workspacePath: "C:/benchmarks/fix-parser",
      source,
      tags: ["bug-fix", "tests"],
      maxRepairAttempts: 2,
      fixture: { seedPatch: "fixtures/fix-parser/seed.patch", referencePatch: "fixtures/fix-parser/reference.patch" },
      verification: { command: "pnpm", args: ["test"], timeoutMs: 120_000 },
    }],
  }));

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.source.issue, "42");
  assert.equal(tasks[0]?.maxRepairAttempts, 2);
  assert.deepEqual(tasks[0]?.verification?.args, ["test"]);
  assert.equal(tasks[0]?.fixture?.seedPatch, "fixtures/fix-parser/seed.patch");
});

test("benchmark catalog rejects unpinned, unsafe, and duplicate tasks", () => {
  assert.throws(() => parseBenchmarkTaskCatalog(JSON.stringify([{
    id: "unsafe",
    prompt: "Do work",
    workspacePath: "C:/benchmarks/unsafe",
    source: { ...source, repositoryUrl: "http://example.com/project" },
    verification: { command: "pnpm", args: ["test"] },
  }])), /HTTPS/u);

  assert.throws(() => parseBenchmarkTaskCatalog(JSON.stringify([
    {
      id: "duplicate",
      prompt: "Do work",
      workspacePath: "C:/benchmarks/one",
      source,
      verification: { command: "pnpm" },
    },
    {
      id: "duplicate",
      prompt: "Do work",
      workspacePath: "C:/benchmarks/two",
      source,
      verification: { command: "pnpm" },
    },
  ])), /Duplicate benchmark task id/u);

  assert.throws(() => parseBenchmarkTaskCatalog(JSON.stringify([{
    id: "escaping-fixture",
    prompt: "Do work",
    workspacePath: "C:/benchmarks/escape",
    source,
    fixture: { seedPatch: "../seed.patch", referencePatch: "reference.patch" },
    verification: { command: "pnpm" },
  }])), /normalized relative path/u);
});

test("DeepSeek Node catalog contains ten pinned tasks", () => {
  const catalog = readFileSync(
    new URL("../../../docs/benchmark/DEEPSEEK_NODE_TASKS.json", import.meta.url),
    "utf8",
  );
  const tasks = parseBenchmarkTaskCatalog(catalog);

  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 10);
  assert.ok(tasks.every((task) => task.source.commit.length === 40));
});
