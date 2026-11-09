import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeFact } from "../../../src/memory/facts.js";
import { selectMemoryEntriesAsync, type SemanticEncoder } from "../../../src/memory/semantic-retrieval.js";
import { selectMemoryEntries, memoryEntryLine } from "../../../src/memory/retrieval.js";
import { LOCAL_ENCODER_RUNTIME, semanticWindows, verifySemanticAssets, semanticCacheKey } from "../../../src/memory/local-encoder.js";
import { semanticRecallContext } from "../../../src/benchmark/memory-recall-pilot.js";

const now = new Date("2026-11-04");
const fact = (n: number, text: string) => normalizeFact({ id: `fact-${String(n).padStart(24, "0")}`, lesson: text, createdAt: now.toISOString(),
  fact: { speaker: "user", quote: text, messageTime: now.toISOString(), sourceMessageHash: "a".repeat(64), sourceId: `message-${n}`, sessionId: `session-${n}` } });
const encoder = (values: number[]): SemanticEncoder => ({ identity: "controlled", async scores(_query, documents) { assert.equal(documents.length, values.length); return values; } });

test("semantic supplement preserves full baseline, attribution and purchase/cancellation evidence without lexical overlap", async () => {
  const facts = [fact(1, "My periodical subscription is active."), fact(2, "I receive Cedar Review every week."),
    fact(3, "I bought one issue of Ocean Atlas."), fact(4, "I cancelled Winter Quarterly."), fact(5, "我正在阅读远山画报。"), fact(6, "A streaming payment is active.")];
  const query = "periodical subscription";
  const baseline = selectMemoryEntries(facts, query, now, 8000);
  const remaining = facts.filter(f => !baseline.includes(f));
  const selected = await selectMemoryEntriesAsync(facts, query, now, 8000, "semantic-protected-080", { encoder: encoder(remaining.map(f => f === facts[5] ? 0.5 : 0.9)) });
  assert.deepEqual(selected.slice(0, baseline.length), baseline);
  assert.equal(selected.length, 5);
  for (const f of facts.slice(0, 5)) assert.ok(selected.includes(f));
  assert.equal(selected.find(f => f.id === facts[2]!.id)!.lesson, "I bought one issue of Ocean Atlas.");
  assert.equal(selected.find(f => f.id === facts[3]!.id)!.fact!.speaker, "user");
});

test("budgets and duplicate suppression never remove baseline, merge time updates or cut a fact", async () => {
  const first = fact(1, "I receive Cedar Review."), duplicate = { ...first, id: fact(2, "placeholder").id };
  const update = fact(3, "I no longer receive Cedar Review."); update.fact.messageTime = "2026-11-03";
  const huge = fact(4, "unrelated"); huge.lesson = "unrelated ".repeat(1000);
  for (const budget of [0, 150, 8000]) {
    const facts = [first, duplicate, update, huge], query = "subscriptions";
    const result = await selectMemoryEntriesAsync(facts, query, now, budget, "semantic-protected-075", { encoder: encoder([0.9, 0.9, 0.9, 0.95]) });
    assert.ok(result.map(memoryEntryLine).join("\n").length <= budget);
    assert.ok(!result.includes(huge)); assert.ok(!result.includes(duplicate));
    if (budget === 8000) assert.deepEqual(result, [first, update]);
  }
});

test("eligibility is applied before encoding and revoked or changed facts reject late scores", async () => {
  const active = fact(1, "Cedar Review arrives."), archived = { ...fact(2, "secret periodical"), status: "archived" as const };
  let received: readonly string[] = [];
  await semanticRecallContext([active, archived], "subscriptions", now, "semantic-protected-080", { identity: "scope", async scores(_q, docs) { received = docs; return [0.9]; } });
  assert.equal(received.length, 1); assert.ok(!received.join().includes("secret"));
  await assert.rejects(selectMemoryEntriesAsync([active], "subscriptions", now, 8000, "semantic-protected-080", {
    encoder: { identity: "changed", async scores() { active.lesson = "changed concurrently"; return [0.9]; } },
  }), /changed during encoding/u);
  let current = true;
  await assert.rejects(selectMemoryEntriesAsync([active], "subscriptions", now, 8000, "semantic-protected-080", {
    encoder: { identity: "revoked", async scores() { current = false; return [0.9]; } }, assertCurrent: async () => { if (!current) throw Error("scope revoked"); },
  }), /scope revoked/u);
});

