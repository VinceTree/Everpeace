import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ReactAgent } from "../../../src/agent/react-agent.js";
import type { PreparedOutputAttachment } from "../../../src/agent/context-limits.js";
import type {
  SessionHistoryRuntimeLike,
  ToolResultHistoryCandidate,
  ToolResultHistoryResolution,
} from "../../../src/storage/session-history.js";
import { SessionHistoryRuntime } from "../../../src/storage/session-history.js";
import { SessionStore, type ContextPruneMetadata } from "../../../src/storage/session-store.js";
import { PersistenceError } from "../../../src/storage/persistence-error.js";
import { createProductionWorkflowAgentIO } from "../../../src/runtime/production.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";
import { CodingTaskRunner } from "../../../src/workflow/task-runner.js";

const exec = promisify(execFile);

const LARGE_OUTPUT = `start😀\r\n  ${"diagnostic ".repeat(1_100)}end`;

function oldToolHistory(output = LARGE_OUTPUT, tool = "bash"): Array<Record<string, unknown>> {
  return [
    { role: "user", content: "old request" },
    { type: "function_call", name: tool, call_id: "old-call", arguments: "{}" },
    { type: "function_call_output", call_id: "old-call", output },
    { role: "user", content: "recent one" },
    { type: "message", role: "assistant", content: "recent answer one" },
    { role: "user", content: "recent two" },
    { type: "message", role: "assistant", content: "recent answer two" },
  ];
}

function historyRuntime(
  resolve: (candidates: readonly ToolResultHistoryCandidate[]) => ToolResultHistoryResolution[],
  onPrepare?: () => void,
): SessionHistoryRuntimeLike {
  return {
    async prepareStep() { onPrepare?.(); },
    async call() { return { status: "not_used" }; },
    async readToolOutput() { return { status: "not_used" }; },
    async resolveToolResults(candidates) { return resolve(candidates); },
  };
}

function resolveAll(candidates: readonly ToolResultHistoryCandidate[]): ToolResultHistoryResolution[] {
  return candidates.map((candidate) => ({
    ...candidate,
    session_id: "session-1",
    event_id: `history_${candidate.candidate_id}`,
    at: "2026-10-02T00:00:00.000Z",
  }));
}

const io = {
  async confirmBash() { return false; },
  async runBash() { return { stdout: "", stderr: "", exitCode: 0, signal: null }; },
  writeAssistant() {},
};

test("pressure pruning persists first, shrinks the full request, and avoids a summary call", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const persisted: Array<{ items: readonly Record<string, unknown>[]; original: number; pruned: number }> = [];
  let prepared = 0;
  let compactCalls = 0;
  const agent = new ReactAgent({
    model: "prune-test",
    initialHistory: oldToolHistory(),
    contextWindow: 30_000,
    initialContextTokens: 25_000,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime(resolveAll, () => { prepared += 1; }),
    onContextPruned: async (items, metadata) => {
      assert.equal(prepared, 1, "the history EOF must be frozen before persistence");
      persisted.push({ items, original: metadata.original_bytes, pruned: metadata.pruned_bytes });
    },
    client: { responses: {
      async compact() { compactCalls += 1; return { output: [] }; },
      async create(params) {
        requests.push(params);
        return { id: "done", output_text: "done", output: [] };
      },
    } },
    io,
  });

  await agent.runTurn("current request");
  assert.equal(compactCalls, 0);
  assert.equal(persisted.length, 1);
  assert.ok(persisted[0]!.pruned < persisted[0]!.original);
  const stored = persisted[0]!.items.find((item) => item.call_id === "old-call" && item.type === "function_call_output");
  const envelope = JSON.parse(String(stored?.output)) as Record<string, unknown>;
  assert.equal(envelope.status, "context_pruned");
  assert.match(String(envelope.head), /^start😀\r\n  /u);
  assert.match(String(envelope.tail), /end$/u);
  assert.ok(Buffer.byteLength(String(stored?.output), "utf8") <= 32 * 1_024);
  const reference = envelope.history_reference as Record<string, unknown>;
  assert.equal(reference.tool, "session_event_read");
  assert.equal(reference.session_id, "session-1");
  assert.match(String(reference.event_id), /^history_\d+:2$/u);
  assert.equal(reference.offset_bytes, 0);
  assert.equal(reference.max_bytes, 24 * 1_024);
  assert.equal(reference.at, "2026-10-02T00:00:00.000Z");
  assert.match(JSON.stringify(requests[0]?.input), /context_pruned/u);
  assert.ok(Number(envelope.omitted_codepoints) > 0);
});

