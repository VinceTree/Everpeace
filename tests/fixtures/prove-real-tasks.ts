import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseReproducibleBenchmarkTaskCatalog } from "../../src/benchmark/catalog.js";
import { proveBenchmarkFixture } from "../../src/benchmark/preparation.js";
import { captureBenchmarkEvaluationDigest } from "../../src/benchmark/evaluation-identity.js";

const [directory, cacheDirectory, ...taskIds] = process.argv.slice(2);
assert.ok(directory && path.isAbsolute(directory), "Supply a new absolute evidence directory");
assert.ok(cacheDirectory && path.isAbsolute(cacheDirectory), "Supply an evaluator-owned pinned Git cache directory");
await mkdir(directory);
const catalogPath = path.resolve("docs/benchmark/real-fixtures/catalog.json");
const fixtureRoot = path.dirname(catalogPath);
const tasks = parseReproducibleBenchmarkTaskCatalog(await readFile(catalogPath, "utf8"));
assert.ok(taskIds.every(id => tasks.some(task => task.id === id)), "Unknown task ID");
const selected = tasks.filter(task => !taskIds.length || taskIds.includes(task.id));
const digest = await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot);
await writeFile(path.join(directory, "plan.json"), JSON.stringify({ schema: 1, tasks: selected.map(task => task.id), evaluationDigest: digest, modelRequests: 0 }), { flag: "wx" });
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Fixture proof cancelled"));
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
const records = [];
try {
  for (const task of selected) {
    if (controller.signal.aborted) break;
    let record;
    try {
      const proof = await proveBenchmarkFixture(task, { fixtureRoot, destination: path.join(directory, task.id), sourceCache: path.join(cacheDirectory, task.id), signal: controller.signal, onVerification: (phase, result) => appendFile(path.join(directory, "verification.jsonl"), JSON.stringify({ taskId: task.id, phase, result }) + "\n") });
      record = { taskId: task.id, baseline: "passed", defect: proof.seeded, reference: proof.repaired, passed: true };
    } catch (error) {
      record = { taskId: task.id, passed: false, error: String(error) };
    }
    records.push(record);
    await appendFile(path.join(directory, "results.jsonl"), JSON.stringify(record) + "\n");
    console.log(JSON.stringify({ taskId: task.id, passed: record.passed, ...("error" in record ? { error: record.error } : {}) }));
  }
} finally {
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
}
const unchanged = digest === await captureBenchmarkEvaluationDigest(catalogPath, fixtureRoot);
const passed = unchanged && records.length === selected.length && records.every(record => record.passed);
await writeFile(path.join(directory, "proof.json"), JSON.stringify({ schema: 1, planned: selected.length, modelRequests: 0, evaluationDigest: digest, unchanged, passed, records, skipped: selected.slice(records.length).map(task => task.id) }, null, 2), { flag: "wx" });
assert.ok(passed, "Every planned upstream task requires baseline pass, expected defect failure, and reference pass; inspect proof.json");
