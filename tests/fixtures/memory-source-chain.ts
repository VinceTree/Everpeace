import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "../../src/storage/session-store.js";
import { SessionHistoryRuntime } from "../../src/storage/session-history.js";
import { LearnedMemoryStore, type LearnedTurn } from "../../src/memory/learned-memory.js";
import { extractMemoryBundle, normalizeFact, type MemoryFact } from "../../src/memory/facts.js";

/** Real storage and shared production pipeline; all model outputs are fixed local fixtures. */
export async function sourceChainEvidence(root: string) {
  const workspace = join(root, "workspace"); await mkdir(workspace, { recursive: true });
  const sessions = new SessionStore({ directory: join(root, "sessions") });
  const memoryDirectory = join(root, "memory");
  const store = new LearnedMemoryStore({ directory: memoryDirectory });
  const model = { id: "offline", model_name: "offline", base_url: "https://example.invalid" };
  let current = (await sessions.create({ workspacePath: workspace, title: "Source evidence", titlePending: false, model })).id;
  const history = () => new SessionHistoryRuntime({ store: sessions, workspacePath: workspace, sessionId: () => current });
  const runtime = history();
  const rows: Array<{ name: string; result: string }> = [];
  const facts: MemoryFact[] = [];
  const capture = async (name: string, items: Array<{ role: "user" | "assistant"; content: string }>, quotes: Array<{ sourceIndex: number; quote: string }>) => {
    const boundary = await runtime.beginMessageCapture(); assert.ok(boundary);
    await sessions.appendContext(current, items);
    // Tool reads still see the previously prepared prefix, never the host capture's new EOF.
    const resolved = await runtime.resolveMessages(boundary, items);
    assert.equal(resolved.status, "bound", resolved.reason);
    const hidden = await runtime.call("session_event_search", JSON.stringify({ query: quotes[0]!.quote }));
    assert.deepEqual(hidden.matches, [], "host capture must not widen model history access");
    const turn: LearnedTurn = { workspacePath: workspace, sessionId: current, transcript: JSON.stringify(items),
      userInput: items[0]!.content, assistantText: items.at(-1)!.content, toolCallCount: 0, messages: resolved.messages };
    const bundle = await extractMemoryBundle({ turn, model: "offline", captureLessons: false, client: { responses: { async create(params) {
      const request = JSON.parse(String(params.input)) as { messages: Array<{ sourceIndex: number; text: string }> };
      assert.doesNotMatch(String(params.input), /eventId|messageSha256|quoteStartBytes/u);
      return { id: "offline", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        output_text: JSON.stringify({ entries: [], facts: quotes.filter(q => request.messages.some(m => m.sourceIndex === q.sourceIndex && m.text.includes(q.quote))).map(q => ({ ...q, statement: q.quote, eventId: "model-fabricated" })) }) };
    } } } });
    assert.equal(bundle.facts.length, quotes.length);
    await store.appendFacts(workspace, bundle.facts, { epochs: await store.captureEpochs(workspace) });
    facts.push(...bundle.facts);
    rows.push({ name, result: "exact_binding" });
    return bundle.facts;
  };
  await runtime.prepareStep();
  await capture("Luna", [{ role: "user", content: "My cat is Luna" }, { role: "assistant", content: "Luna sounds lovely" }], [{ sourceIndex: 0, quote: "My cat is Luna" }]);
  await capture("assistant recommendation", [{ role: "user", content: "What beer?" }, { role: "assistant", content: "I recommended **lager**, or pilsner." }], [{ sourceIndex: 1, quote: "**lager**" }]);
  await capture("mummies and UTF-8 tail", [{ role: "user", content: "前缀🙂\n".repeat(5000) + "尾部共有 4 个木乃伊。" }, { role: "assistant", content: "收到。" }], [{ sourceIndex: 0, quote: "4 个木乃伊" }]);
  const repeated = await capture("duplicate bodies and roles", [{ role: "user", content: "Luna" }, { role: "assistant", content: "Luna" }, { role: "user", content: "Luna" }], [0, 1, 2].map(sourceIndex => ({ sourceIndex, quote: "Luna" })));
  assert.equal(new Set(repeated.map(f => f.fact.source!.eventId)).size, 3);
  const newer = await capture("duplicate in later turn", [{ role: "user", content: "Luna" }], [{ sourceIndex: 0, quote: "Luna" }]);
  assert.notEqual(newer[0]!.fact.source!.eventId, repeated[0]!.fact.source!.eventId);
  await capture("prior state", [{ role: "user", content: "旧地址是松林路 8 号。" }], [{ sourceIndex: 0, quote: "松林路 8 号" }]);
  await capture("updated state", [{ role: "user", content: "现在搬到了海岸路 12 号。" }], [{ sourceIndex: 0, quote: "海岸路 12 号" }]);
  await sessions.compactContext(current, [{ role: "assistant", content: "Summary omits all names and counts" }], true, null);
  current = (await sessions.create({ workspacePath: workspace, title: "New chat", titlePending: false, model })).id;
  const restarted = history(); await restarted.prepareStep();
  const reopened = new LearnedMemoryStore({ directory: memoryDirectory });
  for (const fact of facts) {
    const loaded = await reopened.lookup(workspace, fact.id); assert.ok(loaded?.fact?.lookup.read);
    const args = loaded.fact.lookup.read.arguments;
    const page = await restarted.call("session_event_read", JSON.stringify({ ...args, max_bytes: 256 }));
    assert.equal(page.status, "ok"); assert.ok(String(page.content).startsWith(fact.fact.quote));
    assert.equal(page.at, fact.fact.messageTime);
    assert.equal(page.kind, fact.fact.speaker);
  }
  rows.push({ name: "restart, compaction, new session and byte paging", result: "exact_read" });
  const fact = facts[0]!;
  const args = fact.fact.lookup.read!.arguments;
  const foreign = new SessionHistoryRuntime({ store: sessions, workspacePath: join(root, "other"), sessionId: () => current });
  await foreign.prepareStep();
  assert.equal((await foreign.call("session_event_read", JSON.stringify(args))).status, "not_found");
  rows.push({ name: "cross-project source", result: "source_unavailable" });
  assert.equal((await restarted.call("session_event_read", JSON.stringify({ ...args, event_id: args.event_id + "x" }))).status, "not_found");
  rows.push({ name: "tampered event reference", result: "source_unavailable" });
  const legacy = structuredClone(fact); delete legacy.fact.source;
  const old = normalizeFact(legacy);
  assert.equal(old.id, fact.id); assert.equal(old.fact.lookup.sourceStatus, "unbound"); assert.ok(old.fact.lookup.query); assert.equal(old.fact.lookup.read, undefined);
  rows.push({ name: "legacy record", result: "search_fallback" });
  await store.setEnabled(false); assert.equal((await store.snapshot(workspace, "Luna")).text, "");
  await store.setEnabled(true);
  const origin = join(sessions.directory, `${args.session_id}.jsonl`);
  const bytes = await readFile(origin, "utf8");
  await writeFile(origin, bytes.replace("My cat is Luna", "My cat is Lily"));
  assert.equal((await restarted.call("session_event_read", JSON.stringify(args))).status, "not_found");
  rows.push({ name: "rewritten original message", result: "source_unavailable" });
  await sessions.deleteMany([args.session_id]);
  assert.equal((await restarted.call("session_event_read", JSON.stringify(args))).status, "not_found");
  rows.push({ name: "deleted original session", result: "source_unavailable" });
  await store.clear("project", workspace); assert.equal(await store.lookup(workspace, fact.id), undefined);
  return { modelRequests: 0, fixedResponseCallsOnly: true, qaAccuracy: null, rows, readMismatches: 0 };
}
