import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureBenchmarkEvaluationDigest } from "../../../src/benchmark/evaluation-identity.js";

test("evaluation identity changes with prompts, reference fixes and independent assertions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "everpeace-evaluation-"));
  try {
    const catalog = path.join(root, "catalog.json"), fixtures = path.join(root, "fixtures");
    await mkdir(fixtures);
    await writeFile(catalog, '{"prompt":"Fix the failing behavior"}');
    await writeFile(path.join(fixtures, "reference.patch"), "reference fix");
    await writeFile(path.join(fixtures, "assertion.mjs"), "independent assertion");
    const initial = await captureBenchmarkEvaluationDigest(catalog, fixtures);
    assert.equal(await captureBenchmarkEvaluationDigest(catalog, fixtures), initial);
    await writeFile(catalog, '{"prompt":"Implement a feature"}');
    const promptChanged = await captureBenchmarkEvaluationDigest(catalog, fixtures);
    assert.notEqual(promptChanged, initial);
    await writeFile(path.join(fixtures, "reference.patch"), "different fix");
    const referenceChanged = await captureBenchmarkEvaluationDigest(catalog, fixtures);
    assert.notEqual(referenceChanged, promptChanged);
    await writeFile(path.join(fixtures, "assertion.mjs"), "different assertion");
    assert.notEqual(await captureBenchmarkEvaluationDigest(catalog, fixtures), referenceChanged);
  } finally { await rm(root, { recursive: true, force: true }); }
});
