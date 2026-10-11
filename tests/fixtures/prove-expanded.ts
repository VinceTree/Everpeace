import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseReproducibleBenchmarkTaskCatalog } from "../../src/benchmark/catalog.js";
import { proveBenchmarkFixture } from "../../src/benchmark/preparation.js";
import { captureBenchmarkEvaluationDigest } from "../../src/benchmark/evaluation-identity.js";

const output = path.resolve(process.argv[2]!);
await mkdir(output, { recursive: true });
const tasks = parseReproducibleBenchmarkTaskCatalog(await readFile("docs/benchmark/EXPANDED_TASKS.json", "utf8"));
const fixtureRoot = path.resolve("tests/fixtures/expanded");
const records = [];
for (const task of tasks) {
  try {
    const proof = await proveBenchmarkFixture(task, { fixtureRoot, destination: path.join(output, task.id) });
    records.push({ taskId: task.id, sourceType: task.source.sourceType, baseline: "passed", seeded: proof.seeded.exitCode, reference: proof.repaired.exitCode, realModelRuns: 0 });
  } catch (error) {
    records.push({ taskId: task.id, sourceType: task.source.sourceType, outcome: /ENOENT|not found|not recognized/iu.test(String(error)) ? "missing_toolchain" : "preparation_failed", realModelRuns: 0, error: String(error) });
  }
}
await writeFile(path.join(output, "expanded-proof.json"), JSON.stringify({ schema: 1, planned: tasks.length, evaluationDigest: await captureBenchmarkEvaluationDigest(path.resolve("docs/benchmark/EXPANDED_TASKS.json"), fixtureRoot), realModelRuns: 0, records }, null, 2) + "\n");
assert.equal(records.filter((record) => record.reference === 0 && record.seeded !== 0).length, tasks.length, "Every planned task requires baseline/seed/reference proof; inspect expanded-proof.json");
console.log(`All ${tasks.length} expanded tasks proved; real model runs: 0.`);
