import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ReactAgent, type AgentIO, type ResponsesClientLike } from "../../../src/agent/react-agent.js";
import { runAgentLoop, type ToolCall } from "../../../src/agent/agent-loop.js";
import { prepareToolOutput } from "../../../src/agent/context-limits.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { SessionHistoryRuntime } from "../../../src/storage/session-history.js";
import { PersistenceError } from "../../../src/storage/persistence-error.js";
import { runFileTool } from "../../../src/tools/files.js";
import { previewApplyPatch, runApplyPatch } from "../../../src/tools/apply-patch.js";

const model = { id: "offline", model_name: "offline", base_url: "https://api.openai.com/v1" };
const usage = { input_tokens: 5, output_tokens: 2, total_tokens: 7 };
const call = (id: string, name: string, args: unknown): ToolCall => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const answer = { id: "done", output_text: "done", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }], usage };
const io: AgentIO = {
  confirmBash: async () => true,
  runBash: async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null }),
  writeAssistant() {},
};

async function recoveryFixture(prefix: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace);
  const store = new SessionStore({ directory: path.join(directory, "sessions") });
  const session = await store.create({ title: "offline recovery", titlePending: false, workspacePath: workspace, model });
  return { directory, workspace, store, session };
}

function outputIn(params: Record<string, unknown>, callId: string): Record<string, unknown> {
  const item = (params.input as Array<Record<string, unknown>>).find((entry) => entry.type === "function_call_output" && entry.call_id === callId);
  assert.ok(item, `Missing tool result ${callId}`);
  return JSON.parse(String(item.output)) as Record<string, unknown>;
}

test("same-session reconstruction preserves durable output IDs and defaults reads to the resumed session", async () => {
  const f = await recoveryFixture("everpeace-same-session-recovery-");
  let originalRequests = 0;
  const first = new ReactAgent({
    model: "offline", workspacePath: f.workspace,
    io: { ...io, getSessionId: () => f.session.id, runBash: async () => ({ stdout: `SAME-SESSION-${"中😀".repeat(9_000)}-TAIL`, stderr: "", exitCode: 0, signal: null }) },
    client: { responses: { create: async () => ++originalRequests === 1 ? { id: "large", output_text: "", output: [call("original", "bash", { command: "fixture" })], usage } : answer } },
    sessionHistory: new SessionHistoryRuntime({ store: f.store, workspacePath: f.workspace, sessionId: () => f.session.id }),
    onHistoryAppend: (items) => f.store.appendContext(f.session.id, items),
    onToolResultAppend: (item, attachment) => f.store.commitToolResult(f.session.id, item, attachment),
  });
  try {
    await first.runTurn("collect a retained output");
    await first.dispose();
    const restartedStore = new SessionStore({ directory: f.store.directory });
    const restored = await restartedStore.load(f.session.id);
    const original = restored.context.find((item) => item.type === "function_call_output" && item.call_id === "original")!;
    const envelope = JSON.parse(String(original.output)) as { output_id: string };
    let resumedRequests = 0;
    const resumed = new ReactAgent({
      model: "offline", workspacePath: f.workspace, initialHistory: restored.context,
      io: { ...io, getSessionId: () => f.session.id },
      client: { responses: { create: async (params) => {
        if (++resumedRequests === 1) {
          assert.equal(outputIn(params, "original").output_id, envelope.output_id);
          return { id: "resume-read", output_text: "", output: [call("read-default", "read_tool_output", { output_id: envelope.output_id, max_bytes: 100 })], usage };
        }
        const recovered = outputIn(params, "read-default");
        assert.equal(recovered.status, "ok");
        assert.equal(recovered.session_id, f.session.id);
        assert.equal(recovered.output_id, envelope.output_id);
        assert.match(String(recovered.content), /SAME-SESSION/u);
        return answer;
      } } },
      sessionHistory: new SessionHistoryRuntime({ store: restartedStore, workspacePath: f.workspace, sessionId: () => f.session.id }),
      onHistoryAppend: (items) => restartedStore.appendContext(f.session.id, items),
      onToolResultAppend: (item, attachment) => restartedStore.commitToolResult(f.session.id, item, attachment),
    });
    try { await resumed.runTurn("continue the same session"); assert.equal(resumedRequests, 2); }
    finally { await resumed.dispose(); }
  } finally {
    await first.dispose();
    await fs.rm(f.directory, { recursive: true, force: true });
  }
});

