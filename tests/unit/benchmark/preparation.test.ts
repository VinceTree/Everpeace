import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createIsolatedBenchmarkPreparer, prepareBenchmarkFixture, proveBenchmarkFixture } from "../../../src/benchmark/preparation.js";
import { runBenchmarkSuite } from "../../../src/benchmark/runner.js";
import type { BenchmarkTask } from "../../../src/benchmark/types.js";

const exec = promisify(execFile);

async function fixture(): Promise<{ root: string; fixtureRoot: string; task: BenchmarkTask }> {
  const root = await mkdtemp(join(tmpdir(), "everpeace-preparation-"));
  const source = join(root, "source");
  const fixtureRoot = join(root, "fixtures");
  await mkdir(source);
  await mkdir(fixtureRoot);
  await writeFile(join(source, "value.mjs"), "export default 'good';\n", "utf8");
  await exec("git", ["init", "--quiet"], { cwd: source });
  await exec("git", ["config", "user.email", "benchmark@example.invalid"], { cwd: source });
  await exec("git", ["config", "user.name", "Benchmark Fixture"], { cwd: source });
  await exec("git", ["add", "value.mjs"], { cwd: source });
  await exec("git", ["commit", "--quiet", "-m", "fixture"], { cwd: source });
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: source });
  await writeFile(join(fixtureRoot, "seed.patch"), [
    "diff --git a/value.mjs b/value.mjs",
    "index a25fd99..b19a8e7 100644",
    "--- a/value.mjs",
    "+++ b/value.mjs",
    "@@ -1 +1 @@",
    "-export default 'good';",
    "+export default 'bad';",
    "diff --git a/verify.mjs b/verify.mjs",
    "new file mode 100644",
    "index 0000000..56a43dd",
    "--- /dev/null",
    "+++ b/verify.mjs",
    "@@ -0,0 +1,3 @@",
    "+import assert from 'node:assert/strict';",
    "+import value from './value.mjs';",
    "+assert.equal(value, 'good');",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(fixtureRoot, "reference.patch"), [
    "diff --git a/value.mjs b/value.mjs",
    "index b19a8e7..a25fd99 100644",
    "--- a/value.mjs",
    "+++ b/value.mjs",
    "@@ -1 +1 @@",
    "-export default 'bad';",
    "+export default 'good';",
    "",
  ].join("\n"), "utf8");
  return {
    root,
    fixtureRoot,
    task: {
      id: "fixture",
      prompt: "repair value",
      workspacePath: "unused",
      source: { repositoryUrl: source, commit: stdout.trim(), issue: "fixture" },
      fixture: {
        seedPatch: "seed.patch",
        referencePatch: "reference.patch",
        setup: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        pristineVerification: { command: process.execPath, args: ["-e", "import('./value.mjs').then(({default:value}) => process.exit(value === 'good' ? 0 : 1))"] },
      },
      verification: { command: process.execPath, args: ["verify.mjs"] },
    },
  };
}

test("fixture proof uses a fresh pinned clone and proves fail then pass", async () => {
  const value = await fixture();
  const proof = await proveBenchmarkFixture(value.task, {
    destination: join(value.root, "proof"),
    fixtureRoot: value.fixtureRoot,
  });
  assert.equal(proof.seeded.passed, false);
  assert.equal(proof.repaired.passed, true);
  assert.equal((await readFile(join(value.root, "proof", "value.mjs"), "utf8")).trim(), "export default 'good';");
});

test("fixture proof rejects verification infrastructure failures as invalid seeds", async () => {
  const value = await fixture();
  await assert.rejects(proveBenchmarkFixture({
    ...value.task,
    verification: { command: "definitely-missing-everpeace-verifier" },
  }, {
    destination: join(value.root, "invalid-proof"),
    fixtureRoot: value.fixtureRoot,
  }), /verification infrastructure was unavailable/u);
});

test("suite runs the task returned by an isolated prepare hook", async () => {
  const value = await fixture();
  const runsRoot = join(value.root, "runs");
  let observedWorkspace = "";
  const summary = await runBenchmarkSuite([value.task], {
    name: "fixture-adapter",
    async run(task) { observedWorkspace = task.workspacePath; },
  }, {
    prepareRun: createIsolatedBenchmarkPreparer({ fixtureRoot: value.fixtureRoot, runsRoot }),
  });
  assert.equal(summary.total, 1);
  assert.equal(observedWorkspace, join(runsRoot, "fixture-1"));
  assert.equal((await prepareBenchmarkFixture(value.task, {
    destination: join(value.root, "standalone"),
    fixtureRoot: value.fixtureRoot,
  })).workspacePath, join(value.root, "standalone"));
});