test("low pressure and protected history tools leave context byte-for-byte unchanged", async () => {
  let resolveCalls = 0;
  let persisted = false;
  const initial = [
    ...oldToolHistory(LARGE_OUTPUT, "session_event_read"),
    { type: "function_call", name: "memory_lookup", call_id: "memory", arguments: "{}" },
    { type: "function_call_output", call_id: "memory", output: LARGE_OUTPUT },
  ];
  let requestInput: unknown;
  const agent = new ReactAgent({
    model: "low-pressure",
    initialHistory: initial,
    contextWindow: 100_000,
    initialContextTokens: 1,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime((candidates) => { resolveCalls += 1; return resolveAll(candidates); }),
    async onContextPruned() { persisted = true; },
    client: { responses: { async create(params) {
      requestInput = params.input;
      return { id: "done", output_text: "done", output: [] };
    } } },
    io,
  });
  await agent.runTurn("current request");
  assert.equal(resolveCalls, 0);
  assert.equal(persisted, false);
  assert.doesNotMatch(JSON.stringify(requestInput), /context_pruned/u);
  const output = (requestInput as Array<Record<string, unknown>>)
    .find((item) => item.type === "function_call_output" && item.call_id === "old-call")?.output;
  assert.equal(output, LARGE_OUTPUT);
});

test("pressure pruning excludes Memory, history retrieval, read-output, and the latest two complete units", async () => {
  const initial: Array<Record<string, unknown>> = [
    { role: "user", content: "older protected results" },
    { type: "function_call", name: "session_event_search", call_id: "history", arguments: "{}" },
    { type: "function_call_output", call_id: "history", output: LARGE_OUTPUT },
    { type: "function_call", name: "memory_lookup", call_id: "memory", arguments: "{}" },
    { type: "function_call_output", call_id: "memory", output: LARGE_OUTPUT },
    { type: "function_call", name: "read_tool_output", call_id: "read-output", arguments: "{}" },
    { type: "function_call_output", call_id: "read-output", output: LARGE_OUTPUT },
    { role: "user", content: "old ordinary unit" },
    { type: "function_call", name: "bash", call_id: "eligible", arguments: "{}" },
    { type: "function_call_output", call_id: "eligible", output: LARGE_OUTPUT },
    { role: "user", content: "recent ordinary one" },
    { type: "function_call", name: "bash", call_id: "recent-one", arguments: "{}" },
    { type: "function_call", name: "read_file", call_id: "recent-one-sibling", arguments: "{}" },
    { type: "function_call_output", call_id: "recent-one", output: LARGE_OUTPUT },
    { type: "function_call_output", call_id: "recent-one-sibling", output: LARGE_OUTPUT },
    { role: "user", content: "recent ordinary two" },
    { type: "function_call", name: "bash", call_id: "recent-two", arguments: "{}" },
    { type: "function_call", name: "read_file", call_id: "recent-two-sibling", arguments: "{}" },
    { type: "function_call_output", call_id: "recent-two", output: LARGE_OUTPUT },
    { type: "function_call_output", call_id: "recent-two-sibling", output: LARGE_OUTPUT },
  ];
  let candidates: readonly ToolResultHistoryCandidate[] = [];
  let saved: readonly Record<string, unknown>[] = [];
  const agent = new ReactAgent({
    model: "protected-prune",
    initialHistory: initial,
    contextWindow: 60_000,
    initialContextTokens: 50_000,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime((values) => { candidates = values; return resolveAll(values); }),
    async onContextPruned(items) { saved = structuredClone(items); },
    client: { responses: { async create() { return { id: "done", output_text: "done", output: [] }; } } },
    io,
  });
  await agent.runTurn("current request");
  assert.deepEqual(candidates.map((candidate) => candidate.call_id), ["eligible"]);
  const output = (callId: string) => String(saved.find((item) => item.type === "function_call_output" && item.call_id === callId)?.output);
  assert.match(output("eligible"), /context_pruned/u);
  assert.equal(output("history"), LARGE_OUTPUT);
  assert.equal(output("memory"), LARGE_OUTPUT);
  assert.equal(output("read-output"), LARGE_OUTPUT);
  assert.equal(output("recent-one"), LARGE_OUTPUT);
  assert.equal(output("recent-one-sibling"), LARGE_OUTPUT);
  assert.equal(output("recent-two"), LARGE_OUTPUT);
  assert.equal(output("recent-two-sibling"), LARGE_OUTPUT);
});

