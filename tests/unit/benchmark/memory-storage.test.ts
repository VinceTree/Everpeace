import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EvidenceStorageError, replaceEvidenceFile, writeJson } from "../../../src/benchmark/memory-evidence.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { RequestExecutor } from "../../../src/agent/request-executor.js";
import { PersistenceError } from "../../../src/storage/persistence-error.js";

test("Windows sharing violations retry the same staged bytes without deleting old evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-storage-"));
  try {
    const target = path.join(root, "checkpoint.json"), staged = path.join(root, "staged.json");
    await writeFile(target, "original"); await writeFile(staged, "replacement"); let calls = 0;
    await replaceEvidenceFile(staged, target, { windows: true, wait: async () => {}, replace: async (from, to) => {
      calls++; assert.equal(await readFile(from, "utf8"), "replacement"); assert.equal(await readFile(to, "utf8"), "original");
      if (calls < 3) throw Object.assign(new Error("synthetic sharing violation"), { code: "EPERM" });
      await rename(from, to);
    } });
    assert.equal(calls, 3); assert.equal(await readFile(target, "utf8"), "replacement");
    await writeJson(target, { complete: true }); assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { complete: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("permanent storage failures stay bounded and retain safe operation/code diagnostics", async () => {
  for (const [windows, code, expected] of [[true, "EPERM", 6], [true, "ENOSPC", 1], [false, "EPERM", 1]] as const) {
    let calls = 0;
    await assert.rejects(replaceEvidenceFile("staged", "target", { windows, wait: async () => {}, replace: async () => {
      calls++; throw Object.assign(new Error("private path and credentials"), { code });
    } }), error => {
      assert.ok(error instanceof EvidenceStorageError); assert.equal(error.stage, "rename"); assert.equal(error.code, code);
      assert.ok(!error.message.includes("private")); return true;
    });
    assert.equal(calls, expected);
  }
});

test("cancellation while a checkpoint is being persisted starts no provider request", async () => {
  const ledger = new RequestAttemptLedger(); const controller = new AbortController();
  let ready!: () => void, release!: () => void, flushes = 0, requests = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { ready = resolve; });
  ledger.flush = async () => { if (++flushes === 1) { ready(); await waiting; } };
  const running = new RequestExecutor(ledger).execute("benchmark", async () => { requests++; return {}; }, { reservation: 0, signal: controller.signal });
  const rejected = assert.rejects(running, /cancelled before provider/u);
  await entered; controller.abort(new Error("cancelled before provider")); release(); await rejected;
  assert.equal(requests, 0); assert.equal(ledger.snapshot().complete, true);
  assert.deepEqual(ledger.snapshot().attempts.map(row => [row.status, row.usage?.total_tokens]), [["rejected", 0]]);
});

for (const afterResponse of [false, true]) test(`a storage fault closes executor admission ${afterResponse ? "after" : "before"} provider settlement`, async () => {
  const ledger = new RequestAttemptLedger(); let flushes = 0, requests = 0;
  ledger.flush = async () => { if (++flushes === (afterResponse ? 2 : 1)) throw new EvidenceStorageError("rename", { code: "EPERM" }); };
  const executor = new RequestExecutor(ledger);
  await assert.rejects(executor.execute("benchmark", async () => { requests++; return { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }; }), PersistenceError);
  await assert.rejects(executor.execute("benchmark", async () => { requests++; return {}; }), PersistenceError);
  assert.equal(requests, afterResponse ? 1 : 0);
  assert.equal(ledger.snapshot().complete, true);
  assert.equal(ledger.snapshot().inputTokens + ledger.snapshot().outputTokens, afterResponse ? 3 : 0);
});
