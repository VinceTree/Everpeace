import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMemoryBundle, factSources, factWindows, parseMemoryExtraction, normalizeFactSource } from "../../../src/memory/facts.js";
import { createHash } from "node:crypto";
import { LearnedMemoryRuntime, LearnedMemoryStore, type LearnedTurn } from "../../../src/memory/learned-memory.js";

const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
const turn: LearnedTurn = { workspacePath: "fixture", sessionId: "fixture-session", userInput: "My cat is Luna", assistantText: "Use lager", transcript: "fixture", toolCallCount: 0,
  messages: [{ role: "user", text: "My cat is Luna", messageTime: "2024-01-01", sourceId: "u1" },
    { role: "assistant", text: "Use lager", messageTime: "2024-01-02", sourceId: "a1" }] };
const response = (facts: unknown[]) => ({ id: "fixture", status: "completed", output: [], output_text: JSON.stringify({ entries: [], facts }), usage });
async function wait(check: () => Promise<boolean>) { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail("capture did not settle"); }

test("facts retain literal names, counts and assistant attribution with original dates", async () => {
  const bundle = await extractMemoryBundle({ turn, model: "offline", captureLessons: false, client: { responses: { async create() {
    return response([{ statement: "Cat is Luna", sourceIndex: 0, quote: "My cat is Luna" }, { statement: "Assistant recommended lager", sourceIndex: 1, quote: "Use lager" }]);
  } } } });
  assert.equal(bundle.facts.length, 2);
  assert.equal(bundle.facts[1]!.fact.speaker, "assistant");
  assert.equal(bundle.facts[0]!.fact.messageTime, "2024-01-01");
  assert.equal(bundle.facts[1]!.fact.lookup.session_id, "fixture-session");
  assert.equal(bundle.facts[1]!.fact.lookup.query, "Use lager");
  assert.notEqual(bundle.facts[0]!.createdAt.slice(0, 4), "2024");
});

test("empty, invalid, malformed and unsupported source outputs do not become equivalent successes", async () => {
  assert.deepEqual(parseMemoryExtraction('{"entries":[],"facts":[]}'), { entries: [], facts: [] });
  assert.throws(() => parseMemoryExtraction("{"), /invalid_json/u);
  assert.throws(() => parseMemoryExtraction('{"entries":[{}]}'), /invalid_schema/u);
  const result = await extractMemoryBundle({ turn, model: "offline", captureLessons: false, client: { responses: { async create() {
    return response([{ statement: "Cat is Pip", sourceIndex: 0, quote: "Cat is Pip" },
      { statement: "Cat is Luna", sourceIndex: 0, quote: "My cat is Luna" }]);
  } } } });
  assert.equal(result.rejectedFacts, 1);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]!.lesson, "Cat is Luna");

});

test("long input windows retain the end of oversized messages and message identity", () => {
  const sources = factSources({ ...turn, messages: [{ role: "user", text: "a".repeat(26000) + " Mummies (4)", sourceId: "long", messageTime: "2024-01-01" }] });
  const windows = factWindows(sources);
  assert.equal(windows.length, 2);
  assert.match(windows[1]![0]!.text, /Mummies \(4\)$/u);
  assert.equal(windows.flat().map(m => m.text).join(""), sources[0]!.text);
  assert.ok(windows.flat().every(m => m.sourceIndex === 0 && m.sourceId === "long"));
});

test("source normalization preserves layout and invalidates changed or clipped host bindings", () => {
  const text = "  中文🙂\n  Luna  ";
  const source = { sessionId: "source-session", eventId: "history_fixture", messageSha256: createHash("sha256").update(text).digest("hex") };
  const input = { role: "user" as const, text, sourceId: "message-0", messageTime: "2024-01-01", source };
  assert.deepEqual(normalizeFactSource(input).source, source);
  assert.equal(normalizeFactSource(input).text, text);
  assert.equal(normalizeFactSource({ ...input, text: text + "changed" }).source, undefined);
  assert.equal(normalizeFactSource(input, 4).source, undefined);
  const windows = factWindows([{ ...input, text: "a".repeat(23999) + "🙂tail" }]);
  assert.equal(windows[0]![0]!.text.length, 23999);
  assert.equal(windows[1]![0]!.text, "🙂tail");
  assert.ok(windows.every(w => w[0]!.messageSha256 === windows[0]![0]!.messageSha256));
});

test("fact storage is independent of lesson capacity, persistent, isolated and epoch fenced", async t => {
  const directory = await mkdtemp(join(tmpdir(), "memory-facts-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LearnedMemoryStore({ directory });
  const bundle = await extractMemoryBundle({ turn, model: "offline", captureLessons: false, client: { responses: { async create() {
    return response([{ statement: "Cat Luna", sourceIndex: 0, quote: "My cat is Luna" }]);
  } } } });
  const epochs = await store.captureEpochs("workspace");
  await store.appendFacts("workspace", bundle.facts, { epochs });
  await store.appendFacts("workspace", bundle.facts, { epochs });
  assert.equal((await new LearnedMemoryStore({ directory }).readFacts("workspace")).length, 1);
  assert.equal((await store.read("project", "workspace")).length, 0);
  assert.equal((await store.readFacts("other")).length, 0);
  assert.match((await store.snapshot("workspace", "Luna")).text, /My cat is Luna/u);
  assert.ok(await store.lookup("workspace", bundle.facts[0]!.id));
  await store.clear("project", "workspace");
  await assert.rejects(store.appendFacts("workspace", bundle.facts, { epochs }), /scope changed/u);
  assert.equal((await store.readFacts("workspace")).length, 0);
});

test("host classified ordinary completion captures only facts; unverified outcomes never capture", async t => {
  const directory = await mkdtemp(join(tmpdir(), "memory-conversation-"));
  const store = new LearnedMemoryStore({ directory }); let calls = 0;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create(params) { calls++; assert.match(String(params.input), /"captureLessons":false/u); return response([{ statement: "Cat Luna", sourceIndex: 0, quote: "My cat is Luna" }]); } } } });
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); });
  for (const outcome of ["failed", "unverified", "cancelled", "stopped"] as const) await runtime.finishTurn(turn, outcome);
  assert.equal(calls, 0);
  await runtime.finishTurn(turn, "conversation_completed");
  await wait(async () => (await runtime.status(turn.workspacePath)).capture?.state === "succeeded");
  assert.equal(calls, 1);
  assert.equal((await store.readFacts(turn.workspacePath)).length, 1);
  assert.equal((await store.read("project", turn.workspacePath)).length, 0);
});

test("late fact extraction after clear or disabled capture cannot repopulate storage", async t => {
  const directory = await mkdtemp(join(tmpdir(), "memory-fact-late-")); const store = new LearnedMemoryStore({ directory });
  let release!: (r: ReturnType<typeof response>) => void, started = false;
  const runtime = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false,
    client: { responses: { async create() { started = true; return new Promise<ReturnType<typeof response>>(r => { release = r; }); } } } });
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); });
  await runtime.finishTurn(turn, "conversation_completed"); await wait(async () => started);
  await store.clear("project", turn.workspacePath);
  release(response([{ statement: "Luna", sourceIndex: 0, quote: "My cat is Luna" }]));
  await wait(async () => (await store.loadJobs()).every(j => j.status !== "running"));
  assert.equal((await store.readFacts(turn.workspacePath)).length, 0);
});
