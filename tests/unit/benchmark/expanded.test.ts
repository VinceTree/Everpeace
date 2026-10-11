import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { parseReproducibleBenchmarkTaskCatalog } from "../../../src/benchmark/catalog.js";
import { proveBenchmarkFixture } from "../../../src/benchmark/preparation.js";
const execute = promisify(execFile);

test("eight frozen synthetic tasks prove baseline, defect and repair without model requests", { timeout: 120_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-expanded-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const fixtureRoot = path.resolve("tests/fixtures/expanded");
  const tasks = parseReproducibleBenchmarkTaskCatalog(await fs.readFile("docs/benchmark/EXPANDED_TASKS.json", "utf8"));
  assert.equal(tasks.length, 9);
  for (const task of tasks.filter((entry) => entry.source.sourceType === "synthetic")) {
    const proof = await proveBenchmarkFixture(task, { fixtureRoot, destination: path.join(root, task.id) });
    assert.notEqual(proof.seeded.exitCode, 0, task.id); assert.equal(proof.repaired.exitCode, 0, task.id);
  }
});

test("pinned upstream helper has a normal control, a real exception failure, and a repaired exit", async (t) => {
  const fixture = path.resolve("tests/fixtures/expanded/node-pty-helper-952");
  const provenance = JSON.parse(await fs.readFile(path.join(fixture, "upstream/provenance.json"), "utf8"));
  const bytes = await fs.readFile(path.join(fixture, "upstream/src/conpty_console_list_agent.ts"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), provenance.sha256);
  assert.equal(provenance.commit, "1def5774632305246fe21f0f69e23a664d6c5910");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-upstream-helper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src")); await fs.writeFile(path.join(root, provenance.path), bytes);
  const args = [path.resolve("tests/fixtures/expanded/verify.mjs"), "node-pty-helper-952", root];
  await execute(process.execPath, [...args, "normal"], { windowsHide: true });
  await assert.rejects(execute(process.execPath, args, { windowsHide: true }), /ERR_ASSERTION/u);
  await execute("git", ["apply", "--unidiff-zero", "--", path.join(fixture, "reference.patch")], { cwd: root, windowsHide: true });
  await execute(process.execPath, args, { windowsHide: true });
});