test("a completed result stays protected while a sibling call in the same parallel chain is open", async () => {
  const initial: Array<Record<string, unknown>> = [
    { role: "user", content: "parallel batch" },
    { type: "function_call", name: "bash", call_id: "completed-sibling", arguments: "{}" },
    { type: "function_call", name: "read_file", call_id: "open-sibling", arguments: "{}" },
    { type: "function_call_output", call_id: "completed-sibling", output: LARGE_OUTPUT },
    { role: "user", content: "recent one" },
    { type: "message", role: "assistant", content: "recent answer one" },
    { role: "user", content: "recent two" },
    { type: "message", role: "assistant", content: "recent answer two" },
  ];
  let resolverCalls = 0;
  let persisted = false;
  let compactCalls = 0;
  const agent = new ReactAgent({
    model: "open-chain-prune",
    initialHistory: initial,
    contextWindow: 30_000,
    initialContextTokens: 25_000,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime((candidates) => {
      resolverCalls += 1;
      return resolveAll(candidates);
    }),
    async onContextPruned() { persisted = true; },
    client: { responses: {
      async compact() {
        compactCalls += 1;
        return { output: [{ type: "compaction", encrypted_content: "opaque" }] };
      },
      async create() { return { id: "done", output_text: "done", output: [] }; },
    } },
    io,
  });
  await agent.runTurn("current request");
  assert.equal(resolverCalls, 0);
  assert.equal(persisted, false);
  assert.equal(compactCalls, 1);
});

test("context-limit recovery prunes once and retries without model compaction when the request is now below pressure", async () => {
  const inputs: unknown[] = [];
  let requests = 0;
  let resolves = 0;
  let compactCalls = 0;
  const agent = new ReactAgent({
    model: "context-recovery-prune",
    initialHistory: oldToolHistory(),
    contextWindow: 30_000,
    initialContextTokens: 1,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime((candidates) => { resolves += 1; return resolveAll(candidates); }),
    async onContextPruned() {},
    client: { responses: {
      async compact() { compactCalls += 1; return { output: [] }; },
      async create(params) {
        inputs.push(params.input);
        requests += 1;
        if (requests === 1) {
          throw Object.assign(new Error("maximum context length"), { status: 400, code: "context_length_exceeded" });
        }
        return { id: "done", output_text: "done", output: [] };
      },
    } },
    io,
  });
  await agent.runTurn("current request");
  assert.equal(requests, 2);
  assert.equal(resolves, 1);
  assert.equal(compactCalls, 0);
  assert.doesNotMatch(JSON.stringify(inputs[0]), /context_pruned/u);
  assert.match(JSON.stringify(inputs[1]), /context_pruned/u);
});

test("missing and ambiguous history resolutions skip pruning and continue through existing compaction", async () => {
  let compactCalls = 0;
  let persisted = false;
  const agent = new ReactAgent({
    model: "ambiguous-prune",
    initialHistory: oldToolHistory(),
    contextWindow: 30_000,
    initialContextTokens: 25_000,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime((candidates) => candidates.flatMap((candidate) => {
      const resolved = resolveAll([candidate])[0]!;
      return [resolved, { ...resolved }];
    })),
    async onContextPruned() { persisted = true; },
    client: { responses: {
      async compact() {
        compactCalls += 1;
        return { output: [{ type: "compaction", encrypted_content: "opaque" }] };
      },
      async create() { return { id: "done", output_text: "done", output: [] }; },
    } },
    io,
  });
  await agent.runTurn("current request");
  assert.equal(persisted, false);
  assert.equal(compactCalls, 1);
});

test("successful pruning still uses normal compaction when the reduced request remains pressured", async () => {
  const order: string[] = [];
  const agent = new ReactAgent({
    model: "prune-then-compact",
    initialHistory: oldToolHistory(),
    contextWindow: 4_000,
    initialContextTokens: 9_000,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime(resolveAll),
    async onContextPruned() { order.push("prune"); },
    async onContextCompacted() { order.push("persist-compact"); },
    client: { responses: {
      async compact() {
        order.push("compact");
        return { output: [{ type: "compaction", encrypted_content: "opaque" }] };
      },
      async create() {
        order.push("create");
        return { id: "done", output_text: "done", output: [] };
      },
    } },
    io,
  });
  await agent.runTurn("current request");
  assert.deepEqual(order, ["prune", "compact", "persist-compact", "create"]);
});

