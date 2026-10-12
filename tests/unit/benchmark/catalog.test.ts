import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseBenchmarkTaskCatalog, parseReproducibleBenchmarkTaskCatalog } from "../../../src/benchmark/catalog.js";

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
      fixture: {
        dependencyLock: "fixtures/dependency-lock.json",
        seedPatch: "fixtures/fix-parser/seed.patch",
        referencePatch: "fixtures/fix-parser/reference.patch",
        setup: { command: "pnpm", args: ["install", "--frozen-lockfile"] },
        pristineVerification: { command: "pnpm", args: ["test"] },
      },
      verification: { command: "pnpm", args: ["test"], timeoutMs: 120_000 },
    }],
  }));

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.source.issue, "42");
  assert.equal(tasks[0]?.maxRepairAttempts, 2);
  assert.deepEqual(tasks[0]?.verification?.args, ["test"]);
  assert.equal(tasks[0]?.fixture?.seedPatch, "fixtures/fix-parser/seed.patch");
  assert.equal(tasks[0]?.fixture?.dependencyLock, "fixtures/dependency-lock.json");
  assert.deepEqual(tasks[0]?.fixture?.setup?.args, ["install", "--frozen-lockfile"]);
});

test("formal benchmark catalogs reject task lists without reviewed fixtures", () => {
  assert.throws(() => parseReproducibleBenchmarkTaskCatalog(JSON.stringify({ tasks: [{
    id: "missing-fixture",
    prompt: "fix it",
    workspacePath: "run",
    source: { repositoryUrl: "https://example.com/repo.git", commit: "abcdef1", issue: "issue" },
    verification: { command: "npm", args: ["test"] },
  }] })), /missing fixture setup, pristine proof, or independent acceptance material/u);
});

test("formal benchmark catalogs reject unlocked npm setup", () => {
  assert.throws(() => parseReproducibleBenchmarkTaskCatalog(JSON.stringify({ tasks: [{
    id: "unlocked",
    prompt: "fix it",
    workspacePath: "run",
    source,
    fixture: {
      setup: { command: "npm", args: ["install"] },
      pristineVerification: { command: "node", args: ["verify.mjs"] },
      seedPatch: "seed.patch",
      referencePatch: "reference.patch",
    },
    verification: { command: "npm", args: ["test"] },
    acceptance: { command: "node", args: ["verify.mjs"] },
  }] })), /npm setup must use npm ci/u);
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
  const catalogUrl = new URL("../../../docs/benchmark/DEEPSEEK_NODE_TASKS.json", import.meta.url);
  const catalog = readFileSync(catalogUrl, "utf8");
  const tasks = parseReproducibleBenchmarkTaskCatalog(catalog);
  const fixtureRoot = resolve(dirname(fileURLToPath(catalogUrl)), "fixtures");

  assert.equal(tasks.length, 10);
  assert.equal(new Set(tasks.map((task) => task.id)).size, 10);
  assert.ok(tasks.every((task) => task.source.commit.length === 40));
  assert.ok(tasks.every((task) => task.fixture &&
    (task.fixture.dependencyLock === undefined || existsSync(resolve(fixtureRoot, task.fixture.dependencyLock))) &&
    existsSync(resolve(fixtureRoot, task.fixture.seedPatch)) &&
    existsSync(resolve(fixtureRoot, task.fixture.referencePatch))));
  assert.ok(tasks.every((task) => task.acceptance?.args?.some((value) => value.includes("${FIXTURE_ROOT}"))));

  const dayjsTasks = tasks.filter((task) => task.id.startsWith("dayjs-"));
  assert.equal(dayjsTasks.length, 4);
  assert.ok(dayjsTasks.every((task) => task.fixture?.pristineVerification?.timeoutMs === 120_000 && task.acceptance?.timeoutMs === 120_000));
});
