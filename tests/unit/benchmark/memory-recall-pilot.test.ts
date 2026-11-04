import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { completeFactStore, chooseRecallCandidate, recallContext, recallFactsFile, RecallBudget, recallRequest, verifyRecallInputs } from "../../../src/benchmark/memory-recall-pilot.js";
import { projectMemoryKey } from "../../../src/memory/learned-memory.js";
import { MemoryRequestGate, readJson, writeJson, type MemoryRequestRecord } from "../../../src/benchmark/memory-evidence.js";
import { normalizeFact } from "../../../src/memory/facts.js";
import { digest } from "../../../src/benchmark/memory-data.js";
import type { ResponsesClientLike } from "../../../src/agent/model-protocol.js";

const fact = (i: number, text = "cat Luna") => normalizeFact({ id: `fact-${i.toString(16).padStart(24, "0")}`, lesson: text, createdAt: "2026-11-04",
  fact: { speaker: "user", quote: text, messageTime: "2026-11-04", sourceId: `message-${i}`, sourceMessageHash: digest(text), sessionId: `session-${i}` } });
const response = () => ({ id: "fixed", status: "completed", output_text: "Luna", output: [], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } });

test("only a complete nonempty store participates; no partial-prefix promotion", () => {
  assert.equal(completeFactStore(4, 4), true);
  for (const next of [undefined, -1, 0, 2, 5, 4.1]) assert.equal(completeFactStore(next, 4), false);
  assert.equal(completeFactStore(0, 0), false);
});

test("sealed store loading targets only the sample workspace project, without enumerating other projects", () => {
  const sample = path.resolve("isolated-sample");
  assert.equal(recallFactsFile(sample), path.join(sample, "store/projects", projectMemoryKey(path.join(sample, "workspace")), "facts.json"));
  assert.notEqual(recallFactsFile(sample), recallFactsFile(path.resolve("other-sample")));
});

test("frozen facts recall without an extractor, retains attributed evidence and enforces eligibility", () => {
  const active = fact(1), archived = { ...fact(2), status: "archived" as const };
  const result = recallContext([active, archived], "cat", new Date("2026-11-04"), "aggregate");
  assert.deepEqual(result.ids, [active.id]); assert.ok(result.text.includes("Evidence: cat Luna"));
  assert.ok(result.text.includes("untrusted")); assert.ok(result.bodyChars <= 8000);
});

test("offline choice needs positive necessary-evidence gain without losing any baseline fact or anchor", () => {
  const cases = [1, 2, 3, 4].map(i => {
    const facts = [fact(i * 10), fact(i * 10 + 1)];
    const context = (ids: string[]) => ({ ids, text: "fixed", bodyChars: 5, sources: [] });
    return { question: { id: `q${i}`, type: "single-session-user" as const, question: "cat", date: "2026-11-04", historyHash: "hash" }, facts,
      contexts: { current: context([facts[0]!.id]), terms: context(facts.map(f => f.id)), aggregate: context(facts.map(f => f.id)), protected: context([facts[0]!.id]) } };
  });
  const audit = cases.map(c => ({ questionId: c.question.id, necessary: c.facts.map(f => f.id), anchor: c.facts[0]!.id, rationale: "fixed" }));
  assert.equal(chooseRecallCandidate(cases, audit).selected, "terms");
  cases[0]!.contexts.terms.ids = [cases[0]!.facts[1]!.id];
  assert.equal(chooseRecallCandidate(cases, audit).selected, "aggregate");
  cases[0]!.contexts.aggregate.ids = [cases[0]!.facts[1]!.id];
  assert.equal(chooseRecallCandidate(cases, audit).selected, null);
  assert.throws(() => chooseRecallCandidate(cases, audit.slice(1)), /coverage/u);
});

test("the explicit repair policy preserves the evidence-gain gate and requires every baseline row in order", () => {
  const cases = [1, 2, 3, 4].map(i => {
    const facts = [fact(i * 10), fact(i * 10 + 1)];
    const context = (ids: string[]) => ({ ids, text: "fixed", bodyChars: 500, sources: [] });
    return { question: { id: `repair${i}`, type: "single-session-user", question: "cat", date: "2026-11-04", historyHash: "hash" }, facts,
      contexts: { current: context(facts.map(f => f.id)), terms: context(facts.map(f => f.id)), aggregate: context([facts[1]!.id]), protected: context(facts.map(f => f.id)) } };
  });
  const audit = cases.map(c => ({ questionId: c.question.id, necessary: c.facts.map(f => f.id), anchor: c.facts[0]!.id, rationale: "fixed" }));
  assert.equal(chooseRecallCandidate(cases, audit).selected, null);
  assert.equal(chooseRecallCandidate(cases, audit, "preservation-repair").selected, "protected");
  cases[0]!.contexts.protected.ids.reverse();
  assert.equal(chooseRecallCandidate(cases, audit, "preservation-repair").selected, null);
  cases[0]!.contexts.protected.ids.reverse(); cases[0]!.contexts.protected.bodyChars = 8001;
  assert.equal(chooseRecallCandidate(cases, audit, "preservation-repair").selected, null);
});