test("pruning persistence failure does not mutate effective context", async () => {
  let persistenceAttempts = 0;
  const seen: unknown[] = [];
  const agent = new ReactAgent({
    model: "prune-persistence",
    initialHistory: oldToolHistory(),
    contextWindow: 30_000,
    initialContextTokens: 25_000,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime(resolveAll),
    async onContextPruned() {
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) throw new Error("disk full");
    },
    client: { responses: { async create(params) {
      seen.push(params.input);
      return { id: "done", output_text: "done", output: [] };
    } } },
    io,
  });
  await assert.rejects(agent.runTurn("first current request"), PersistenceError);
  assert.equal(seen.length, 0);
  await agent.runTurn("second current request");
  assert.equal(persistenceAttempts, 2);
  assert.match(JSON.stringify(seen[0]), /context_pruned/u);
});

test("truncated output recovery fields survive pruning and a pruned envelope is idempotent", async () => {
  const original = JSON.stringify({
    status: "truncated",
    output_id: "retained-output",
    tool_name: "bash",
    total_bytes: 20_000,
    original_bytes: 21_000,
    retained_bytes: 19_000,
    retention_truncated: true,
    continuation: { tool: "read_tool_output", offset_bytes: 0 },
    head: `😀\r\n${"x".repeat(9_000)}`,
    tail: "tail",
  });
  let saved: readonly Record<string, unknown>[] = [];
  const first = new ReactAgent({
    model: "envelope-prune",
    initialHistory: oldToolHistory(original),
    contextWindow: 30_000,
    initialContextTokens: 25_000,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime(resolveAll),
    async onContextPruned(items) { saved = structuredClone(items); },
    client: { responses: { async create() { return { id: "done", output_text: "done", output: [] }; } } },
    io,
  });
  await first.runTurn("current request");
  const output = String(saved.find((item) => item.type === "function_call_output" && item.call_id === "old-call")?.output);
  const parsed = JSON.parse(output) as Record<string, unknown>;
  assert.equal(parsed.output_id, "retained-output");
  assert.equal(parsed.retention_truncated, true);
  assert.deepEqual(parsed.continuation, { tool: "read_tool_output", offset_bytes: 0 });

  let resolves = 0;
  const second = new ReactAgent({
    model: "idempotent-prune",
    initialHistory: saved,
    contextWindow: 30_000,
    initialContextTokens: 25_000,
    requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
    sessionHistory: historyRuntime((candidates) => { resolves += 1; return resolveAll(candidates); }),
    async onContextPruned() { throw new Error("a pruned envelope must not be pruned again"); },
    client: { responses: {
      async compact() { return { output: [{ type: "compaction", encrypted_content: "opaque" }] }; },
      async create() { return { id: "done", output_text: "done", output: [] }; },
    } },
    io,
  });
  await second.runTurn("another request");
  assert.equal(resolves, 0);
});

