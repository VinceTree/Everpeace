import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freezeMemoryContinuation, retainCompletedCodingChains, verifyMemoryContinuation, type CodingRecord } from "../../../src/benchmark/memory-continuation.js";
import { digest } from "../../../src/benchmark/memory-data.js";
import { writeJson } from "../../../src/benchmark/memory-evidence.js";
import { DEFAULT_MEMORY_CONFIG } from "../../../src/benchmark/memory-campaign.js";

const cells = Array.from({ length: 4 }, (_, i) => ({ sequence: "s", repetition: 1, arm: "on", stage: i + 1, prompt: String(i) }));
const records = (): CodingRecord[] => cells.map(cell => ({ ...cell, result: { status: "passed", workflowOutcome: "verified", terminalOutcome: "completed", verification: { passed: true }, usage: { complete: true, inputTokens: 2, outputTokens: 1 } } }));
test("continuation retains only complete verified chains and never imports failed prefixes", () => {
  assert.equal(retainCompletedCodingChains(cells, records()).length, 4);
  for (let count = 0; count < 4; count++) assert.equal(retainCompletedCodingChains(cells, records().slice(0, count)).length, 0);
  for (const change of [{ usage: { complete: false, inputTokens: 2, outputTokens: 1 } }, { workflowOutcome: "unverified" }, { verification: { passed: false } }, { storageFailed: true }, { status: "failed" }]) {
    const input = records(); Object.assign(input[2]!.result, change);
    assert.equal(retainCompletedCodingChains(cells, input).length, 0);
  }
  assert.throws(() => retainCompletedCodingChains(cells, [...records(), records()[0]!]));
});
test("parent evidence identity remains frozen during a continuation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-parent-"));
  try {
    await writeFile(path.join(root, "evidence.json"), "original");
    const continuation = { parentRoot: root, files: { "evidence.json": digest("original") } };
    await verifyMemoryContinuation(continuation);
    await writeFile(path.join(root, "evidence.json"), "changed");
    await assert.rejects(verifyMemoryContinuation(continuation), /identity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a stopped parent can retain verified chains while its historical unknown stays incomplete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-stopped-parent-"));
  try {
    const manifest = { config: DEFAULT_MEMORY_CONFIG }, hash = digest(JSON.stringify(manifest));
    const preflight = { manifest: hash };
    await writeJson(path.join(root, "manifest.json"), manifest); await writeFile(path.join(root, "manifest.sha256"), hash);
    await writeJson(path.join(root, "preflight.json"), preflight); await writeFile(path.join(root, "preflight.sha256"), digest(JSON.stringify(preflight)));
    await writeJson(path.join(root, "run-state.json"), { stopReason: "usage_unknown" });
    const unfinished = cells.map(cell => ({ ...cell, arm: "off" }));
    const input: CodingRecord[] = [...records(), { ...unfinished[0]!, result: { status: "failed", usage: { complete: false, inputTokens: 5, outputTokens: 2 } } }];
    await writeJson(path.join(root, "coding/plan.json"), { evaluationDigest: "test", planned: [...cells, ...unfinished] });
    await writeJson(path.join(root, "coding/live-result.json"), { records: input });
    await writeFile(path.join(root, "coding/results.jsonl"), input.map(row => JSON.stringify(row)).join("\n") + "\n");
    await writeJson(path.join(root, "campaign-usage.json"), { knownInputOutputTokens: 19, complete: false });
    const continuation = await freezeMemoryContinuation(root, DEFAULT_MEMORY_CONFIG);
    assert.equal(continuation.retained.length, 4); assert.equal(continuation.historical.complete, false);
    assert.equal(continuation.historical.knownInputOutputTokens, 19); assert.equal(continuation.historical.failedAttempts, 1);
    await writeJson(path.join(root, "coding/chains/off/request-ledgers/pending.json"), { openRequests: 1 });
    await assert.rejects(freezeMemoryContinuation(root, DEFAULT_MEMORY_CONFIG), /unresolved coding requests/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a fully retained coding parent needs no new journal and freezes its absence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-retained-parent-"));
  try {
    const manifest = { config: DEFAULT_MEMORY_CONFIG }, hash = digest(JSON.stringify(manifest)), preflight = { manifest: hash };
    await writeJson(path.join(root, "manifest.json"), manifest); await writeFile(path.join(root, "manifest.sha256"), hash);
    await writeJson(path.join(root, "preflight.json"), preflight); await writeFile(path.join(root, "preflight.sha256"), digest(JSON.stringify(preflight)));
    await writeJson(path.join(root, "run-state.json"), { stopReason: "service_error" });
    const continuation = { parentRoot: path.join(root, "older"), files: {}, retained: records() };
    await writeJson(path.join(root, "coding/plan.json"), { evaluationDigest: "test", planned: cells, continuation });
    await writeJson(path.join(root, "coding/live-result.json"), { records: records() });
    await writeJson(path.join(root, "campaign-usage.json"), { knownInputOutputTokens: 19, complete: false, unknownRequestCount: 3 });
    const frozen = await freezeMemoryContinuation(root, DEFAULT_MEMORY_CONFIG);
    assert.equal(frozen.retained.length, 4); assert.deepEqual(frozen.absentFiles, ["coding/results.jsonl"]);
    assert.equal(frozen.historical.unknownRequestCount, 3); await verifyMemoryContinuation(frozen);
    await writeFile(path.join(root, "coding/results.jsonl"), "");
    await assert.rejects(verifyMemoryContinuation(frozen), /identity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
