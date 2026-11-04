import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseMemoryDataset, memoryPlan, historyTurn, bm25History, parseJudgeLabel, judgePrompt, parseJudgeTemplates } from "../../../src/benchmark/memory-data.js";
import { MemoryRequestGate, jsonFiles, readJson, writeJson, type MemoryRequestRecord } from "../../../src/benchmark/memory-evidence.js";
import { createMemoryAdapter } from "../../../src/benchmark/memory-adapters.js";
import { LearnedMemoryStore } from "../../../src/memory/learned-memory.js";
import { DEFAULT_MEMORY_CONFIG, parseMemoryConfig, freezeValidatedMemoryIdentity } from "../../../src/benchmark/memory-campaign.js";
import { memoryBootstrap } from "../../../src/benchmark/memory-report.js";
import type { AgentResponse, ResponsesClientLike } from "../../../src/agent/model-protocol.js";

const fixture = () => [{ question_id: "q1", question_type: "single-session-user", question: "ANSWER_SHOULD_NOT_REACH_BUILD", question_date: "2026-01-02", answer: "GOLD_SECRET", answer_session_ids: ["s1"], haystack_session_ids: ["s1"], haystack_dates: ["2026-01-01"], haystack_sessions: [[{ role: "user", content: "Remember cobalt conventions", has_answer: true }, { role: "assistant", content: "The marker is cobalt" }]] }];
const response = (text = "yes"): AgentResponse => ({ id: "test", status: "completed", output: [], output_text: text, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
async function temporary(run: (directory: string) => Promise<void>) { const dir = await mkdtemp(path.join(os.tmpdir(), "memory-batch-")); try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

test("dataset projection and turn construction exclude all evaluator labels; fixed balanced plan", () => {
  const data = parseMemoryDataset(fixture(), 1), question = data.questions[0]!;
  assert.ok(!JSON.stringify(question.history).includes("has_answer"));
  const turn = historyTurn(question.history[0]!, "isolated", "run");
  assert.ok(!JSON.stringify(turn).includes("GOLD_SECRET")); assert.ok(!JSON.stringify(turn).includes("ANSWER_SHOULD"));
  assert.equal(turn.toolCallCount, 0); assert.match(turn.sessionId!, /^bench-/u);
  const plan = memoryPlan(data.questions); assert.equal(plan.length, 9); assert.equal(new Set(plan.map(p => p.key)).size, 9);
  assert.deepEqual(plan.filter(p => p.repetition === 1).map(p => p.arm), ["no-memory", "learned-memory", "bm25-history"]);
  assert.equal(plan.filter(p => p.repetition === 2)[0]?.arm, "learned-memory");
  assert.throws(() => parseMemoryDataset(fixture()), /count/u);
  const duplicate = [...fixture(), ...fixture()]; assert.throws(() => parseMemoryDataset(duplicate, 2), /metadata/u);
  const repeated = fixture(); repeated[0]!.haystack_session_ids.push("s1"); repeated[0]!.haystack_dates.push("2026-01-01"); repeated[0]!.haystack_sessions.push(repeated[0]!.haystack_sessions[0]!);
  assert.equal(parseMemoryDataset(repeated, 1).questions[0]!.history.length, 2);
  assert.throws(() => parseMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, apiKey: "forbidden" }));
  assert.deepEqual(parseMemoryConfig(DEFAULT_MEMORY_CONFIG), DEFAULT_MEMORY_CONFIG);
});

test("BM25 retrieves relevant complete bounded chunks and strict judge handles classification without interpolation", () => {
  const history = parseMemoryDataset(fixture(), 1).questions[0]!.history;
  const hit = bm25History(history, "cobalt"); assert.deepEqual(hit.sources, ["s1"]); assert.ok(hit.text.length <= 8000);
  assert.equal(bm25History(history, "absentword").text, "");
  assert.equal(parseJudgeLabel(" YES\n"), true); assert.equal(parseJudgeLabel("no"), false); assert.throws(() => parseJudgeLabel("yes, because"));
  const templates = ["Q:{} A:{} H:{}", "TIME:{} {} {}", "UPDATE:{} {} {}", "PREF:{} {} {}", "ABS:{} {} {}"];
  assert.equal(judgePrompt(templates, { id: "q_abs", type: "temporal-reasoning", question: "{}" }, 4, "no"), "ABS:{} 4 no");
  assert.equal(parseJudgeTemplates(templates.map(t => `template = "${t}"\n prompt = template.format(question, answer, response)`).join("\n")).length, 5);
  assert.throws(() => parseJudgeTemplates("changed upstream"));
});

test("durable gate bounds parallel requests, caches settled responses and preserves unknown across recovery", async () => temporary(async dir => {
  const gate = new MemoryRequestGate(dir); let active = 0, peak = 0, calls = 0;
  const client: ResponsesClientLike = { responses: { async create() { calls++; active++; peak = Math.max(peak, active); await delay(10); active--; return response(); } } };
  await Promise.all([0, 1, 2, 3].map(i => gate.request(client, String(i), "answer", {})));
  assert.equal(peak, 2); assert.equal(gate.peak, 2); await gate.validateRecovery();
  await gate.request(client, "0", "answer", {}); assert.equal(calls, 4);
  const unknown: ResponsesClientLike = { responses: { async create() { const r = response(); delete r.usage; return r; } } };
  await gate.request(unknown, "unknown", "answer", {}); assert.equal(gate.stopReason, "usage_unknown");
  await assert.rejects(new MemoryRequestGate(dir).validateRecovery(), /unknown/u);
  await assert.rejects(gate.request(client, "later", "answer", {})); assert.equal(calls, 4);
  const rows = await Promise.all((await jsonFiles(dir)).map(file => readJson<MemoryRequestRecord>(file)));
  assert.equal(rows.length, 5); assert.equal(rows.reduce((s, r) => s + r.usage.inputTokens, 0), 16);
}));

test("late successful response retains known usage after cancellation; no admission after stop", async () => temporary(async dir => {
  const gate = new MemoryRequestGate(dir); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const client: ResponsesClientLike = { responses: { async create() { entered(); await waiting; return response(); } } };
  const run = gate.request(client, "late", "answer", {}); await started; gate.stop("cancelled"); release(); await run;
  await gate.validateRecovery();
  assert.equal((await readJson<MemoryRequestRecord>((await jsonFiles(dir))[0]!)).usage.outputTokens, 2);
  await assert.rejects(gate.request(client, "after-stop", "answer", {}));
}));

test("unknown usage stops admission without cancelling another in-flight response", async () => temporary(async dir => {
  const gate = new MemoryRequestGate(dir); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const client: ResponsesClientLike = { responses: { async create(params, options) {
    if (params.input === "slow") { entered(); await waiting; assert.equal(options?.signal?.aborted, false); return response(); }
    return { ...response(), usage: null };
  } } };
  const slow = gate.request(client, "slow", "answer", { input: "slow" });
  await started;
  await gate.request(client, "unknown", "answer", {}); release(); await slow;
  assert.equal(gate.stopReason, "usage_unknown");
  await assert.rejects(gate.request(client, "new", "answer", {}));
  const rows = await Promise.all((await jsonFiles(dir)).map(file => readJson<MemoryRequestRecord>(file)));
  assert.equal(rows.find(r => r.key === "slow")?.usage.complete, true);
}));

test("isolated learned adapter reuses production conflict pipeline without verified jobs or fake tools", async () => temporary(async dir => {
  const gate = new MemoryRequestGate(path.join(dir, "requests")), seen: string[] = [];
  const client: ResponsesClientLike = { responses: { async create(params) { seen.push(JSON.stringify(params)); return response(JSON.stringify({ entries: [{ scope: "project", lesson: "Use cobalt marker", applyWhen: "cobalt conventions", confidence: "high" }] })); } } };
  const history = parseMemoryDataset(fixture(), 1).questions[0]!.history;
  const adapter = createMemoryAdapter("learned-memory", path.join(dir, "sample"), "test", client, gate, "one");
  await adapter.build(history, gate.controller.signal);
  const recalled = await adapter.retrieve("cobalt conventions"); assert.match(recalled.text, /cobalt marker/u); assert.deepEqual(recalled.sources, ["s1"]);
  assert.ok(!seen.join().includes("GOLD_SECRET")); assert.ok(!seen.join().includes("ANSWER_SHOULD"));
  const store = new LearnedMemoryStore({ directory: path.join(dir, "sample/store") }); assert.deepEqual(await store.loadJobs(), []);
  const second = createMemoryAdapter("learned-memory", path.join(dir, "sample"), "test", client, gate, "one"); await second.build(history, gate.controller.signal); assert.equal(seen.length, 1);
  await writeJson(path.join(dir, "sample/build.json"), { next: 0, clippedChars: 0, sources: {} });
  const recovered = createMemoryAdapter("learned-memory", path.join(dir, "sample"), "test", client, gate, "one"); await recovered.build(history, gate.controller.signal); assert.equal(seen.length, 1);
  const off = createMemoryAdapter("no-memory", path.join(dir, "other"), "test", client, gate, "other"); await off.build(history, gate.controller.signal); assert.equal((await off.retrieve("cobalt")).text, "");
  assert.equal(seen.length, 1); assert.ok((await readFile(path.join(dir, "sample/build.json"), "utf8")).includes("s1"));
}));

test("cluster inference is unavailable when results are incomplete", () => {
  assert.equal(memoryBootstrap([], "bm25-history", false).interval95, null);
});

test("execution freezes the final build after checks but rejects source changes", () => {
  const prepared = { revision: "r", sourceDigest: "source", buildDigest: "before", node: "22", entryPath: "entry" };
  assert.equal(freezeValidatedMemoryIdentity(prepared, { ...prepared, buildDigest: "after" }).buildDigest, "after");
  assert.throws(() => freezeValidatedMemoryIdentity(prepared, { ...prepared, sourceDigest: "changed" }), /source_identity/u);
});

test("an interrupted durable request prevents fresh admission on recovery", async () => temporary(async dir => {
  await writeJson(path.join(dir, "pending.json"), { state: "pending", openRequests: 1, usage: { complete: false }, key: "interrupted" });
  await assert.rejects(new MemoryRequestGate(dir).validateRecovery(), /Unresolved/u);
}));

test("changed request payload cannot reuse a settled response", async () => temporary(async dir => {
  const gate = new MemoryRequestGate(dir), client: ResponsesClientLike = { responses: { async create() { return response(); } } };
  await gate.request(client, "frozen", "answer", { input: "first" });
  await assert.rejects(gate.request(client, "frozen", "answer", { input: "changed" }), /identity/u);
  assert.equal(gate.stopReason, "request_identity_changed");
}));

test("overlong and conflicting sessions preserve production clipping and review", async () => temporary(async dir => {
  const gate = new MemoryRequestGate(path.join(dir, "requests")); let seenTranscript = 0;
  const client: ResponsesClientLike = { responses: { async create(params) {
    const parsed = JSON.parse(String(params.input)) as { transcript?: string };
    seenTranscript = Math.max(seenTranscript, parsed.transcript?.length ?? 0);
    return response(JSON.stringify({ entries: [{ scope: "project", lesson: "First convention", applyWhen: "same conditions" }, { scope: "project", lesson: "Conflicting convention", applyWhen: "same conditions" }] }));
  } } };
  const history = parseMemoryDataset(fixture(), 1).questions[0]!.history;
  history[0]!.messages[0]!.content += " "+"long ".repeat(7000);
  const adapter = createMemoryAdapter("learned-memory", path.join(dir, "sample"), "offline", client, gate, "review");
  await adapter.build(history, gate.controller.signal); const result = await adapter.retrieve("same conditions");
  assert.ok(seenTranscript <= 24000); assert.ok(result.clippedChars > 0); assert.equal(result.active, 0); assert.equal(result.review, 2);
}));

test("known incomplete extraction retries preserve every request and do not repeat on resume", async () => temporary(async dir => {
  const gate = new MemoryRequestGate(path.join(dir, "requests")); let calls = 0;
  const client: ResponsesClientLike = { responses: { async create() {
    calls++; if (calls === 1) return { ...response(), status: "incomplete" };
    return response(JSON.stringify({ entries: [{ lesson: "Use cobalt", applyWhen: "cobalt conventions" }] }));
  } } };
  const history = parseMemoryDataset(fixture(), 1).questions[0]!.history;
  const adapter = createMemoryAdapter("learned-memory", path.join(dir, "sample"), "offline", client, gate, "retry");
  await adapter.build(history, gate.controller.signal); assert.equal(calls, 2); assert.equal((await jsonFiles(path.join(dir, "requests"))).length, 2);
  assert.equal(gate.stopReason, undefined);
}));