test("empty queries preserve preferences; cancellation, malformed scores and encoder failures never fall back", async () => {
  const facts = [fact(1, "Use concise answers")]; facts[0]!.scope = "user";
  const failing: SemanticEncoder = { identity: "error", async scores() { throw Error("encoder unavailable"); } };
  assert.deepEqual(await selectMemoryEntriesAsync(facts, "", now, 8000, "semantic-protected-080", { encoder: failing }), facts);
  await assert.rejects(selectMemoryEntriesAsync(facts, "unmatched", now, 8000, "semantic-protected-080"), /encoder required/u);
  await assert.rejects(selectMemoryEntriesAsync([], "unmatched", now, 8000, "semantic-protected-080", { encoder: failing }), /unavailable/u);
  await assert.rejects(selectMemoryEntriesAsync([fact(2, "Cedar")], "unmatched", now, 8000, "semantic-protected-080", { encoder: encoder([NaN]) }), /Invalid semantic scores/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(selectMemoryEntriesAsync([], "query", now, 8000, "semantic-protected-080", { encoder: failing, signal: controller.signal }), { name: "AbortError" });
});

test("token windows cover long bilingual facts with bounded overlap", () => {
  const tokens = Array.from({ length: 1300 }, (_, i) => i), windows = semanticWindows(tokens);
  assert.ok(windows.every(w => w.length <= 480)); assert.equal(windows[1]![0], 416);
  assert.deepEqual([...new Set(windows.flat())], tokens);
});

test("encoder cache keys isolate model identity, query/passages and exact content", () => {
  const keys = [semanticCacheKey("model-a", "query", "猫"), semanticCacheKey("model-b", "query", "猫"),
    semanticCacheKey("model-a", "passage", "猫"), semanticCacheKey("model-a", "query", "猫咪")];
  assert.equal(new Set(keys).size, 4);
  assert.equal(keys[0], semanticCacheKey("model-a", "query", "猫"));
  assert.ok(keys.every(k => /^[a-f0-9]{64}$/u.test(k)));
});

test("local asset manifests bind runtime, exact file set and bytes, and reject corruption", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "semantic-assets-")); t.after(() => rm(root, { recursive: true, force: true }));
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const names = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
  await mkdir(path.join(root, "onnx"));
  for (const name of names) await writeFile(path.join(root, name), name);
  const manifest = JSON.stringify({ model: "Xenova/multilingual-e5-small", runtime: LOCAL_ENCODER_RUNTIME, revision: "a".repeat(40), files: Object.fromEntries(names.map(n => [n, hash(n)])) });
  await writeFile(path.join(root, "assets.json"), manifest); await writeFile(path.join(root, "assets.sha256"), hash(manifest));
  const valid = await verifySemanticAssets(root); assert.equal(Object.keys(valid.files).length, 7);
  const oldRuntime = JSON.stringify({ ...JSON.parse(manifest), runtime: "3.8.1" });
  await writeFile(path.join(root, "assets.json"), oldRuntime); await writeFile(path.join(root, "assets.sha256"), hash(oldRuntime));
  await assert.rejects(verifySemanticAssets(root), /Unexpected encoder assets/u);
  await writeFile(path.join(root, "assets.json"), manifest); await writeFile(path.join(root, "assets.sha256"), hash(manifest));
  await writeFile(path.join(root, "tokenizer.json"), "changed"); await assert.rejects(verifySemanticAssets(root), /asset changed/u);
  await writeFile(path.join(root, "assets.json"), manifest + " "); await assert.rejects(verifySemanticAssets(root), /manifest changed/u);
});

test("BGE MMR gives complementary evidence room while preserving the entire baseline", async () => {
  const baseline = fact(1, "My serials include Cedar Review."), repeated = fact(2, "Cedar Review arrives weekly."),
    other = fact(3, "I also receive Mountain Ledger."), counter = fact(4, "I bought one Ocean Atlas issue.");
  const facts = [baseline, repeated, other, counter]; let receivedQuery = "";
  const model: SemanticEncoder = { identity: "mmr-controlled", async scores(query, docs) {
    receivedQuery = query; assert.equal(docs.length, 3); return [0.95, 0.85, 0.84];
  }, async similarities(docs) {
    assert.equal(docs.length, 4);
    return [[1, 0.99, 0.1, 0.1], [0.99, 1, 0.1, 0.1], [0.1, 0.1, 1, 0.1], [0.1, 0.1, 0.1, 1]];
  } };
  const result = await selectMemoryEntriesAsync(facts, "How many serials?", now, 8000, "semantic-protected-bge-mmr", { encoder: model });
  assert.equal(receivedQuery, "serial");
  assert.deepEqual(result.slice(0, 3), [baseline, other, counter]);
  assert.equal(result[0], selectMemoryEntries(facts, "How many serials?", now, 8000)[0]);
  assert.equal(counter.lesson, "I bought one Ocean Atlas issue.");
});

test("MMR rejects missing or malformed similarities and rechecks cancellation and concurrent changes", async () => {
  const f = fact(1, "Cedar Review");
  await assert.rejects(selectMemoryEntriesAsync([f], "periodical", now, 8000, "semantic-protected-bge-mmr", { encoder: encoder([0.8]) }), /similarities/u);
  const model: SemanticEncoder = { ...encoder([0.8]), async similarities() { return [[NaN]]; } };
  await assert.rejects(selectMemoryEntriesAsync([f], "periodical", now, 8000, "semantic-protected-bge-mmr", { encoder: model }), /Invalid document/u);
  model.similarities = async () => { f.fact.quote = "concurrent correction"; return [[1]]; };
  await assert.rejects(selectMemoryEntriesAsync([f], "periodical", now, 8000, "semantic-protected-bge-mmr", { encoder: model }), /changed during/u);
  const controller = new AbortController();
  model.similarities = async () => { controller.abort(); return [[1]]; };
  await assert.rejects(selectMemoryEntriesAsync([f], "periodical", now, 8000, "semantic-protected-bge-mmr", { encoder: model, signal: controller.signal }), { name: "AbortError" });
});
