import fc from "fast-check";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Only synthetic inputs belong in counterexamples; never pass customer data here. */
export async function propertyCheck<T>(name: string, property: fc.IProperty<T> | fc.IAsyncProperty<T>, sequences = false): Promise<void> {
  const seed = Number(process.env.EVERPEACE_PROPERTY_SEED ?? "20261011");
  assert.ok(Number.isSafeInteger(seed), "Property seed must be an integer");
  const requested = (sequences ? 100 : 1000) * (process.env.EVERPEACE_PROPERTY_DAILY === "1" ? 10 : 1);
  const replay = process.env.EVERPEACE_PROPERTY_REPLAY;
  const result = await fc.check(property, { seed, numRuns: requested, maxSkipsPerRun: 0, ...(replay ? { path: replay, endOnFailure: true } : {}) });
  const report = { schema: 1, invariant: name, requested, runs: result.numRuns, seed: result.seed, replayPath: result.counterexamplePath, shrinks: result.numShrinks, counterexample: result.counterexample, passed: !result.failed && !result.interrupted && result.numRuns === requested, resources: "checked_by_invariant" };
  const directory = process.env.EVERPEACE_PROPERTY_REPORT;
  if (directory) { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(report, null, 2) + "\n"); }
  if (!report.passed) throw new Error(`Security invariant ${name} failed or did not finish: seed=${result.seed}, path=${result.counterexamplePath ?? ""}, counterexample=${fc.stringify(result.counterexample)}`, { cause: result.errorInstance });
}
