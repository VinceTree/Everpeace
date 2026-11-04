import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sourceChainEvidence } from "../../fixtures/memory-source-chain.js";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { SessionHistoryRuntime } from "../../../src/storage/session-history.js";
import { LearnedMemoryRuntime, LearnedMemoryStore } from "../../../src/memory/learned-memory.js";

test("facts return the exact original message after restart, compaction and same-project session changes", async t => {
  const root = await mkdtemp(join(tmpdir(), "source-chain-")); t.after(() => rm(root, { recursive: true, force: true }));
  const report = await sourceChainEvidence(root);
  assert.equal(report.readMismatches, 0); assert.equal(report.rows.length, 13);
});

test("agent binds its final persisted assistant message and Memory preserves it through the queue", async t => {
  const root = await mkdtemp(join(tmpdir(), "source-agent-")); const workspace = join(root, "workspace"); await mkdir(workspace);
  const sessions = new SessionStore({ directory: join(root, "sessions") });
  const session = await sessions.create({ workspacePath: workspace, title: "Capture", titlePending: false, model: { id: "offline", model_name: "offline", base_url: "https://example.invalid" } });
  const store = new LearnedMemoryStore({ directory: join(root, "memory") });
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  const memory = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 0, unrefTimers: false, client: { responses: { async create() {
    return { id: "extract", status: "completed", output: [], usage, output_text: JSON.stringify({ entries: [], facts: [{ statement: "Assistant recommended lager", sourceIndex: 1, quote: "Use **lager**" }] }) };
  } } } });
  const history = new SessionHistoryRuntime({ store: sessions, workspacePath: workspace, sessionId: () => session.id });
  const agent = new ReactAgent({ workspacePath: workspace, model: "offline", learnedMemory: memory, sessionHistory: history,
    onHistoryAppend: items => sessions.appendContext(session.id, items),
    client: { responses: { async create() { return { id: "answer", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Use **lager**" }] }], output_text: "Use **lager**", usage }; } } },
    io: { getSessionId: () => session.id, async confirmBash() { return false; }, async runBash() { throw Error("No shell"); }, writeAssistant() {} } });
  t.after(async () => { await agent.dispose(); await memory.dispose(); await rm(root, { recursive: true, force: true }); });
  await agent.runTurn("Which beer?"); await agent.finishMemoryTurn("conversation_completed"); await memory.endTurn();
  for (let i = 0; i < 400 && !(await store.readFacts(workspace)).length; i++) await new Promise(r => setTimeout(r, 10));
  const facts = await store.readFacts(workspace); assert.equal(facts.length, 1);
  assert.equal((await store.read("project", workspace)).length, 0);
  const fact = facts[0]!; assert.equal(fact.fact.lookup.sourceStatus, "bound");
  await history.prepareStep();
  const read = await history.call("session_event_read", JSON.stringify(fact.fact.lookup.read!.arguments));
  assert.equal(read.status, "ok"); assert.equal(read.content, "Use **lager**");
  assert.equal(fact.fact.messageTime, read.at);
});

test("identical turns queue distinct actual events while the same captured version remains idempotent", async t => {
  const root = await mkdtemp(join(tmpdir(), "source-repeat-"));
  const sessions = new SessionStore({ directory: join(root, "sessions") });
  const session = await sessions.create({ workspacePath: root, title: "Repeat", titlePending: false,
    model: { id: "offline", model_name: "offline", base_url: "https://example.invalid" } });
  const history = new SessionHistoryRuntime({ store: sessions, workspacePath: root, sessionId: () => session.id });
  const store = new LearnedMemoryStore({ directory: join(root, "memory") });
  const memory = new LearnedMemoryRuntime({ store, model: "offline", idleDelayMs: 300_000, client: { responses: { async create() { throw Error("No requests before idle"); } } } });
  t.after(async () => { await memory.dispose(); await rm(root, { recursive: true, force: true }); });
  for (let repeat = 0; repeat < 2; repeat++) {
    const token = await history.beginMessageCapture(); assert.ok(token);
    const items = [{ role: "user", content: "Luna" }, { role: "assistant", content: "Luna" }];
    await sessions.appendContext(session.id, items);
    const result = await history.resolveMessages(token, items); assert.equal(result.status, "bound");
    const turn = { workspacePath: root, sessionId: session.id, userInput: "Luna", assistantText: "Luna", transcript: JSON.stringify(items), toolCallCount: 0, messages: result.messages };
    await memory.finishTurn(turn, "conversation_completed");
    await memory.finishTurn(turn, "conversation_completed");
  }
  const jobs = await store.loadJobs();
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0]!.id, jobs[1]!.id);
  assert.ok(jobs.every(job => job.turn.messages?.every(message => message.source)));
});