test("pruned context survives restart while the omitted diagnostic remains retrievable from original history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-prune-recovery-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "prune-recovery-fixture",
    scripts: {
      typecheck: "offline fixture",
      test: "offline fixture",
    },
  }), "utf8");
  await exec("git", ["init", "--quiet"], { cwd: workspace });
  await exec("git", ["config", "user.email", "prune@example.invalid"], { cwd: workspace });
  await exec("git", ["config", "user.name", "Prune Fixture"], { cwd: workspace });
  await exec("git", ["add", "package.json"], { cwd: workspace });
  await exec("git", ["commit", "--quiet", "-m", "fixture"], { cwd: workspace });
  const store = new SessionStore({ directory: path.join(root, "sessions"), createId: () => "prune-restart" });
  const session = await store.create({
    title: "prune recovery",
    titlePending: false,
    workspacePath: workspace,
    model: { id: "test", model_name: "test", base_url: "https://example.invalid/v1" },
  });
  const diagnostic = `${"A".repeat(5_500)}UNIQUE_MIDDLE_DIAGNOSTIC${"B".repeat(5_500)}`;
  const initial = oldToolHistory(diagnostic);
  await store.appendContext(session.id, initial);
  const runtime = () => new SessionHistoryRuntime({ store, workspacePath: workspace, sessionId: () => session.id });
  const callbacks = {
    onHistoryAppend: (items: readonly Record<string, unknown>[]) => store.appendContext(session.id, items),
    onToolResultAppend: (item: Record<string, unknown>, attachment?: PreparedOutputAttachment) => store.commitToolResult(session.id, item, attachment),
    onContextPruned: (items: readonly Record<string, unknown>[], metadata: ContextPruneMetadata) => store.pruneContext(session.id, items, metadata),
  };
  try {
    const first = new ReactAgent({
      workspacePath: workspace,
      model: "prune-restart",
      initialHistory: initial,
      contextWindow: 30_000,
      initialContextTokens: 25_000,
      requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
      sessionHistory: runtime(),
      ...callbacks,
      client: { responses: { async create() { return { id: "first", output_text: "checkpoint", output: [] }; } } },
      io: { ...io, getSessionId: () => session.id },
    });
    await first.runTurn("checkpoint before restart");
    await first.dispose();

    const loaded = await new SessionStore({ directory: path.join(root, "sessions") }).load(session.id);
    const persistedOutput = String(loaded.context.find((item) => item.type === "function_call_output" && item.call_id === "old-call")?.output);
    assert.match(persistedOutput, /context_pruned/u);
    assert.doesNotMatch(persistedOutput, /UNIQUE_MIDDLE_DIAGNOSTIC/u);

    const directHistory = runtime();
    await directHistory.prepareStep();
    const found = await directHistory.call("session_event_search", JSON.stringify({ query: "UNIQUE_MIDDLE_DIAGNOSTIC" }));
    assert.equal(found.status, "ok");
    assert.equal((found.matches as unknown[]).length, 1);

    let requests = 0;
    let verificationRuns = 0;
    const workflow = new CodingWorkflowRuntime({
      workspacePath: workspace,
      onState: (state) => store.setWorkflow(session.id, state),
    });
    const executeVerification = async () => {
      verificationRuns += 1;
      const content = await fs.readFile(path.join(workspace, "fixed.txt"), "utf8").catch(() => "");
      return content === "fixed from UNIQUE_MIDDLE_DIAGNOSTIC\n"
        ? { stdout: "offline verification passed", stderr: "", exitCode: 0, signal: null }
        : { stdout: "", stderr: "diagnostic was not applied", exitCode: 1, signal: null };
    };
    const agentIo = createProductionWorkflowAgentIO({
      workspacePath: workspace,
      policy: () => ({ mode: "workspace-write", web: false }),
      workflow,
      execute: executeVerification,
      executeVerification,
      session: { getId: () => session.id },
    });
    const second = new ReactAgent({
      workspacePath: workspace,
      model: "prune-restart",
      initialHistory: loaded.context,
      contextWindow: 100_000,
      initialContextTokens: 1,
      requestSettings: { reasoningEffort: "off", maxOutputTokens: 1_000 },
      sessionHistory: runtime(),
      ...callbacks,
      client: { responses: { async create(params) {
        requests += 1;
        if (requests === 1) return {
          id: "search",
          output_text: "",
          output: [{
            type: "function_call",
            name: "session_event_search",
            call_id: "history-search",
            arguments: JSON.stringify({ query: "UNIQUE_MIDDLE_DIAGNOSTIC" }),
          }],
        };
        if (requests === 2) {
          assert.match(JSON.stringify(params.input), /UNIQUE_MIDDLE_DIAGNOSTIC/u);
          return {
            id: "repair",
            output_text: "",
            output: [{
              type: "function_call",
              name: "apply_patch",
              call_id: "apply-recovered-diagnostic",
              arguments: JSON.stringify({
                operations: [{
                  path: "fixed.txt",
                  action: "create",
                  content: "fixed from UNIQUE_MIDDLE_DIAGNOSTIC\n",
                }],
              }),
            }],
          };
        }
        assert.match(JSON.stringify(params.input), /offline verification passed/u);
        return { id: "recovered", output_text: "recovered diagnostic", output: [] };
      } } },
      io: agentIo,
    });
    const runner = new CodingTaskRunner({
      agent: second,
      workflow,
      host: {
        executeVerification,
        async getGoal() { return undefined; },
        async addGoalTime() { return undefined; },
      },
    });
    const result = await runner.run({ text: "recover and repair the omitted diagnosis", source: "session_resume" });
    await second.dispose();
    assert.equal(requests, 3);
    assert.ok(verificationRuns >= 3);
    assert.equal(result.workflowResult?.state.result, "verified");
    assert.equal(await fs.readFile(path.join(workspace, "fixed.txt"), "utf8"), "fixed from UNIQUE_MIDDLE_DIAGNOSTIC\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