test("sampling retries reuse the history EOF and the next logical step sees a later append", async () => {
  const f = await recoveryFixture("everpeace-retry-history-eof-");
  const history = new SessionHistoryRuntime({ store: f.store, workspacePath: f.workspace, sessionId: () => f.session.id });
  const marker = "ARRIVED-BETWEEN-PROVIDER-ATTEMPTS";
  let preparations = 0;
  let requests = 0;
  const agent = new ReactAgent({
    model: "offline", workspacePath: f.workspace, io: { ...io, getSessionId: () => f.session.id }, samplingRetryBudget: 1,
    client: { responses: { create: async (params) => {
      requests++;
      if (requests === 1) {
        assert.equal(preparations, 1);
        await f.store.appendContext(f.session.id, [{ role: "user", content: marker }]);
        throw Object.assign(new Error("transient provider failure"), { status: 503 });
      }
      if (requests === 2) {
        assert.equal(preparations, 1);
        return { id: "retry", output_text: "", output: [call("frozen", "session_event_search", { query: marker })], usage };
      }
      if (requests === 3) {
        assert.equal(preparations, 2);
        assert.deepEqual(outputIn(params, "frozen").matches, []);
        return { id: "next-step", output_text: "", output: [call("refreshed", "session_event_search", { query: marker })], usage };
      }
      assert.equal(preparations, 3);
      const refreshed = outputIn(params, "refreshed");
      assert.ok((refreshed.matches as Array<{ kind: string; snippet: string }>).some((match) => match.kind === "user" && match.snippet.includes(marker)));
      return answer;
    } } },
    sessionHistory: {
      prepareStep: async (signal) => { preparations++; await history.prepareStep(signal); },
      call: (name, args, signal) => history.call(name, args, signal),
      readToolOutput: (args, signal) => history.readToolOutput(args, signal),
    },
    onHistoryAppend: (items) => f.store.appendContext(f.session.id, items),
    onToolResultAppend: (item, attachment) => f.store.commitToolResult(f.session.id, item, attachment),
  });
  try { await agent.runTurn("inspect late historical records"); assert.equal(requests, 4); }
  finally { await agent.dispose(); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("reading a historical file result grants no current file observation for patching", async () => {
  const f = await recoveryFixture("everpeace-history-file-observation-");
  await fs.writeFile(path.join(f.workspace, "file.txt"), "historical-file-marker\n", "utf8");
  const oldRead = await runFileTool("read_file", '{"path":"file.txt"}', f.workspace) as Record<string, unknown>;
  await f.store.appendContext(f.session.id, [call("old-read", "read_file", { path: "file.txt" }), { type: "function_call_output", call_id: "old-read", output: JSON.stringify(oldRead) }]);
  const history = new SessionHistoryRuntime({ store: f.store, workspacePath: f.workspace, sessionId: () => f.session.id });
  await history.prepareStep();
  const found = await history.call("session_event_search", '{"query":"historical-file-marker"}') as { matches: Array<{ kind: string; event_id: string }> };
  const event = found.matches.find((match) => match.kind === "tool_output")!;
  assert.ok(event);
  let requests = 0;
  let writes = 0;
  const patch = { operations: [{ action: "update", path: "file.txt", content: "current verified read\n", expectedSha256: oldRead.sha256 }] };
  const agent = new ReactAgent({
    model: "offline", workspacePath: f.workspace, initialHistory: (await f.store.load(f.session.id)).context,
    io: { ...io, getSessionId: () => f.session.id, previewPatch: (operations) => previewApplyPatch(operations, f.workspace), runApplyPatch: async (operations) => { writes++; return runApplyPatch(operations, f.workspace); } },
    client: { responses: { create: async (params) => {
      requests++;
      if (requests === 1) return { id: "history-read", output_text: "", output: [call("history-read", "session_event_read", { event_id: event.event_id })], usage };
      if (requests === 2) {
        assert.match(String(outputIn(params, "history-read").content), /historical-file-marker/u);
        return { id: "blind-patch", output_text: "", output: [call("blind-patch", "apply_patch", patch)], usage };
      }
      if (requests === 3) {
        assert.match(JSON.stringify(outputIn(params, "blind-patch")), /FILE_NOT_OBSERVED/u);
        assert.equal(writes, 0);
        assert.equal(await fs.readFile(path.join(f.workspace, "file.txt"), "utf8"), "historical-file-marker\n");
        return { id: "current-read", output_text: "", output: [call("current-read", "read_file", { path: "file.txt" })], usage };
      }
      if (requests === 4) return { id: "observed-patch", output_text: "", output: [call("observed-patch", "apply_patch", patch)], usage };
      assert.equal(outputIn(params, "observed-patch").status, "applied");
      return answer;
    } } },
    sessionHistory: history,
    onHistoryAppend: (items) => f.store.appendContext(f.session.id, items),
    onToolResultAppend: (item, attachment) => f.store.commitToolResult(f.session.id, item, attachment),
  });
  try {
    await agent.runTurn("update after recovering the old file result");
    assert.equal(writes, 1);
    assert.equal(await fs.readFile(path.join(f.workspace, "file.txt"), "utf8"), "current verified read\n");
  } finally { await agent.dispose(); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("legacy raw output restores a readable local ID without exposing it through another session", async () => {
  const f = await recoveryFixture("everpeace-legacy-local-output-");
  const other = await f.store.create({ title: "other same workspace", titlePending: false, workspacePath: f.workspace, model });
  await f.store.appendContext(f.session.id, [call("legacy", "bash", { command: "old" }), { type: "function_call_output", call_id: "legacy", output: `LEGACY-BODY-${"中".repeat(20_000)}` }]);
  const restored = await f.store.load(f.session.id);
  let requests = 0;
  let localId = "";
  const agent = new ReactAgent({
    model: "offline", workspacePath: f.workspace, initialHistory: restored.context, io: { ...io, getSessionId: () => f.session.id },
    client: { responses: { create: async (params) => {
      if (++requests === 1) {
        localId = String(outputIn(params, "legacy").output_id);
        assert.ok(localId);
        assert.equal(await f.store.readToolOutput(f.session.id, localId), null);
        return { id: "local-and-other", output_text: "", output: [
          call("other-session-read", "read_tool_output", { session_id: other.id, output_id: localId, max_bytes: 100 }),
          call("default-local-read", "read_tool_output", { output_id: localId, max_bytes: 100 }),
        ], usage };
      }
      assert.equal(outputIn(params, "other-session-read").status, "not_found");
      const local = outputIn(params, "default-local-read");
      assert.equal(local.status, "ok");
      assert.equal(local.output_id, localId);
      assert.match(String(local.content), /LEGACY-BODY/u);
      return answer;
    } } },
    sessionHistory: new SessionHistoryRuntime({ store: f.store, workspacePath: f.workspace, sessionId: () => f.session.id }),
    onHistoryAppend: (items) => f.store.appendContext(f.session.id, items),
    onToolResultAppend: (item, attachment) => f.store.commitToolResult(f.session.id, item, attachment),
  });
  try { await agent.runTurn("recover the inline legacy result"); assert.equal(requests, 2); }
  finally { await agent.dispose(); await fs.rm(f.directory, { recursive: true, force: true }); }
});

test("large output survives compaction and agent reconstruction and is searchable from the same workspace", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-recovery-"));
  const workspace = path.join(directory, "workspace");
  await fs.mkdir(workspace);
  const store = new SessionStore({ directory: path.join(directory, "sessions") });
  const session = await store.create({ title: "build diagnostics", titlePending: false, workspacePath: workspace, model });
  const original = `HEAD-${"中".repeat(18_000)}-MIDDLE-DIAGNOSTIC-${"尾".repeat(10_000)}-TAIL`;
  let requests = 0;
  const first = new ReactAgent({
    workspacePath: workspace,
    model: model.model_name,
    io: { ...io, getSessionId: () => session.id, runBash: async () => ({ stdout: original, stderr: "", exitCode: 0, signal: null }) },
    client: { responses: {
      create: async () => ++requests === 1
        ? { id: "large", output_text: "", output: [call("large", "bash", { command: "fixture" })], usage }
        : answer,
      compact: async () => ({ output: [{ type: "message", role: "developer", content: "Compacted background." }], usage }),
    } },
    sessionHistory: new SessionHistoryRuntime({ store, workspacePath: workspace, sessionId: () => session.id }),
    onHistoryAppend: (items) => store.appendContext(session.id, items),
    onToolResultAppend: (item, attachment) => store.commitToolResult(session.id, item, attachment),
    onContextCompacted: (items, automatic, sample) => store.compactContext(session.id, items, automatic, sample),
  });
  try {
    await first.runTurn("collect diagnostics");
    const before = await store.load(session.id);
    const bounded = before.context.find((item) => item.type === "function_call_output" && item.call_id === "large")!;
    const envelope = JSON.parse(String(bounded.output)) as { output_id: string };
    assert.ok(envelope.output_id);
    await first.compact();
    await first.dispose();
    assert.doesNotMatch(JSON.stringify((await store.load(session.id)).context), /MIDDLE-DIAGNOSTIC/u);

    const restartedStore = new SessionStore({ directory: store.directory });
    const stored = await restartedStore.readToolOutput(session.id, envelope.output_id);
    assert.ok(stored);
    const middleOffset = stored.bytes.indexOf(Buffer.from("MIDDLE-DIAGNOSTIC"));
    assert.ok(middleOffset > 32 * 1024);
    const nextSession = await restartedStore.create({ title: "continue", titlePending: false, workspacePath: workspace, model });
    let resumedRequests = 0;
    const submitted: Array<Record<string, unknown>> = [];
    const second = new ReactAgent({
      workspacePath: workspace,
      model: model.model_name,
      io: { ...io, getSessionId: () => nextSession.id },
      parallelReadTools: true,
      client: { responses: { create: async (params) => {
        submitted.push(params);
        if (++resumedRequests === 1) return { id: "discover", output_text: "", output: [call("discover", "session_search", { query: "MIDDLE-DIAGNOSTIC" })], usage };
        if (resumedRequests === 2) return { id: "recover", output_text: "", output: [
          call("search", "session_event_search", { session_id: session.id, query: "MIDDLE-DIAGNOSTIC" }),
          call("read", "read_tool_output", { session_id: session.id, output_id: envelope.output_id, offset_bytes: middleOffset, max_bytes: 100 }),
        ], usage };
        return answer;
      } } },
      sessionHistory: new SessionHistoryRuntime({ store: restartedStore, workspacePath: workspace, sessionId: () => nextSession.id }),
      onHistoryAppend: (items) => restartedStore.appendContext(nextSession.id, items),
      onToolResultAppend: (item, attachment) => restartedStore.commitToolResult(nextSession.id, item, attachment),
    });
    try {
      await second.runTurn("recover the previous diagnostics");
      const recovered = (await restartedStore.load(nextSession.id)).context;
      for (const id of ["discover", "search", "read"]) {
        const result = recovered.find((item) => item.type === "function_call_output" && item.call_id === id);
        assert.match(String(result?.output), /MIDDLE-DIAGNOSTIC/u);
      }
      assert.match(String(recovered.find((item) => item.call_id === "discover" && item.type === "function_call_output")?.output), new RegExp(session.id));
      const tools = submitted[0]!.tools as Array<{ name: string }>;
      assert.ok(tools.some((tool) => tool.name === "session_event_read"));
      assert.equal((await restartedStore.readToolOutput(session.id, envelope.output_id))?.output_id, envelope.output_id);
    } finally { await second.dispose(); }
  } finally {
    await first.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ordered durable output failure stops later tools and provider requests", async () => {
  let requests = 0;
  let dispatched = 0;
  const agent = new ReactAgent({
    model: "offline",
    io: { ...io, runBash: async () => { dispatched++; return { stdout: "x".repeat(40_000), stderr: "", exitCode: 0, signal: null }; } },
    client: { responses: { create: async () => {
      requests++;
      return { id: "tools", output_text: "", output: [call("first", "bash", { command: "first" }), call("later", "bash", { command: "later" })] };
    } } },
    onToolResultAppend: async () => { throw new Error("disk unavailable"); },
  });
  await assert.rejects(agent.runTurn("work"), (error: unknown) => error instanceof PersistenceError && /disk unavailable/u.test(error.message));
  assert.equal(requests, 1);
  assert.equal(dispatched, 1);
  await agent.dispose();
});

test("prepared output cannot be configured without its ordered persistence callback", async () => {
  const base = { sample: async () => answer, record: async () => {}, dispatch: async () => "", assistant() {} };
  await assert.rejects(runAgentLoop({ ...base, prepareToolOutput: (output, tool) => prepareToolOutput(output, tool.name) }), /both preparation and ordered persistence/u);
  await assert.rejects(runAgentLoop({ ...base, recordToolResult: async () => {} }), /both preparation and ordered persistence/u);
});

test("parallel output attachments commit in model order while bodies count towards backpressure", async () => {
  let release!: () => void;
  let thirdFinished!: () => void;
  const firstGate = new Promise<void>((resolve) => { release = resolve; });
  const threeReady = new Promise<void>((resolve) => { thirdFinished = resolve; });
  const started: string[] = [];
  const committed: string[] = [];
  let samples = 0;
  const running = runAgentLoop({
    sample: async () => ++samples === 1
      ? { output_text: "", output: Array.from({ length: 8 }, (_, i) => call(String(i), "read_file", {})) }
      : { output_text: "done", output: [] },
    record: async () => {},
    assistant() {},
    maxParallelTools: 4,
    toolCapabilities: () => ({ readOnly: true, idempotent: true, parallelSafe: true, resourceKeys: [] }),
    dispatch: async (tool) => {
      started.push(tool.call_id);
      if (tool.call_id === "0") await firstGate;
      if (tool.call_id === "3") thirdFinished();
      return "x".repeat(2 * 1024 * 1024);
    },
    prepareToolOutput: (output, tool) => prepareToolOutput(output, tool.name),
    recordToolResult: async (item, prepared) => {
      assert.ok(prepared.attachment);
      committed.push(String(item.call_id));
    },
  });
  await threeReady;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["0", "1", "2", "3"]);
  assert.deepEqual(committed, []);
  release();
  await running;
  assert.deepEqual(committed, Array.from({ length: 8 }, (_, i) => String(i)));
});

test("history tools are host supplied and remain read only in Plan mode", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const invoked: string[] = [];
  const client: ResponsesClientLike = { responses: { create: async (params) => {
    requests.push(params);
    return requests.length === 1 ? { id: "history", output_text: "", output: [call("lookup", "session_event_search", { query: "previous" })] } : answer;
  } } };
  const agent = new ReactAgent({ model: "offline", io, client, sessionHistory: {
    prepareStep: async () => {},
    call: async (name) => { invoked.push(name); return { status: "ok", historical_data: true, results: [] }; },
    readToolOutput: async () => ({ status: "not_found" }),
  } });
  await agent.runTurn("look up previous work", undefined, { mode: "plan" });
  const tools = requests[0]!.tools as Array<{ name: string }>;
  assert.ok(tools.some((tool) => tool.name === "session_event_search"));
  assert.ok(!tools.some((tool) => tool.name === "bash"));
  assert.deepEqual(invoked, ["session_event_search"]);
  await agent.dispose();
  requests.length = 0;
  const without = new ReactAgent({ model: "offline", io, client });
  await without.runTurn("ordinary question");
  assert.ok(!(requests[0]!.tools as Array<{ name: string }>).some((tool) => tool.name === "session_event_search"));
  await without.dispose();
});