test("UTF-8 and output reservations include concurrent requests and release after refusal", () => {
  const budget = new RecallBudget(9000);
  const release = budget.reserve({ input: "猫", max_output_tokens: 100 });
  assert.ok(budget.reserved > 4196);
  assert.throws(() => budget.reserve({ input: "x".repeat(1000), max_output_tokens: 100 }), /budget_exhausted/u);
  release(); assert.equal(budget.reserved, 0);
  budget.spent = 8999;
  assert.throws(() => budget.reserve({}), /budget_exhausted/u);
});

test("fixed provider requests persist once, settle usage and never call extraction", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recall-requests-")); t.after(() => rm(root, { recursive: true, force: true }));
  let active = 0, peak = 0, calls = 0;
  const provider: ResponsesClientLike = { responses: { async create() { calls++; peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return response(); } } };
  const gate = new MemoryRequestGate(root, 2), budget = new RecallBudget();
  await Promise.all([1, 2].map(i => recallRequest(gate, provider, budget, `item${i}`, "answer", { max_output_tokens: 20 })));
  assert.equal(calls, 2); assert.equal(peak, 2); assert.equal(budget.spent, 20); assert.equal(budget.reserved, 0);
  for (const file of await readdir(root)) {
    const record = await readJson<MemoryRequestRecord>(path.join(root, file));
    assert.equal(record.phase, "answer"); assert.equal(record.state, "settled"); assert.equal(record.openRequests, 0); assert.equal(record.usage.complete, true);
  }
  await assert.rejects(recallRequest(gate, provider, budget, "item1", "answer", { max_output_tokens: 20 }), /Repeated/u);
  assert.equal(calls, 2); assert.equal(budget.spent, 20);
});

test("unknown usage closes admission and keeps the original request without automatic retry", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recall-unknown-")); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const provider: ResponsesClientLike = { responses: { async create() { calls++; return { ...response(), usage: undefined }; } } };
  const gate = new MemoryRequestGate(root, 2), budget = new RecallBudget();
  await assert.rejects(recallRequest(gate, provider, budget, "first", "answer", {}));
  await assert.rejects(recallRequest(gate, provider, budget, "second", "answer", {}));
  assert.equal(calls, 1); assert.equal(budget.reserved, 0);
  const original = await readJson<MemoryRequestRecord>(path.join(root, `${digest("first:answer")}.json`));
  assert.equal(original.state, "settled"); assert.equal(original.usage.complete, false);
});

test("identity drift and cancellation reject before provider admission", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recall-cancel-")); t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const provider: ResponsesClientLike = { responses: { async create() { calls++; return response(); } } };
  const budget = new RecallBudget(), gate = new MemoryRequestGate(root, 2);
  await assert.rejects(recallRequest(gate, provider, budget, "drift", "answer", {}, {}, async () => { throw Error("changed"); }), /changed/u);
  assert.equal(gate.stopReason, "identity_changed"); assert.equal(calls, 0);
  const cancelled = new MemoryRequestGate(root, 2); cancelled.stop("cancelled");
  await assert.rejects(recallRequest(cancelled, provider, budget, "cancel", "answer", {}));
  assert.equal(calls, 0); assert.equal(budget.reserved, 0);
});

test("unwritable request evidence blocks provider admission and releases the reservation", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recall-storage-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, `${digest("blocked:answer")}.json`));
  let calls = 0;
  const provider: ResponsesClientLike = { responses: { async create() { calls++; return response(); } } };
  const budget = new RecallBudget(), gate = new MemoryRequestGate(root, 2);
  await assert.rejects(recallRequest(gate, provider, budget, "blocked", "answer", {}));
  assert.equal(calls, 0); assert.equal(budget.reserved, 0); assert.equal(gate.stopReason, "storage_failed");
});

test("manifest or frozen-input drift is rejected and exclusive evidence cannot be overwritten", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recall-freeze-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(path.join(root, "cases.json"), [], true);
  const bytes = Buffer.from("[]\n");
  const manifest = { budget: 500000, seed: 16716, model: { rawModelId: "deepseek-v4.1-flash", endpoint: "https://opencode.ai/inference/go/openai/v1" }, files: { "cases.json": digest(bytes) }, inputHashes: {} };
  await writeFile(path.join(root, "cases.json"), bytes);
  await writeJson(path.join(root, "manifest.json"), manifest, true);
  const { readFile } = await import("node:fs/promises");
  await writeJson(path.join(root, "manifest-hash.json"), { sha256: digest(await readFile(path.join(root, "manifest.json"))) }, true);
  await verifyRecallInputs(root, false);
  await assert.rejects(writeJson(path.join(root, "cases.json"), ["replace"], true), /open/u);
  await writeFile(path.join(root, "cases.json"), "changed");
  await assert.rejects(verifyRecallInputs(root, false), /Frozen input changed/u);
  await writeFile(path.join(root, "manifest.json"), "{}");
  await assert.rejects(verifyRecallInputs(root, false), /Manifest changed/u);
});
