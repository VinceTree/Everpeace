import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkpointText } from "../../fixtures/conversation-checkpoint.js";
import {
  ReactAgent,
  type AgentIO,
  type ResponsesClientLike,
} from "../../../src/agent/react-agent.js";
import type { BashResult } from "../../../src/tools/bash.js";
import type { PermissionPolicy } from "../../../src/permissions/policy.js";
import { GoalRuntime } from "../../../src/goal/runtime.js";
import type { SessionGoal } from "../../../src/storage/session-store.js";
import { resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import { previewApplyPatch, runApplyPatch } from "../../../src/tools/apply-patch.js";
import { RequestAttemptLedger } from "../../../src/agent/request-attempt-ledger.js";
import { PersistenceError } from "../../../src/storage/persistence-error.js";
import type { TaskProgress } from "../../../src/workflow/task-progress.js";

function bashResult(stdout: string): BashResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

test("agent defers goal completion until the host accepts workflow verification", async () => {
  let goal: SessionGoal | undefined;
  const goalRuntime = new GoalRuntime({
    getGoal: async () => goal,
    setGoal: async (next) => { goal = next; },
  });
  await goalRuntime.create({ objective: "finish the change" });
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    { id: "complete", output_text: "", output: [{ type: "function_call", name: "update_goal", arguments: '{"status":"complete"}', call_id: "goal-complete" }] },
    { id: "done", output_text: "done", output: [] },
  ];
  const agent = new ReactAgent({
    model: "test",
    goalRuntime,
    client: { responses: { async create(params) { requests.push(params); return responses.shift()!; } } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  const result = await agent.runTurn("finish");
  assert.equal(result.goalCompletionRequested, true);
  assert.equal(goal?.status, "active");
  assert.match(JSON.stringify(requests[1]?.input), /pending_verification/u);
  await agent.finalizePendingGoalCompletion(false);
  assert.equal(goal?.status, "active");
  await agent.finalizePendingGoalCompletion(true);
  assert.equal(goal?.status, "active");

  responses.push(
    { id: "complete-again", output_text: "", output: [{ type: "function_call", name: "update_goal", arguments: '{"status":"complete"}', call_id: "goal-complete-again" }] },
    { id: "done-again", output_text: "done", output: [] },
  );
  await agent.runTurn("finish after verification");
  await agent.finalizePendingGoalCompletion(true);
  assert.equal(goal?.status, "complete");
});

test("agent rejects overlapping turns and releases the guard after cancellation", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const agent = new ReactAgent({ model: "test", client: { responses: { async create(_params, options) {
    if (!options?.signal) return { id: "done", output: [], output_text: "done" };
    started();
    await new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    return { id: "never", output: [], output_text: "" };
  } } }, io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} } });
  const first = agent.runTurn("first", controller.signal);
  await ready;
  await assert.rejects(agent.runTurn("overlap"), /already running/);
  controller.abort();
  await assert.rejects(first, /abort/i);
  await agent.runTurn("next");
});

test("an explicit step limit is shared by every repair turn in one host task", async () => {
  let requests = 0;
  const agent = new ReactAgent({
    model: "task-step-budget",
    maxSteps: 3,
    client: { responses: { async create() {
      requests += 1;
      if (requests === 1 || requests === 3) {
        return {
          id: `tool-${requests}`,
          output_text: "",
          output: [{ type: "function_call", name: "bash", call_id: `bash-${requests}`, arguments: '{"command":"check"}' }],
        };
      }
      if (requests === 2) return { id: "first-done", output_text: "first done", output: [] };
      throw new Error("The task-wide step budget allowed an extra provider request");
    } } },
    io: {
      getPermissions: () => ({ mode: "full-access", web: false }),
      async confirmBash() { return true; },
      async runBash() { return bashResult("ok"); },
      writeAssistant() {},
    },
  });
  await agent.beginTask({ mode: "default", source: "user" });
  try {
    const first = await agent.runTurn("initial work");
    assert.equal(first.stopReason, undefined);
    const repair = await agent.runTurn("repair after verification");
    assert.equal(repair.stopReason, "step_limit");
    assert.equal(requests, 3);
  } finally {
    agent.endTask();
  }
});

test("background commands inherit cancellation while the agent is sampling", async () => {
  const controller = new AbortController();
  let requests = 0;
  let backgroundSignal: AbortSignal | undefined;
  let samplingStarted!: () => void;
  const sampling = new Promise<void>((resolve) => { samplingStarted = resolve; });
  const agent = new ReactAgent({
    model: "background-cancellation-test",
    client: {
      responses: {
        async create(_params, options) {
          requests += 1;
          if (requests === 1) {
            return {
              id: "start-background",
              output_text: "",
              output: [{
                type: "function_call",
                name: "start_background",
                call_id: "background-1",
                arguments: JSON.stringify({ command: "long-running" }),
              }],
            };
          }
          samplingStarted();
          await new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
          return { id: "unreachable", output_text: "", output: [] };
        },
      },
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      async runBackgroundBash(_command, signal) {
        backgroundSignal = signal;
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
        return bashResult("");
      },
      writeAssistant() {},
    },
  });

  const running = agent.runTurn("start work", controller.signal);
  await sampling;
  controller.abort(new Error("cancel task"));
  await assert.rejects(running, /cancel task/);
  assert.equal(backgroundSignal?.aborted, true);
});

test("agent exposes apply_patch and persists its structured result before continuing", async () => {
  const history: Array<Record<string, unknown>> = [];
  let patchCalls = 0;
  const agent = new ReactAgent({
    model: "test",
    client: {
      responses: {
        async create(params) {
          const input = params.input as Array<Record<string, unknown>>;
          history.push(...input.slice(-2));
          if (patchCalls++ === 0) {
            const tools = params.tools as Array<Record<string, unknown>>;
            assert.ok(tools.some((tool) => tool.name === "apply_patch"));
            return { id: "patch", output_text: "", output: [{ type: "function_call", name: "apply_patch", call_id: "patch-1", arguments: JSON.stringify({ operations: [{ path: "file.txt", action: "create", content: "done\n" }] }) }] };
          }
          assert.ok(input.some((item) => item.type === "function_call_output" && String(item.output).includes('"status":"applied"')));
          assert.ok(input.some((item) => item.type === "function_call_output" && String(item.output).includes('"verification_prompt":"verify now"')));
          return { id: "done", output_text: "verified", output: [] };
        },
      },
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      async runApplyPatch() { return { status: "applied", files: [{ path: "file.txt", action: "create", status: "applied" }], diffSummary: "create file.txt" }; },
      async afterPatchApplied() { return { prompt: "verify now" }; },
      writeAssistant() {},
    },
    onHistoryAppend: async (items) => { history.push(...items); },
  });
  await agent.runTurn("create file.txt");
  assert.ok(history.some((item) => item.type === "function_call" && item.name === "apply_patch"));
  assert.ok(history.some((item) => item.type === "function_call_output" && item.call_id === "patch-1"));
});

test("host file observations reject blind updates and bind the observed version", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-observation-"));
  try {
    await fs.writeFile(path.join(workspace, "file.txt"), "before\n", "utf8");
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      { id: "blind", output_text: "", output: [{ type: "function_call", name: "apply_patch", call_id: "p1", arguments: JSON.stringify({ operations: [{ path: "file.txt", action: "update", content: "blind\n" }] }) }] },
      { id: "read", output_text: "", output: [{ type: "function_call", name: "read_file", call_id: "r1", arguments: JSON.stringify({ path: "file.txt" }) }] },
      { id: "guarded", output_text: "", output: [{ type: "function_call", name: "apply_patch", call_id: "p2", arguments: JSON.stringify({ operations: [{ path: "file.txt", action: "update", content: "after\n" }] }) }] },
      { id: "done", output_text: "done", output: [] },
    ];
    let appliedOperations: readonly import("../../../src/tools/apply-patch.js").ApplyPatchOperation[] = [];
    const agent = new ReactAgent({
      workspacePath: workspace,
      model: "test",
      client: { responses: { async create(params) { requests.push(params); return responses.shift()!; } } },
      io: {
        async confirmBash() { return true; },
        async runBash() { return bashResult(""); },
        previewPatch: (operations) => previewApplyPatch(operations, workspace),
        async runApplyPatch(operations) { appliedOperations = operations; return runApplyPatch(operations, workspace); },
        writeAssistant() {},
      },
    });
    await agent.runTurn("update file");
    assert.match(JSON.stringify(requests[1]?.input), /has not been observed/u);
    assert.match(JSON.stringify(requests[1]?.input), /FILE_NOT_OBSERVED/u);
    assert.match(appliedOperations[0]?.expectedSha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "after\n");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a file changed during patch approval is never overwritten", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-approval-race-"));
  try {
    await fs.writeFile(path.join(workspace, "file.txt"), "before\n", "utf8");
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      { id: "read", output_text: "", output: [{ type: "function_call", name: "read_file", call_id: "r1", arguments: '{"path":"file.txt"}' }] },
      { id: "patch", output_text: "", output: [{ type: "function_call", name: "apply_patch", call_id: "p1", arguments: JSON.stringify({ operations: [{ path: "file.txt", action: "update", content: "model\n" }] }) }] },
      { id: "done", output_text: "done", output: [] },
    ];
    const agent = new ReactAgent({
      workspacePath: workspace,
      model: "test",
      client: { responses: { async create(params) { requests.push(params); return responses.shift()!; } } },
      io: {
        getPermissions() { return { mode: "ask", web: false, shellNetwork: "deny", commandRules: [] }; },
        async confirmBash() { return false; },
        async confirmPatch() { await fs.writeFile(path.join(workspace, "file.txt"), "user edit\n", "utf8"); return true; },
        async runBash() { return bashResult(""); },
        previewPatch: (operations) => previewApplyPatch(operations, workspace),
        runApplyPatch: (operations) => runApplyPatch(operations, workspace),
        writeAssistant() {},
      },
    });
    await agent.runTurn("update file");
    assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "user edit\n");
    assert.match(JSON.stringify(requests[2]?.input), /changed since it was read|changed after the patch was prepared/u);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("agent uses the native compaction output as the next context window", async () => {
  const createInputs: Array<Array<Record<string, unknown>>> = [];
  let compactInput: Array<Record<string, unknown>> | undefined;
  let saved: Array<Record<string, unknown>> = [];
  const compacted = [
    { type: "message", role: "user", content: "retained" },
    { type: "compaction", encrypted_content: "opaque" },
  ];
  const agent = new ReactAgent({
    model: "test",
    initialHistory: [{ role: "user", content: "old context" }],
    client: {
      responses: {
        async compact(params) {
          compactInput = params.input as Array<Record<string, unknown>>;
          return {
            output: compacted,
            usage: { input_tokens: 90, output_tokens: 10, total_tokens: 100 },
          };
        },
        async create(params) {
          createInputs.push(params.input as Array<Record<string, unknown>>);
          return { id: "done", output_text: "finished", output: [] };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
    async onContextCompacted(items, automatic, usage) {
      assert.equal(automatic, false);
      assert.deepEqual(items, compacted);
      assert.deepEqual(usage, { input_tokens: 90, output_tokens: 10, total_tokens: 100 });
      saved = items.map((item) => ({ ...item }));
    },
  });

  const result = await agent.compact();
  assert.deepEqual(result.items, compacted);
  assert.deepEqual(compactInput, [{ role: "user", content: "old context" }]);
  await agent.runTurn("next question");
  assert.deepEqual(saved, compacted);
  assert.ok(createInputs[0]?.some((item) => item.type === "compaction"));
  assert.ok(createInputs[0]?.some((item) => item.role === "user" && item.content === "next question"));
  assert.ok(!createInputs[0]?.some((item) => item.content === "old context"));
});

test("native compaction keeps the restored task checklist in the next request", async () => {
  let request: Record<string, unknown> | undefined;
  const progress: TaskProgress = {
    plan: [{ step: "Finish the retained task", status: "in_progress" }],
    updated_at: "2026-10-01T00:00:00.000Z",
  };
  const agent = new ReactAgent({
    model: "progress-compaction-test",
    initialHistory: [{ role: "user", content: "context before compaction" }],
    initialTaskProgress: progress,
    client: { responses: {
      async compact() { return { output: [{ type: "compaction", encrypted_content: "opaque" }] }; },
      async create(params) { request = params; return { id: "done", output_text: "done", output: [] }; },
    } },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      async setTaskProgress() {},
      writeAssistant() {},
    },
  });
  await agent.beginTask({ mode: "default", source: "session_resume" });
  await agent.compact();
  await agent.runTurn("continue");
  agent.endTask();
  assert.match(JSON.stringify(request), /Current task checklist/u);
  assert.match(JSON.stringify(request), /Finish the retained task/u);
  assert.doesNotMatch(JSON.stringify(request), /context before compaction/u);
});

test("DeepSeek summary compaction keeps the latest two interaction units", async () => {
  let request: Record<string, unknown> | undefined;
  const agent = new ReactAgent({
    model: "deepseek-flash",
    providerCapabilities: resolveProviderCapabilities("https://api.deepseek.com"),
    initialHistory: [
      { role: "user", content: `old request ${"requirement ".repeat(100)}` },
      { type: "message", role: "assistant", content: `old answer ${"evidence ".repeat(100)}` },
      { role: "user", content: "recent one" },
      { type: "message", role: "assistant", content: "recent answer" },
      { role: "user", content: "recent two" },
    ],
    client: { responses: { async create(params) {
      request = params;
      return {
        id: "summary",
        output_text: checkpointText("Old requirement", "Earlier command evidence"),
        output: [],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      };
    } } },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  const result = await agent.compact();
  assert.equal(request?.max_output_tokens, 8_192);
  assert.deepEqual(request?.reasoning, { effort: "none" });
  assert.equal(result.items[0]?.role, "assistant");
  assert.equal(typeof result.items[0]?.content, "string");
  assert.match(String(result.items[0]?.content), /Model-generated conversation checkpoint/u);
  assert.ok(result.items.some((item) => item.content === "recent one"));
  assert.ok(result.items.some((item) => item.content === "recent two"));
  assert.ok(!result.items.some((item) => item.content === "old request"));
});

test("DeepSeek summary compaction can shorten one user task with several tool interactions", async () => {
  const oldOutput = JSON.stringify({ content: "diagnostic ".repeat(400) });
  const agent = new ReactAgent({
    model: "deepseek-flash",
    providerCapabilities: resolveProviderCapabilities("https://api.deepseek.com"),
    initialHistory: [
      { role: "user", content: "fix this one task" },
      { type: "function_call", name: "bash", call_id: "one", arguments: '{"command":"test"}' },
      { type: "function_call_output", call_id: "one", output: oldOutput },
      { type: "message", role: "assistant", content: "first diagnosis" },
      { type: "function_call", name: "read_file", call_id: "two", arguments: '{"path":"src/a.ts"}' },
      { type: "function_call_output", call_id: "two", output: oldOutput },
      { type: "message", role: "assistant", content: "second diagnosis" },
      { type: "function_call", name: "bash", call_id: "three", arguments: '{"command":"test again"}' },
      { type: "function_call_output", call_id: "three", output: "failed" },
      { type: "message", role: "assistant", content: "latest diagnosis" },
    ],
    client: { responses: { async create() {
      return { id: "summary", status: "completed", output_text: checkpointText("Fix this one task", "The first diagnostic failed."), output: [] };
    } } },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  const result = await agent.compact();
  assert.ok(result.items.some((item) => item.content === "second diagnosis"));
  assert.ok(result.items.some((item) => item.content === "latest diagnosis"));
  assert.ok(!result.items.some((item) => item.call_id === "one"));
});

test("summary compaction rejects non-terminal output without replacing persisted context", async () => {
  let persisted = false;
  const agent = new ReactAgent({
    model: "deepseek-flash",
    providerCapabilities: resolveProviderCapabilities("https://api.deepseek.com"),
    initialHistory: [
      { role: "user", content: `old ${"context ".repeat(300)}` },
      { type: "message", role: "assistant", content: "old answer" },
      { role: "user", content: "middle" },
      { type: "message", role: "assistant", content: "middle answer" },
      { role: "user", content: "latest" },
    ],
    client: { responses: { async create() {
      return { id: "summary", status: "incomplete", output_text: "partial but nonempty", output: [] };
    } } },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
    async onContextCompacted() { persisted = true; },
  });
  await assert.rejects(agent.compact(), /incomplete/u);
  assert.equal(persisted, false);
});

test("automatic compaction runs at the known context threshold before sampling", async () => {
  const calls: string[] = [];
  const inputs: Array<Array<Record<string, unknown>>> = [];
  const agent = new ReactAgent({
    model: "test",
    contextWindow: 100,
    client: {
      responses: {
        async compact(params) {
          calls.push("compact");
          assert.ok((params.input as Array<Record<string, unknown>>).some((item) => item.content === "second"));
          return {
            output: [{ type: "compaction", encrypted_content: "opaque" }],
            usage: { input_tokens: 70, output_tokens: 5, total_tokens: 75 },
          };
        },
        async create(params) {
          calls.push("create");
          inputs.push(params.input as Array<Record<string, unknown>>);
          if (calls.filter((call) => call === "create").length === 1) {
            return {
              id: "first",
              output_text: "first answer",
              output: [],
              usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
            };
          }
          return { id: "second", output_text: "second answer", output: [] };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });

  await agent.runTurn("first");
  await agent.runTurn("second");
  assert.deepEqual(calls, ["create", "compact", "create"]);
  assert.equal(inputs[1]?.[0]?.type, "compaction");
});

test("compaction failures do not enter the ordinary sampling retry loop", async () => {
  let compactCalls = 0;
  let createCalls = 0;
  const agent = new ReactAgent({
    model: "test",
    contextWindow: 100,
    client: {
      responses: {
        async compact() {
          compactCalls += 1;
          const error = new Error("compact unavailable") as Error & { status?: number };
          error.status = 500;
          throw error;
        },
        async create() {
          createCalls += 1;
          return {
            id: `response-${createCalls}`,
            output_text: "done",
            output: [],
            usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
          };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("first");
  await assert.rejects(agent.runTurn("second"), /compact unavailable/);
  assert.equal(compactCalls, 1);
  assert.equal(createCalls, 1);
});

test("resumed missing outputs and thrown tool executors cannot poison subsequent requests", async () => {
  let requests = 0;
  const persisted: Record<string, unknown>[] = [];
  const agent = new ReactAgent({
    model: "test",
    initialHistory: [{ type: "function_call", call_id: "old", name: "bash", arguments: "{}" }],
    client: { responses: { async create(params) {
      const input = params.input as Record<string, unknown>[];
      assert.ok(input.some((item) => item.type === "function_call_output" && item.call_id === "old"));
      if (++requests === 1) return { id: "tool", output_text: "", output: [{ type: "function_call", name: "bash", call_id: "new", arguments: '{"command":"pwd"}' }] };
      assert.ok(input.some((item) => item.call_id === "new" && String(item.output).includes("executor failed")));
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: { async confirmBash() { return true; }, async runBash() { throw new Error("executor failed"); }, writeAssistant() {} },
    async onHistoryAppend(items) { persisted.push(...items); },
  });
  await agent.runTurn("continue");
  await agent.runTurn("again");
  assert.equal(requests, 3);
  assert.ok(persisted.some((item) => item.type === "function_call_output" && item.call_id === "new"));
});

test("cancellation closes pending function calls and the next turn remains usable", async () => {
  const controller = new AbortController();
  let requests = 0;
  const batches: Array<readonly Record<string, unknown>[]> = [];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests++;
      if (requests === 1) return { id: "tool", output_text: "", output: [
        { type: "function_call", name: "bash", call_id: "cancel-1", arguments: '{"command":"sleep 60"}' },
        { type: "function_call", name: "bash", call_id: "cancel-2", arguments: '{"command":"echo never"}' },
      ] };
      const history = params.input as Array<Record<string, unknown>>;
      const results = history.filter((entry) => entry.type === "function_call_output");
      assert.equal(results.length, 2);
      assert.ok(results.every((entry) => String(entry.output).includes("cancelled")));
      return { id: "done", output_text: "ready", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash(_command, signal) {
        assert.ok(signal);
        assert.equal(signal.aborted, false);
        controller.abort(new Error("aborted by test"));
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return { ...bashResult("partial"), cancelled: true };
      },
      writeAssistant() {},
    },
    async onHistoryAppend(items) { batches.push(items); },
  });
  await assert.rejects(agent.runTurn("run", controller.signal), /abort/i);
  assert.equal(requests, 1);
  assert.equal(batches.flat().filter((item) => item.type === "function_call_output").length, 2);
  await agent.runTurn("continue");
  assert.equal(requests, 2);
});

test("permissions are checked at execution time and changing policy retains agent context", async () => {
  let policy: PermissionPolicy = { mode: "read-only", web: false };
  let ran = 0;
  let requests = 0;
  const outputs: string[] = [];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests++;
      if (requests % 2 === 1) return { id: "tool", output_text: "", output: [
        { type: "function_call", name: "bash", arguments: '{"command":"pwd"}', call_id: `bash-${requests}` },
        { type: "function_call", name: "web_search", arguments: '{"query":"test"}', call_id: `web-${requests}` },
      ] };
      const history = params.input as Array<Record<string, unknown>>;
      outputs.push(...history.filter((item) => item.type === "function_call_output").map((item) => String(item.output)));
      if (requests === 4) assert.equal(history.filter((item) => item.role === "user").length, 2);
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      getPermissions: () => policy,
      async confirmBash() { return false; },
      async confirmWeb() { return false; },
      async runBash() { ran++; return bashResult("ok"); },
      writeAssistant() {},
    },
    web: { async search() { throw new Error("Must not search"); }, async fetch() { throw new Error("Must not fetch"); } },
  });
  await agent.runTurn("inspect");
  assert.equal(ran, 0);
  assert.ok(outputs.every((output) => output.includes("denied") || output.includes("rejected")));
  policy = { mode: "full-access", web: false };
  await agent.runTurn("continue");
  assert.equal(ran, 1);
});

test("agent returns a final answer without running Bash", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const messages: string[] = [];
  const timings: string[] = [];
  const client: ResponsesClientLike = {
    responses: {
      async create(params) {
        requests.push(params);
        return { id: "response-1", output_text: "Hello", output: [] };
      },
    },
  };
  const io: AgentIO = {
    async confirmBash() {
      throw new Error("Bash should not be requested");
    },
    async runBash() {
      throw new Error("Bash should not run");
    },
    writeAssistant(text) {
      messages.push(text);
    },
  };

  await new ReactAgent({
    client,
    model: "deepseek-flash",
    io,
    onEvent(event) { if (event.type === "timing_recorded") timings.push(event.operation); },
  }).runTurn("hi");

  assert.deepEqual(messages, ["Hello"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.model, "deepseek-flash");
  assert.equal(requests[0]?.store, false);
  assert.deepEqual(requests[0]?.include, ["reasoning.encrypted_content"]);
  assert.ok(timings.includes("rendering"));
});

test("plan mode exposes only read-only and planning tools", async () => {
  let request: Record<string, unknown> | undefined;
  let mcpPreparations = 0;
  const agent = new ReactAgent({
    client: { responses: { async create(params) { request = params; return { id: "plan", output_text: "planned", output: [] }; } } },
    model: "test",
    io: { async confirmBash() { throw new Error("not allowed"); }, async runBash() { throw new Error("not allowed"); }, writeAssistant() {} },
    mcp: {
      async ensureReady() {
        mcpPreparations += 1;
        return {
          tools: [{ type: "function", name: "mcp__private__mutate", description: "mutate", parameters: { type: "object" } }],
          instructions: "MCP instructions must not enter Plan mode.",
          servers: [],
        };
      },
      toolInfo(name) { return { callableName: name, serverName: "private", toolName: "mutate" }; },
      async call() { throw new Error("MCP must not run in Plan mode"); },
    },
    questionInteraction: { async requestInput() { return {}; } },
    planInteraction: { async requestInput() { return {}; }, async reviewPlan() { return "continue"; } },
  });
  await agent.runTurn("make a plan", undefined, { mode: "plan" });
  const names = (request?.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("request_user_input"));
  assert.ok(names.includes("submit_plan"));
  assert.ok(!names.includes("bash"));
  assert.ok(!names.includes("get_goal"));
  assert.ok(!names.includes("mcp__private__mutate"));
  assert.doesNotMatch(String(request?.instructions), /MCP instructions must not enter Plan mode/u);
  assert.equal(mcpPreparations, 0);
});

test("plan questions use the shared interaction and persist answers before follow-up", async () => {
  let requests = 0;
  const modes: string[] = [];
  const agent = new ReactAgent({
    model: "plan-question-test",
    client: { responses: { async create(params) {
      requests += 1;
      if (requests === 1) return {
        id: "question",
        output_text: "",
        output: [{ type: "function_call", name: "request_user_input", call_id: "plan-question", arguments: JSON.stringify({ questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "Keep it small" }, { label: "Large", description: "Cover everything" }] }] }) }],
      };
      assert.match(JSON.stringify(params.input), /Small/u);
      return { id: "done", output_text: "planned", output: [] };
    } } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
    planInteraction: {
      async requestInput(_request, _signal, mode) { modes.push(mode ?? "missing"); return { scope: "Small" }; },
      async reviewPlan() { return "continue"; },
    },
  });
  await agent.runTurn("plan", undefined, { mode: "plan" });
  assert.equal(requests, 2);
  assert.deepEqual(modes, ["plan"]);
});

test("coding mode advertises structured questions only when the host can answer them", async () => {
  const advertised: string[][] = [];
  const makeAgent = (interactive: boolean) => new ReactAgent({
    client: { responses: { async create(params) {
      advertised.push((params.tools as Array<{ name: string }>).map((tool) => tool.name));
      return { id: "done", output_text: "done", output: [] };
    } } },
    model: "test",
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
    ...(interactive ? { questionInteraction: { async requestInput() { return {}; } } } : {}),
  });
  await makeAgent(false).runTurn("without interaction");
  await makeAgent(true).runTurn("with interaction");
  assert.equal(advertised[0]?.includes("request_user_input"), false);
  assert.equal(advertised[1]?.includes("request_user_input"), true);
  assert.equal(advertised[1]?.includes("submit_plan"), false);
});

test("coding questions persist their answer before later calls and sampling continue", async () => {
  const history: Array<Record<string, unknown>> = [];
  const modes: string[] = [];
  let requests = 0;
  let bashCalls = 0;
  const agent = new ReactAgent({
    model: "questions-test",
    client: { responses: { async create(params) {
      requests += 1;
      if (requests === 1) return {
        id: "questions",
        output_text: "",
        output: [
          { type: "function_call", name: "request_user_input", call_id: "question-1", arguments: JSON.stringify({ questions: [{ id: "choice", header: "Choice", question: "Which path?", options: [{ label: "Safe", description: "Use the safe path" }, { label: "Fast", description: "Use the fast path" }] }] }) },
          { type: "function_call", name: "bash", call_id: "bash-1", arguments: JSON.stringify({ command: "echo done" }) },
        ],
      };
      const input = params.input as Array<Record<string, unknown>>;
      const outputs = input.filter((item) => item.type === "function_call_output");
      assert.equal(outputs.length, 2);
      assert.match(String(outputs[0]?.output), /Safe/u);
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { bashCalls += 1; return bashResult("done"); },
      writeAssistant() {},
    },
    questionInteraction: {
      async requestInput(_request, _signal, mode) {
        modes.push(mode ?? "missing");
        return { choice: "Safe" };
      },
    },
    onHistoryAppend: async (items) => { history.push(...items); },
  });
  await agent.runTurn("implement");
  assert.deepEqual(modes, ["default"]);
  assert.equal(bashCalls, 1);
  assert.ok(history.some((item) => item.type === "function_call_output" && item.call_id === "question-1"));
});

test("a late coding-question answer cannot outlive task cancellation or run later calls", async () => {
  const controller = new AbortController();
  let resolveQuestion!: (answers: Record<string, string>) => void;
  let questionStarted!: () => void;
  const started = new Promise<void>((resolve) => { questionStarted = resolve; });
  let bashCalls = 0;
  let requests = 0;
  const agent = new ReactAgent({
    model: "late-question-test",
    client: { responses: { async create() {
      requests += 1;
      return {
        id: "questions",
        output_text: "",
        output: [
          { type: "function_call", name: "request_user_input", call_id: "question-1", arguments: JSON.stringify({ questions: [{ id: "choice", header: "Choice", question: "Which path?", options: [{ label: "Safe", description: "Use safe" }, { label: "Fast", description: "Use fast" }] }] }) },
          { type: "function_call", name: "bash", call_id: "bash-1", arguments: '{"command":"echo should-not-run"}' },
        ],
      };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { bashCalls += 1; return bashResult(""); },
      writeAssistant() {},
    },
    questionInteraction: {
      async requestInput() {
        questionStarted();
        return await new Promise<Record<string, string>>((resolve) => { resolveQuestion = resolve; });
      },
    },
  });
  const turn = agent.runTurn("implement", controller.signal);
  await started;
  controller.abort(new Error("cancelled while asking"));
  resolveQuestion({ choice: "Late" });
  await assert.rejects(turn, /cancelled while asking/u);
  assert.equal(requests, 1);
  assert.equal(bashCalls, 0);
});

test("task progress persists before publication and supersedes restored checklist context", async () => {
  const persisted: TaskProgress[] = [];
  const requests: Array<Record<string, unknown>> = [];
  let responses = 0;
  const initialTaskProgress: TaskProgress = {
    plan: [{ step: "Old restored step", status: "in_progress" }],
    updated_at: "2026-09-30T00:00:00.000Z",
  };
  const agent = new ReactAgent({
    model: "progress-test",
    initialTaskProgress,
    client: { responses: { async create(params) {
      requests.push(params);
      responses += 1;
      return responses === 1
        ? { id: "update", output_text: "", output: [{ type: "function_call", name: "update_plan", call_id: "plan-1", arguments: JSON.stringify({ plan: [{ step: "Implement the change", status: "in_progress" }, { step: "Run checks", status: "pending" }] }) }] }
        : { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      async setTaskProgress(progress) { persisted.push({ ...progress, plan: progress.plan.map((item) => ({ ...item })) }); },
      writeAssistant() {},
    },
  });
  await agent.beginTask({ mode: "default", source: "session_resume" });
  await agent.runTurn("resume");
  await agent.runTurn("repair or continue the same goal");
  agent.endTask();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.plan[0]?.step, "Implement the change");
  assert.match(JSON.stringify(requests[0]), /Old restored step/u);
  assert.match(JSON.stringify(requests[1]), /Implement the change/u);
  assert.doesNotMatch(JSON.stringify(requests[1]), /Current task checklist[^]*Old restored step/iu);
  assert.match(JSON.stringify(requests[2]), /Implement the change/u);

  await agent.beginTask({ mode: "default", source: "user" });
  assert.deepEqual(persisted.at(-1)?.plan, []);
  agent.endTask();
});

test("task-progress persistence failure stops before another provider request", async () => {
  let requests = 0;
  const agent = new ReactAgent({
    model: "progress-persistence-test",
    client: { responses: { async create() {
      requests += 1;
      return { id: "update", output_text: "", output: [{ type: "function_call", name: "update_plan", call_id: "plan-1", arguments: '{"plan":[{"step":"Implement","status":"in_progress"}]}' }] };
    } } },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      async setTaskProgress() { throw new Error("disk full"); },
      writeAssistant() {},
    },
  });
  await assert.rejects(agent.runTurn("update progress"), (error: unknown) => error instanceof PersistenceError && /disk full/u.test(error.message));
  assert.equal(requests, 1);
});

test("background completion is durably injected once at the next step", async () => {
  const persisted: Array<Record<string, unknown>> = [];
  const requests: Array<Record<string, unknown>> = [];
  let samples = 0;
  const agent = new ReactAgent({
    model: "background-notice-test",
    client: { responses: { async create(params) {
      requests.push(params);
      samples += 1;
      return samples === 1
        ? { id: "start", output_text: "", output: [{ type: "function_call", name: "start_background", call_id: "start-1", arguments: '{"command":"build"}' }] }
        : { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      async runBackgroundBash() { return bashResult("built"); },
      writeAssistant() {},
    },
    onHistoryAppend: async (items) => { persisted.push(...items); },
  });
  await agent.beginTask({ mode: "default", source: "user" });
  await agent.runTurn("build");
  agent.endTask();
  const notices = persisted.filter((item) => item.role === "developer" && String(item.content).includes("Host background-job completion notice"));
  assert.equal(notices.length, 1);
  assert.match(JSON.stringify(requests[1]?.input), /Use poll_background to read retained output/u);
  assert.doesNotMatch(JSON.stringify(notices), /built/u);
});

test("synchronous background launch failure remains pollable and emits one durable notice", async (t) => {
  const persisted: Array<Record<string, unknown>> = [];
  let requests = 0, starts = 0;
  let jobId: string | undefined;
  const agent = new ReactAgent({
    model: "offline-background-failure",
    client: { responses: { async create(params) {
      requests++;
      if (requests === 1) return { id: "start", output_text: "", output: [{ type: "function_call", name: "start_background", call_id: "start-1", arguments: '{"command":"broken"}' }] };
      const input = params.input as Array<Record<string, unknown>>;
      if (requests === 2) {
        const started = input.find((item) => item.type === "function_call_output" && item.call_id === "start-1");
        assert.ok(started);
        const result = JSON.parse(String(started.output)) as { status: string; job: { job_id: string } };
        assert.equal(result.status, "ok");
        assert.ok(result.job.job_id);
        jobId = result.job.job_id;
        return { id: "poll", output_text: "", output: [{ type: "function_call", name: "poll_background", call_id: "poll-1", arguments: JSON.stringify({ job_id: jobId }) }] };
      }
      const polled = input.find((item) => item.type === "function_call_output" && item.call_id === "poll-1");
      assert.ok(polled);
      const result = JSON.parse(String(polled.output)) as { job: { job_id: string; status: string; finished_at: string; result: { error: string } } };
      assert.equal(result.job.job_id, jobId);
      assert.equal(result.job.status, "failed");
      assert.ok(result.job.finished_at);
      assert.equal(result.job.result.error, "fixture launch failed");
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { throw new Error("Unexpected foreground fallback"); },
      runBackgroundBash() { starts++; throw new Error("fixture launch failed"); },
      writeAssistant() {},
    },
    async onHistoryAppend(items) { persisted.push(...items); },
  });
  t.after(() => agent.dispose());
  await agent.beginTask({ mode: "default", source: "user" });
  await agent.runTurn("Start and inspect the failing background command.");
  await agent.waitForBackgroundJobs();
  agent.endTask();
  assert.equal(starts, 1);
  assert.equal(requests, 3);
  const notices = persisted.filter((item) => item.role === "developer" && String(item.content).includes("Host background-job completion notice"));
  assert.equal(notices.length, 1);
  assert.ok(String(notices[0]?.content).includes(`- ${jobId}: failed; exit code unavailable; finished `));
  assert.doesNotMatch(JSON.stringify(notices), /fixture launch failed/u);
  assert.deepEqual(persisted.filter((item) => item.type === "function_call_output").map((item) => item.call_id), ["start-1", "poll-1"]);
});

test("background arrivals during notice persistence remain queued in order", async () => {
  let resolveSecond!: (result: BashResult) => void;
  let persistenceStarted!: () => void;
  const started = new Promise<void>((resolve) => { persistenceStarted = resolve; });
  let releasePersistence!: () => void;
  const release = new Promise<void>((resolve) => { releasePersistence = resolve; });
  const persistedNotices: string[] = [];
  let requests = 0;
  let noticeWrites = 0;
  const agent = new ReactAgent({
    model: "background-arrival-test",
    client: { responses: { async create() {
      requests += 1;
      if (requests === 1) return { id: "starts", output_text: "", output: [
        { type: "function_call", name: "start_background", call_id: "start-1", arguments: '{"command":"first"}' },
        { type: "function_call", name: "start_background", call_id: "start-2", arguments: '{"command":"second"}' },
      ] };
      if (requests === 2) return { id: "continue", output_text: "", output: [], end_turn: false };
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      async runBackgroundBash(command) {
        if (command === "first") return bashResult("first output");
        return await new Promise<BashResult>((resolve) => { resolveSecond = resolve; });
      },
      writeAssistant() {},
    },
    onHistoryAppend: async (items) => {
      const notice = items.find((item) => item.role === "developer" && String(item.content).includes("Host background-job completion notice"));
      if (!notice) return;
      noticeWrites += 1;
      if (noticeWrites === 1) {
        persistenceStarted();
        await release;
      }
      persistedNotices.push(String(notice.content));
    },
  });
  await agent.beginTask({ mode: "default", source: "user" });
  const turn = agent.runTurn("start both");
  await started;
  resolveSecond(bashResult("second output"));
  await agent.waitForBackgroundJobs();
  releasePersistence();
  await turn;
  agent.endTask();
  assert.equal(requests, 3);
  assert.equal(persistedNotices.length, 2);
  const [firstNotice, secondNotice] = persistedNotices;
  assert.ok(firstNotice && secondNotice);
  assert.equal(firstNotice.split("Use poll_background").length - 1, 1);
  assert.equal(secondNotice.split("Use poll_background").length - 1, 1);
});

test("a completion from an ended task generation is ignored by the next task", async () => {
  let resolveOld!: (result: BashResult) => void;
  let requests = 0;
  const notices: string[] = [];
  const agent = new ReactAgent({
    model: "background-generation-test",
    client: { responses: { async create() {
      requests += 1;
      return requests === 1
        ? { id: "start", output_text: "", output: [{ type: "function_call", name: "start_background", call_id: "start-1", arguments: '{"command":"old"}' }] }
        : { id: `done-${requests}`, output_text: "done", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      async runBackgroundBash() { return await new Promise<BashResult>((resolve) => { resolveOld = resolve; }); },
      writeAssistant() {},
    },
    onHistoryAppend: async (items) => {
      notices.push(...items.filter((item) => item.role === "developer").map((item) => String(item.content)));
    },
  });
  await agent.beginTask({ mode: "default", source: "user" });
  await agent.runTurn("old task");
  agent.endTask();
  await agent.beginTask({ mode: "default", source: "user" });
  resolveOld(bashResult("late output"));
  await agent.waitForBackgroundJobs();
  await agent.runTurn("new task");
  agent.endTask();
  assert.equal(notices.some((content) => content.includes("Host background-job completion notice")), false);
});

test("background notice persistence failure blocks the following provider request", async () => {
  let requests = 0;
  let failNotice = true;
  const persistedNotices: Array<Record<string, unknown>> = [];
  const agent = new ReactAgent({
    model: "background-notice-persistence-test",
    client: { responses: { async create() {
      requests += 1;
      return requests === 1
        ? { id: "start", output_text: "", output: [{ type: "function_call", name: "start_background", call_id: "start-1", arguments: '{"command":"build"}' }] }
        : { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      async runBackgroundBash() { return bashResult("built"); },
      writeAssistant() {},
    },
    onHistoryAppend: async (items) => {
      const notices = items.filter((item) => item.role === "developer" && String(item.content).includes("Host background-job completion notice"));
      if (notices.length > 0 && failNotice) throw new Error("notice storage failed");
      persistedNotices.push(...notices);
    },
  });
  await agent.beginTask({ mode: "default", source: "user" });
  await assert.rejects(agent.runTurn("build"), (error: unknown) => error instanceof PersistenceError && /notice storage failed/u.test(error.message));
  failNotice = false;
  await agent.runTurn("retry durable notice");
  agent.endTask();
  assert.equal(requests, 2);
  assert.equal(persistedNotices.length, 1);
});

test("background starts reserve twenty task-local notice slots until delivery", async () => {
  let requests = 0;
  let secondInput: Array<Record<string, unknown>> = [];
  const calls = Array.from({ length: 21 }, (_, index) => ({
    type: "function_call",
    name: "start_background",
    call_id: `start-${index + 1}`,
    arguments: JSON.stringify({ command: `job-${index + 1}` }),
  }));
  const agent = new ReactAgent({
    model: "background-backlog-test",
    client: { responses: { async create(params) {
      requests += 1;
      if (requests === 1) return { id: "starts", output_text: "", output: calls };
      secondInput = params.input as Array<Record<string, unknown>>;
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      async runBackgroundBash() { return bashResult("done"); },
      writeAssistant() {},
    },
  });
  await agent.beginTask({ mode: "default", source: "user" });
  await agent.runTurn("start jobs");
  agent.endTask();
  const outputs = secondInput.filter((item) => item.type === "function_call_output");
  assert.equal(outputs.length, 21);
  assert.match(String(outputs.at(-1)?.output), /backlog reached 20/u);
  const notice = secondInput.find((item) => item.role === "developer" && String(item.content).includes("Host background-job completion notice"));
  assert.ok(notice);
  assert.equal(String(notice.content).split("Use poll_background").length - 1, 20);
});

test("plan mode can use enabled web tools without approval", async () => {
  let requests = 0;
  let webApprovals = 0;
  const agent = new ReactAgent({
    client: { responses: { async create() {
      requests += 1;
      return requests === 1
        ? { id: "search", output_text: "", output: [{ type: "function_call", name: "web_search", arguments: '{"query":"TypeScript"}', call_id: "search-1" }] }
        : { id: "done", output_text: "Plan researched.", output: [] };
    } } },
    model: "test",
    io: {
      getPermissions: () => ({ mode: "workspace-write", web: true }),
      async confirmBash() { throw new Error("Bash should not be requested in Plan mode"); },
      async confirmWeb() { webApprovals += 1; return true; },
      async runBash() { throw new Error("Bash should not run in Plan mode"); },
      writeAssistant() {},
    },
    web: {
      async search(query) { return { query, results: [] }; },
      async fetch() { throw new Error("web_fetch should not run"); },
    },
  });

  await agent.runTurn("research the current TypeScript details", undefined, { mode: "plan" });
  assert.equal(webApprovals, 0);
  assert.equal(requests, 2);
});

test("agent refreshes learned memory per step and captures only after verification", async () => {
  const instructions: string[] = [];
  const prompts: string[] = [];
  const captures: unknown[] = [];
  let loadCount = 0;
  const learnedMemory = {
    async loadPrompt() {
      loadCount += 1;
      return "<learned_memory>Prefer the existing test style.</learned_memory>";
    },
    scheduleCapture(turn: unknown) {
      captures.push(turn);
    },
    async remember() {},
    async status() { return { enabled: true, projectEntries: 0, userEntries: 0, recent: [] }; },
    async setEnabled() {},
    async clear() {},
  };
  const responses = [
    { id: "tool", output_text: "", output: [{ type: "function_call", name: "read_file", call_id: "call-1", arguments: '{"path":"README.md"}' }] },
    { id: "done", output_text: "Completed", output: [] },
    { id: "done-2", output_text: "Completed again", output: [] },
  ];
  const agent = new ReactAgent({
    model: "test",
    workspacePath: "C:\\repo",
    learnedMemory,
    client: { responses: { async create(params) {
      instructions.push(String(params.instructions));
      prompts.push(JSON.stringify(params.input));
      return responses.shift()!;
    } } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("inspect the repository");
  assert.equal(captures.length, 0);
  await agent.finishMemoryTurn("verified");
  await agent.runTurn("continue");
  await agent.finishMemoryTurn("verified");
  assert.equal(loadCount, 3);
  assert.equal(captures.length, 2);
  assert.match(instructions[0]!, /Prefer the existing test style/u);
  assert.match(prompts[1]!, /README\.md/u);
  assert.equal((captures[0] as { toolCallCount: number }).toolCallCount, 1);
});

test("a failed new turn cannot finalize stale learning material from an earlier turn", async () => {
  const outcomes: unknown[] = [];
  let requests = 0;
  const learnedMemory = {
    async loadPrompt() { return ""; },
    scheduleCapture() {},
    async finishTurn(turn: unknown, outcome: unknown) { outcomes.push({ turn, outcome }); },
    async remember() {},
    async status() { return { enabled: true, projectEntries: 0, userEntries: 0, recent: [] }; },
    async setEnabled() {},
    async clear() {},
  };
  const agent = new ReactAgent({
    model: "test",
    samplingRetryBudget: 0,
    learnedMemory,
    client: { responses: { async create() {
      requests += 1;
      if (requests === 1) return { id: "done", output_text: "Completed", output: [] };
      throw new Error("fixture sampling failure");
    } } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("first turn");
  await assert.rejects(agent.runTurn("second turn"), /fixture sampling failure/u);
  await agent.finishMemoryTurn("failed");
  assert.deepEqual(outcomes, []);
});

test("disabled memory reading removes lookup from the tool snapshot and rejects dispatch", async () => {
  let requests = 0;
  let lookups = 0;
  const learnedMemory = {
    async loadPrompt() { return ""; },
    isReadEnabled() { return false; },
    getPolicy() { return { readExisting: true, captureFuture: true }; },
    async lookup() { lookups += 1; return undefined; },
    scheduleCapture() {},
    async remember() {},
    async status() { return { enabled: false, projectEntries: 0, userEntries: 0, recent: [] }; },
    async setEnabled() {},
    async clear() {},
  };
  const agent = new ReactAgent({
    model: "test",
    learnedMemory,
    client: { responses: { async create(params) {
      requests += 1;
      assert.equal((params.tools as Array<{ name?: string }>).some((tool) => tool.name === "memory_lookup"), false);
      if (requests === 1) return { id: "lookup", output_text: "", output: [{ type: "function_call", name: "memory_lookup", call_id: "memory-1", arguments: '{"id":"fixture-id"}' }] };
      const output = params.input as Array<Record<string, unknown>>;
      assert.match(String(output.find((item) => item.type === "function_call_output")?.output), /denied/u);
      return { id: "done", output_text: "done", output: [] };
    } } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("do not use memory");
  assert.equal(lookups, 0);
});

test("agent confirms, runs Bash, and returns its output to the model", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const commands: string[] = [];
  const responses = [
    {
      id: "response-1",
      output_text: "I will inspect the directory.",
      output: [
        {
          type: "function_call",
          name: "bash",
          arguments: '{"command":"pwd"}',
          call_id: "call-1",
        },
      ],
    },
    { id: "response-2", output_text: "Done", output: [] },
  ];
  const client: ResponsesClientLike = {
    responses: {
      async create(params) {
        requests.push(params);
        const response = responses.shift();
        assert.ok(response);
        return response;
      },
    },
  };
  const agent = new ReactAgent({
    client,
    model: "deepseek-flash",
    io: {
      getPermissions: () => ({ mode: "ask", web: true }),
      async confirmBash(command) {
        commands.push(command);
        return true;
      },
      async runBash(command) {
        assert.equal(command, "pwd");
        return bashResult("/repo\n");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("where am I?");

  assert.deepEqual(commands, ["pwd"]);
  assert.equal(requests[1]?.previous_response_id, undefined);
  const history = requests[1]?.input as Array<Record<string, unknown>>;
  assert.equal(history[0]?.role, "user");
  assert.equal(history.some((item) => item.type === "function_call" && item.call_id === "call-1"), true);
  const toolOutput = history.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput);
  assert.match(String(toolOutput.output), /\/repo/);
});

test("agent invalidates a Bash approval when the permission policy changes", async () => {
  let policy: PermissionPolicy = { mode: "ask", web: true };
  let executions = 0;
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    { id: "command", output_text: "", output: [{ type: "function_call", name: "bash", arguments: '{"command":"pwd"}', call_id: "call-policy" }] },
    { id: "done", output_text: "stopped", output: [] },
  ];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests.push(params);
      const response = responses.shift();
      assert.ok(response);
      return response;
    } } },
    io: {
      getPermissions: () => policy,
      async confirmBash() {
        policy = { mode: "read-only", web: false };
        return true;
      },
      async runBash() {
        executions += 1;
        return bashResult("unexpected");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("inspect");
  assert.equal(executions, 0);
  const followup = requests[1]?.input as Array<Record<string, unknown>>;
  assert.match(String(followup.find((item) => item.type === "function_call_output")?.output), /permission policy changed/iu);
});

test("agent tells the model when the user rejects Bash", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    {
      id: "response-1",
      output_text: "",
      output: [
        {
          type: "function_call",
          name: "bash",
          arguments: '{"command":"rm file"}',
          call_id: "call-1",
        },
      ],
    },
    { id: "response-2", output_text: "I did not run it.", output: [] },
  ];
  const client: ResponsesClientLike = {
    responses: {
      async create(params) {
        requests.push(params);
        const response = responses.shift();
        assert.ok(response);
        return response;
      },
    },
  };
  const agent = new ReactAgent({
    client,
    model: "deepseek-flash",
    io: {
      getPermissions: () => ({ mode: "ask", web: true }),
      async confirmBash() {
        return false;
      },
      async runBash() {
        throw new Error("Rejected command must not run");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("delete the file");

  const history = requests[1]?.input as Array<Record<string, unknown>>;
  const toolOutput = history.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput);
  assert.match(String(toolOutput.output), /rejected/);
});

test("agent exposes MCP tools, keeps approval separate, and returns MCP output", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const approvals: string[] = [];
  const calls: string[] = [];
  const responses = [
    {
      id: "mcp-tool",
      output_text: "",
      output: [{
        type: "function_call",
        name: "mcp__calendar__list",
        arguments: '{"day":"today"}',
        call_id: "mcp-1",
      }],
    },
    { id: "mcp-done", output_text: "done", output: [] },
  ];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests.push(params);
      return responses.shift()!;
    } } },
    mcp: {
      async ensureReady() {
        return {
          tools: [{ type: "function", name: "mcp__calendar__list", description: "List events", parameters: { type: "object" } }],
          toolInfo: [{ callableName: "mcp__calendar__list", serverName: "calendar", toolName: "list", binding: "calendar-binding-v1" }],
          instructions: "Calendar MCP instructions.",
          servers: [],
        };
      },
      toolInfo() {
        throw new Error("ReactAgent must use the atomic snapshot metadata");
      },
      async call(name, args, bindingOrSignal?: string | AbortSignal) {
        assert.equal(bindingOrSignal, "calendar-binding-v1");
        calls.push(`${name}:${args}`);
        return JSON.stringify({ content: [{ type: "text", text: "meeting" }] });
      },
    },
    io: {
      getPermissions: () => ({ mode: "workspace-write", web: false }),
      async confirmBash() { return false; },
      async confirmMcp(request) { approvals.push(request); return true; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("list my meetings");

  assert.equal(approvals.length, 1);
  assert.match(approvals[0]!, /calendar\/list/u);
  assert.deepEqual(calls, ['mcp__calendar__list:{"day":"today"}']);
  assert.match(String(requests[0]?.instructions), /Calendar MCP instructions/u);
  const tools = requests[0]?.tools as Array<{ name: string }>;
  assert.ok(tools.some((tool) => tool.name === "mcp__calendar__list"));
  assert.match(JSON.stringify(requests[1]?.input), /meeting/u);
});

test("agent freezes MCP definitions and bindings across sampling retries and refreshes the next step", async () => {
  const name = "mcp__calendar__list";
  let catalogVersion = 1;
  let preparations = 0;
  let requests = 0;
  const dispatchedBindings: string[] = [];
  const snapshot = (version: number) => ({
    tools: [{ type: "function" as const, name, description: `Calendar v${version}`, parameters: { type: "object" } }],
    toolInfo: [{ callableName: name, serverName: "calendar", toolName: "list", description: `Calendar v${version}`, binding: `binding-v${version}` }],
    instructions: `Calendar instructions v${version}`,
    servers: [],
  });
  const agent = new ReactAgent({
    model: "test",
    samplingRetryBudget: 1,
    client: { responses: { async create(params) {
      requests += 1;
      const advertised = (params.tools as Array<{ name: string; description: string }>).find((tool) => tool.name === name);
      assert.ok(advertised);
      if (requests === 1) {
        assert.equal(advertised.description, "Calendar v1");
        assert.match(String(params.instructions), /Calendar instructions v1/u);
        catalogVersion = 2;
        throw Object.assign(new Error("temporary network failure"), { status: 503 });
      }
      if (requests === 2) {
        assert.equal(advertised.description, "Calendar v1");
        assert.match(String(params.instructions), /Calendar instructions v1/u);
        return { id: "retry-complete", output_text: "", output: [{ type: "function_call", name, arguments: "{}", call_id: "mcp-retry" }] };
      }
      assert.equal(advertised.description, "Calendar v2");
      assert.match(String(params.instructions), /Calendar instructions v2/u);
      return { id: "done", output_text: "done", output: [] };
    } } },
    mcp: {
      async ensureReady() {
        preparations += 1;
        return snapshot(catalogVersion);
      },
      toolInfo() { throw new Error("Live MCP metadata lookup is not allowed"); },
      async call(_name, _args, bindingOrSignal?: string | AbortSignal) {
        assert.equal(typeof bindingOrSignal, "string");
        dispatchedBindings.push(bindingOrSignal as string);
        return JSON.stringify({ status: "ok" });
      },
    },
    io: {
      getPermissions: () => ({ mode: "full-access", web: false }),
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("list meetings");
  assert.equal(requests, 3);
  assert.equal(preparations, 2);
  assert.deepEqual(dispatchedBindings, ["binding-v1"]);
});

test("agent presents frozen MCP approval details and rejects a binding changed while approval waits", async () => {
  const name = "mcp__calendar__delete";
  let catalogVersion = 1;
  let requests = 0;
  let serverExecutions = 0;
  const approvals: string[] = [];
  const dispatchedBindings: string[] = [];
  const snapshot = (version: number) => ({
    tools: [{ type: "function" as const, name, description: `Delete calendar event v${version}`, parameters: { type: "object" } }],
    toolInfo: [{
      callableName: name,
      serverName: `calendar-v${version}`,
      toolName: "delete",
      annotations: { destructiveHint: true },
      binding: `binding-v${version}`,
    }],
    instructions: "",
    servers: [],
  });
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests += 1;
      if (requests === 1) {
        assert.equal((params.tools as Array<{ name: string; description: string }>).find((tool) => tool.name === name)?.description, "Delete calendar event v1");
        return { id: "delete", output_text: "", output: [{ type: "function_call", name, arguments: '{"id":"meeting-1"}', call_id: "mcp-delete" }] };
      }
      assert.equal((params.tools as Array<{ name: string; description: string }>).find((tool) => tool.name === name)?.description, "Delete calendar event v2");
      assert.match(JSON.stringify(params.input), /binding is stale/u);
      return { id: "done", output_text: "done", output: [] };
    } } },
    mcp: {
      async ensureReady() { return snapshot(catalogVersion); },
      toolInfo() { throw new Error("Live MCP metadata lookup is not allowed"); },
      async call(_name, _args, bindingOrSignal?: string | AbortSignal) {
        assert.equal(typeof bindingOrSignal, "string");
        const binding = bindingOrSignal as string;
        dispatchedBindings.push(binding);
        if (binding !== `binding-v${catalogVersion}`) {
          return JSON.stringify({ status: "error", error: "MCP tool binding is stale" });
        }
        serverExecutions += 1;
        return JSON.stringify({ status: "ok" });
      },
    },
    io: {
      getPermissions: () => ({ mode: "workspace-write", web: false }),
      async confirmMcp(detail) {
        approvals.push(detail);
        catalogVersion = 2;
        return true;
      },
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("delete a meeting");
  assert.deepEqual(approvals, ['calendar-v1/delete {"id":"meeting-1"}']);
  assert.deepEqual(dispatchedBindings, ["binding-v1"]);
  assert.equal(serverExecutions, 0);
});

test("agent progressively loads matching skills and injects explicit skill instructions for one turn", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const responses = [
    {
      id: "skill-tool",
      output_text: "",
      output: [{ type: "function_call", name: "read_skill", arguments: '{"name":"demo"}', call_id: "skill-1" }],
    },
    { id: "skill-done", output_text: "done", output: [] },
  ];
  const agent = new ReactAgent({
    model: "test",
    client: { responses: { async create(params) {
      requests.push(params);
      return responses.shift()!;
    } } },
    skills: {
      async prepareTurn(input) {
        assert.equal(input, "use $demo");
        return {
          skills: [{ name: "demo", description: "Demo tasks", path: "/skills/demo/SKILL.md", directory: "/skills/demo", scope: "user" }],
          errors: [],
          conflictedNames: [],
          instructions: "Available skill: demo.",
          explicitInstructions: "Full explicit demo instructions.",
          explicitNames: ["demo"],
        };
      },
      async read(args) { reads.push(args); return JSON.stringify({ status: "ok", data: { contents: "skill body" } }); },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("use $demo");

  assert.deepEqual(reads, ['{"name":"demo"}']);
  assert.match(String(requests[0]?.instructions), /Full explicit demo instructions/u);
  assert.ok((requests[0]?.tools as Array<{ name: string }>).some((tool) => tool.name === "read_skill"));
  assert.match(JSON.stringify(requests[1]?.input), /skill body/u);
});

test("workspace-write searches the web without per-request confirmation", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const toolActivity: string[] = [];
  const webApprovals: string[] = [];
  const responses = [
    {
      id: "response-search",
      output_text: "",
      output: [
        {
          type: "function_call",
          name: "web_search",
          arguments: '{"query":"latest TypeScript release"}',
          call_id: "call-search",
        },
      ],
    },
    { id: "response-final", output_text: "TypeScript was released.", output: [] },
  ];
  const agent = new ReactAgent({
    client: {
      responses: {
        async create(params) {
          requests.push(params);
          const response = responses.shift();
          assert.ok(response);
          return response;
        },
      },
    },
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        throw new Error("Web search must not request Bash confirmation");
      },
      async confirmWeb() {
        webApprovals.push("search");
        return true;
      },
      async runBash() {
        throw new Error("Web search must not run Bash");
      },
      writeAssistant() {},
      writeTool(text) {
        toolActivity.push(text);
      },
    },
    web: {
      async search(query) {
        assert.equal(query, "latest TypeScript release");
        return {
          query,
          results: [
            {
              title: "TypeScript",
              url: "https://www.typescriptlang.org/",
              snippet: "Latest release",
            },
          ],
        };
      },
      async fetch() {
        throw new Error("web_fetch should not run");
      },
    },
  });

  await agent.runTurn("What is the latest TypeScript release?");

  assert.deepEqual(toolActivity, ["Searching the web: latest TypeScript release"]);
  assert.deepEqual(webApprovals, []);
  const tools = requests[0]?.tools as Array<Record<string, unknown>>;
  assert.deepEqual(tools.map((tool) => tool.name), [
    "bash",
    "start_background",
    "poll_background",
    "stop_background",
    "apply_patch",
    "workspace_status",
    "workspace_diff",
    "list_workspace_changes",
    "read_workspace_change",
    "web_search",
    "web_fetch",
    "project_map",
    "read_file",
    "list_directory",
    "search_files",
    "glob_files",
    "read_search_results",
    "read_tool_output",
  ]);
  const history = requests[1]?.input as Array<Record<string, unknown>>;
  const toolOutput = history.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput);
  assert.match(String(toolOutput.output), /typescriptlang\.org/u);
});

test("agent returns web failures to the model as tool output", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    {
      id: "response-search",
      output_text: "",
      output: [
        {
          type: "function_call",
          name: "web_search",
          arguments: '{"query":"current news"}',
          call_id: "call-search",
        },
      ],
    },
    { id: "response-final", output_text: "Search is unavailable.", output: [] },
  ];
  const agent = new ReactAgent({
    client: {
      responses: {
        async create(params) {
          requests.push(params);
          const response = responses.shift();
          assert.ok(response);
          return response;
        },
      },
    },
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async confirmWeb() {
        return true;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
    web: {
      async search() {
        throw new Error("network unavailable");
      },
      async fetch() {
        throw new Error("not used");
      },
    },
  });

  await agent.runTurn("search the news");

  const history = requests[1]?.input as Array<Record<string, unknown>>;
  const toolOutput = history.find((item) => item.type === "function_call_output");
  assert.ok(toolOutput);
  assert.match(String(toolOutput.output), /network unavailable/u);
});

test("agent keeps the final response as context for the next turn", async () => {
  const requests: Array<Record<string, unknown>> = [];
  let responseNumber = 0;
  const client: ResponsesClientLike = {
    responses: {
      async create(params) {
        requests.push(params);
        responseNumber += 1;
        return {
          id: `response-${responseNumber}`,
          output_text: "ok",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        };
      },
    },
  };
  const agent = new ReactAgent({
    client,
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("first");
  await agent.runTurn("second");

  assert.equal(requests[1]?.previous_response_id, undefined);
  const history = requests[1]?.input as Array<Record<string, unknown>>;
  assert.equal(history[0]?.content, "first");
  assert.equal(history.some((item) => item.role === "assistant"), true);
  assert.equal(history.at(-1)?.content, "second");
});

test("agent forwards an AbortSignal to every model request", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const client: ResponsesClientLike = {
    responses: {
      async create(_params, options) {
        signals.push(options?.signal);
        return { id: "response-1", output_text: "done", output: [] };
      },
    },
  };
  const controller = new AbortController();
  const agent = new ReactAgent({
    client,
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
  });

  await agent.runTurn("hello", controller.signal);

  assert.deepEqual(signals, [controller.signal]);
});

test("agent restores prior context and persists each new context batch", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const persisted: Array<readonly Record<string, unknown>[]> = [];
  const assistantItem = {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "continued" }],
  };
  const agent = new ReactAgent({
    client: {
      responses: {
        async create(params) {
          requests.push(structuredClone(params));
          return {
            id: "response-restored",
            output_text: "continued",
            output: [assistantItem],
          };
        },
      },
    },
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
    initialHistory: [
      { role: "user", content: "before restart" },
      { type: "message", role: "assistant", content: "old answer" },
    ],
    async onHistoryAppend(items) {
      persisted.push(items.map((item) => ({ ...item })));
    },
  });

  await agent.runTurn("after restart");

  const isPersistedRuleSnapshot = (item: Record<string, unknown>): boolean =>
    item.role === "developer"
    && String(item.content).startsWith("Host-maintained project rule snapshot revision ");
  const isCurrentRuleContext = (item: Record<string, unknown>): boolean =>
    item.role === "developer"
    && String(item.content).includes("Current host-maintained project rule snapshot (");
  const requestInput = requests[0]?.input as Array<Record<string, unknown>>;
  assert.deepEqual(requestInput.filter((item) => !isPersistedRuleSnapshot(item) && !isCurrentRuleContext(item)), [
    { role: "user", content: "before restart" },
    { type: "message", role: "assistant", content: "old answer" },
    { role: "user", content: "after restart" },
  ]);
  assert.equal(requestInput.some(isCurrentRuleContext) || String(requests[0]?.instructions).includes("Current host-maintained project rule snapshot ("), true);
  assert.deepEqual(persisted.filter((items) => !items.every(isPersistedRuleSnapshot)), [
    [{ role: "user", content: "after restart" }],
    [assistantItem],
  ]);
  assert.equal(persisted.some((items) => items.some(isPersistedRuleSnapshot)), true);
});

test("agent persists file attachments once and reuses them without duplicating retries or later turns", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const persisted: Array<Record<string, unknown>> = [];
  const agent = new ReactAgent({
    client: { responses: { async create(params) {
      requests.push(structuredClone(params));
      return { id: `response-${requests.length}`, output_text: "done", output: [] };
    } } },
    model: "deepseek-flash",
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
    async onHistoryAppend(items) { persisted.push(...items.map((item) => structuredClone(item))); },
  });
  const attachment = {
    path: "src/example.ts",
    startLine: 2,
    endLine: 3,
    totalLines: 10,
    content: "second\nthird",
    sha256: "b".repeat(64),
    truncated: true,
  };
  await agent.runTurn('Review @"src/example.ts"#L2-L3', undefined, { attachments: [attachment] });
  await agent.runTurn("continue without reattaching");

  const markerCount = (value: unknown) => JSON.stringify(value).match(/<host_file_attachment /gu)?.length ?? 0;
  assert.equal(markerCount(requests[0]?.input), 1);
  assert.equal(markerCount(requests[1]?.input), 1);
  assert.equal(markerCount(persisted), 1);
  assert.match(JSON.stringify(persisted), /Review @\\"src\/example\.ts\\"#L2-L3/u);
});

test("agent reports usage for every response in a tool loop", async () => {
  const usage: Array<{
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null> = [];
  const responses = [
    {
      id: "response-tool",
      output_text: "checking",
      output: [
        {
          type: "function_call",
          name: "bash",
          arguments: '{"command":"pwd"}',
          call_id: "call-usage",
        },
      ],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
    {
      id: "response-final",
      output_text: "done",
      output: [],
      usage: { input_tokens: 150, output_tokens: 30, total_tokens: 180 },
    },
  ];
  const agent = new ReactAgent({
    client: {
      responses: {
        async create() {
          const response = responses.shift();
          assert.ok(response);
          return response;
        },
      },
    },
    model: "deepseek-flash",
    io: {
      async confirmBash() {
        return true;
      },
      async runBash() {
        return bashResult("/repo\n");
      },
      writeAssistant() {},
    },
    async onUsage(sample) {
      usage.push(sample);
    },
  });

  await agent.runTurn("inspect");

  assert.deepEqual(usage, [
    { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    { input_tokens: 150, output_tokens: 30, total_tokens: 180 },
  ]);
});

test("agent sends a stable prompt cache key and reports cached usage details", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const requestOptions: Array<Record<string, unknown> | undefined> = [];
  const usage: Array<unknown> = [];
  const agent = new ReactAgent({
    model: "gpt-5.6",
    promptCacheKey: "everpeace:v2:session:test-key",
    promptCacheOptions: { mode: "implicit", ttl: "30m" },
    client: {
      responses: {
        async create(params, options) {
          requests.push(params);
          requestOptions.push(options as Record<string, unknown> | undefined);
          return {
            id: "response-cache",
            output_text: "done",
            output: [],
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
            },
          };
        },
      },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
    async onUsage(sample) { usage.push(sample); },
  });

  await agent.runTurn("hello");
  assert.equal(requests[0]?.prompt_cache_key, "everpeace:v2:session:test-key");
  assert.deepEqual(requests[0]?.prompt_cache_options, { mode: "implicit", ttl: "30m" });
  assert.equal(requests[0]?.instructions, undefined);
  const requestInput = requests[0]?.input as Array<Record<string, unknown>>;
  assert.equal(requestInput[0]?.role, "developer");
  assert.deepEqual((requestInput[0]?.content as Array<Record<string, unknown>>)[0]?.prompt_cache_breakpoint, { mode: "explicit" });
  assert.deepEqual(requestOptions[0]?.headers, { "session-id": "everpeace:v2:session:test-key" });
  assert.deepEqual(usage, [{
    input_tokens: 100,
    output_tokens: 10,
    total_tokens: 110,
    cached_input_tokens: 80,
      cache_observed_input_tokens: 100,
    cache_write_input_tokens: 20,
  }]);
});

test("agent resolves the session cache key at request time and reuses it for compaction", async () => {
  let sessionId: string | undefined;
  const calls: Array<{ kind: string; params: Record<string, unknown>; options: Record<string, unknown> | undefined }> = [];
  const agent = new ReactAgent({
    model: "gpt-5.5",
    promptCacheKey: () => sessionId === undefined ? undefined : `everpeace:v2:session:${sessionId}`,
    client: {
      responses: {
        async create(params, options) {
          calls.push({ kind: "create", params, options: options as Record<string, unknown> | undefined });
          return { id: "response-1", output_text: "done", output: [] };
        },
        async compact(params, options) {
          calls.push({ kind: "compact", params, options: options as Record<string, unknown> | undefined });
          return { output: [{ role: "user", content: "retained" }] };
        },
      },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  sessionId = "created-after-agent";
  await agent.runTurn("hello");
  await agent.compact();

  assert.equal(calls[0]?.params.prompt_cache_key, "everpeace:v2:session:created-after-agent");
  assert.deepEqual(calls[0]?.options?.headers, { "session-id": "everpeace:v2:session:created-after-agent" });
  assert.equal(calls[1]?.kind, "compact");
  assert.equal(calls[1]?.params.prompt_cache_key, "everpeace:v2:session:created-after-agent");
  assert.deepEqual(calls[1]?.options?.headers, { "session-id": "everpeace:v2:session:created-after-agent" });
});

test("stream requests use the same session cache affinity header", async () => {
  let seenOptions: Record<string, unknown> | undefined;
  const agent = new ReactAgent({
    model: "gpt-5.5",
    promptCacheKey: "everpeace:v2:session:stream",
    client: {
      responses: {
        async create() {
          throw new Error("buffered path should not be used");
        },
        async *stream(_params, options) {
          seenOptions = options as Record<string, unknown> | undefined;
          yield { type: "response.completed", response: { id: "stream-response", output: [], output_text: "done" } };
        },
      },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("hello");

  assert.deepEqual(seenOptions?.headers, { "session-id": "everpeace:v2:session:stream" });
});

test("agent falls back once when advanced prompt cache fields are rejected", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const usage: unknown[] = [];
  const agent = new ReactAgent({
    model: "gpt-5.6",
    promptCacheKey: "everpeace:v2:session:fallback",
    promptCacheOptions: { mode: "implicit", ttl: "30m" },
    client: {
      responses: {
        async create(params) {
          requests.push(params);
          if (params.prompt_cache_options !== undefined) {
            throw { status: 400, message: "Unknown parameter: prompt_cache_options" };
          }
          return { id: "response-1", output_text: "done", output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
        },
      },
    },
    io: {
      async confirmBash() { return false; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
    async onUsage(sample) { usage.push(sample); },
  });

  await agent.runTurn("hello");

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.prompt_cache_options, { mode: "implicit", ttl: "30m" });
  assert.equal(requests[1]?.prompt_cache_options, undefined);
  assert.equal(typeof requests[1]?.instructions, "string");
  assert.equal(requests[1]?.prompt_cache_key, "everpeace:v2:session:fallback");
  assert.deepEqual(usage, [null, { input_tokens: 10, output_tokens: 2, total_tokens: 12 }]);
});

test("agent reports unavailable usage without failing compatible endpoints", async () => {
  const usage: Array<unknown> = [];
  const agent = new ReactAgent({
    client: {
      responses: {
        async create() {
          return { id: "response-1", output_text: "done", output: [] };
        },
      },
    },
    model: "custom-model",
    io: {
      async confirmBash() {
        return false;
      },
      async runBash() {
        return bashResult("");
      },
      writeAssistant() {},
    },
    async onUsage(sample) {
      usage.push(sample);
    },
  });

  await agent.runTurn("hello");

  assert.deepEqual(usage, [null]);
});

test("request attempt ledger stops retries after an emitted request has unknown usage", async () => {
  const ledger = new RequestAttemptLedger({ tokenBudget: 1_000 });
  let requests = 0;
  let retries = 0;
  const agent = new ReactAgent({
    model: "deepseek-flash",
    requestAttemptLedger: ledger,
    client: { responses: { async create() {
      requests += 1;
      throw Object.assign(new Error("upstream failed"), { status: 503 });
    } } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
    onEvent(event) { if (event.type === "retrying") retries += 1; },
  });
  const result = await agent.runTurn("fix it");
  assert.equal(result.stopReason, "usage_limited");
  assert.equal(requests, 1);
  assert.equal(retries, 0);
  assert.equal(ledger.snapshot().complete, false);
});

test("DeepSeek request snapshots keep stable instructions before history and dynamic rules at the tail", async () => {
  const inputs: Array<Array<Record<string, unknown>>> = [];
  const agent = new ReactAgent({
    model: "deepseek-flash",
    providerCapabilities: resolveProviderCapabilities("https://api.deepseek.com", "deepseek-flash"),
    client: { responses: { async create(params) {
      inputs.push(params.input as Array<Record<string, unknown>>);
      return { id: `response-${inputs.length}`, output_text: "done", output: [], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } };
    } } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("first");
  await agent.runTurn("second");
  assert.equal(inputs[0]?.[0]?.role, "developer");
  assert.equal(inputs[0]?.at(-1)?.role, "developer");
  assert.match(String(inputs[0]?.at(-1)?.content), /Current permissions/u);
  assert.ok(inputs[1]?.slice(1, -1).some((item) => item.role === "user" && item.content === "first"));
  assert.equal(inputs[1]?.at(-1)?.role, "developer");
});

test("agent consumes Responses stream deltas and reconstructs tool calls", async () => {
  const deltas: string[] = [];
  const assistants: string[] = [];
  const calls: string[] = [];
  const toolProgress: string[] = [];
  const reasoningEvents: string[] = [];
  let request = 0;
  const agent = new ReactAgent({
    model: "streaming-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream() {
          request++;
          if (request === 1) {
            yield { type: "response.reasoning_text.delta", delta: "private reasoning" };
            yield { type: "response.output_text.delta", delta: "I will " };
            yield { type: "response.output_text.delta", delta: "inspect." };
            yield { type: "response.output_item.added", output_index: 0, item: { id: "fc-stream", type: "function_call", name: "bash", arguments: "" } };
            yield { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc-stream", delta: '{"command":"pwd"}' };
            yield { type: "response.output_item.done", output_index: 0, item: { type: "function_call", name: "bash", call_id: "stream-call", arguments: '{"command":"pwd"}' } };
          } else {
            yield { type: "response.output_text.delta", delta: "Done" };
          }
          yield { type: "response.completed", response: { id: `response-${request}`, output: request === 1 ? [{ type: "function_call", name: "bash", call_id: "stream-call", arguments: '{"command":"pwd"}' }] : [], output_text: request === 1 ? "I will inspect." : "Done" } };
        },
      },
    },
    onEvent(event) {
      if (event.type === "reasoning_started" || event.type === "reasoning_finished") reasoningEvents.push(event.type);
    },
    io: {
      async confirmBash() { return true; },
      async runBash(command) { calls.push(command); return bashResult("ok"); },
      writeAssistant(text) { assistants.push(text); },
      writeAssistantDelta(text) { deltas.push(text); },
      onToolProgress(event) { toolProgress.push(`${event.phase}:${event.name}:${event.detail ?? ""}`); },
    },
  });
  await agent.runTurn("inspect");
  assert.deepEqual(deltas, ["I will ", "inspect.", "Done"]);
  assert.deepEqual(assistants, ["I will inspect.", "Done"]);
  assert.deepEqual(calls, ["pwd"]);
  assert.deepEqual(reasoningEvents, ["reasoning_started", "reasoning_finished"]);
  assert.ok(toolProgress.some((event) => event.includes('streaming:bash:{"command":"pwd"}')));
});

test("agent falls back to buffered responses only for an explicit stream capability rejection", async () => {
  let streamCalls = 0;
  let createCalls = 0;
  const agent = new ReactAgent({
    model: "stream-fallback-test",
    client: {
      responses: {
        async stream() {
          streamCalls += 1;
          throw Object.assign(new Error("stream is not supported"), {
            status: 400,
            code: "unsupported_parameter",
            param: "stream",
          });
        },
        async create() {
          createCalls += 1;
          return { id: `buffered-${createCalls}`, output_text: "done", output: [] };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });

  await agent.runTurn("first");
  await agent.runTurn("second");
  assert.equal(streamCalls, 1);
  assert.equal(createCalls, 2);
});

test("agent retries a stream interruption without buffered fallback or duplicate tools", async () => {
  let streamCalls = 0;
  const deltas: string[] = [];
  const retries: number[] = [];
  let toolCalls = 0;
  const agent = new ReactAgent({
    model: "stream-retry-test",
    client: {
      responses: {
        async create() { throw new Error("buffered fallback is not allowed"); },
        async *stream() {
          streamCalls += 1;
          yield { type: "response.output_text.delta", delta: "partial" };
          if (streamCalls === 1) {
            throw Object.assign(new Error("connection dropped"), { name: "APIConnectionError" });
          }
          yield { type: "response.completed", response: { id: "complete", output: [], output_text: "complete" } };
        },
      },
    },
    onEvent(event) {
      if (event.type === "retrying") retries.push(event.attempt);
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { toolCalls += 1; return bashResult("unexpected"); },
      writeAssistantDelta(text) { deltas.push(text); },
      writeAssistant() {},
    },
  });

  await agent.runTurn("retry");
  assert.equal(streamCalls, 2);
  assert.deepEqual(retries, [1]);
  assert.deepEqual(deltas, ["partial", "partial"]);
  assert.equal(toolCalls, 0);
});

test("agent rejects a clean stream EOF without response.completed", async () => {
  let streamCalls = 0;
  const retries: number[] = [];
  const agent = new ReactAgent({
    model: "stream-eof-test",
    client: {
      responses: {
        async create() { throw new Error("buffered fallback is not allowed"); },
        async *stream() {
          streamCalls += 1;
          yield { type: "response.output_text.delta", delta: "partial" };
        },
      },
    },
    onEvent(event) {
      if (event.type === "retrying") retries.push(event.attempt);
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });

  await assert.rejects(agent.runTurn("eof"), /response\.completed/);
  assert.equal(streamCalls, 3);
  assert.deepEqual(retries, [1, 2]);
});

test("agent stops a stream that emits no events before the idle deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  let iteratorClosed = false;
  let nextSettled = false;
  const agent = new ReactAgent({
    model: "stream-idle-test",
    samplingRetryBudget: 0,
    streamIdleTimeoutMs: 5,
    client: {
      responses: {
        async create() { throw new Error("buffered fallback is not allowed"); },
        stream(_params, options) {
          requestSignal = options?.signal;
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
                  const close = () => { nextSettled = true; resolve({ done: true, value: undefined }); };
                  if (requestSignal?.aborted) close();
                  else requestSignal?.addEventListener("abort", close, { once: true });
                }),
                async return() {
                  iteratorClosed = true;
                  return { done: true, value: undefined };
                },
              };
            },
          };
        },
      },
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await assert.rejects(agent.runTurn("wait"), /idle for 5ms/u);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(iteratorClosed, true);
  assert.equal(nextSettled, true);
});

test("agent compacts once and retries after a context-limit response error", async () => {
  let createCalls = 0;
  let compactCalls = 0;
  const compactEvents: string[] = [];
  const inputs: Array<Array<Record<string, unknown>>> = [];
  const compacted = [{ type: "compaction", encrypted_content: "opaque" }];
  const agent = new ReactAgent({
    model: "context-recovery-test",
    client: {
      responses: {
        async create(params) {
          createCalls += 1;
          inputs.push(params.input as Array<Record<string, unknown>>);
          if (createCalls === 1) {
            throw Object.assign(new Error("maximum context length is 100"), {
              status: 400,
              code: "context_length_exceeded",
            });
          }
          return { id: "recovered", output_text: "recovered", output: [] };
        },
        async compact() {
          compactCalls += 1;
          return { output: compacted, usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } };
        },
      },
    },
    onEvent(event) {
      if (event.type === "compaction_started") compactEvents.push("started");
      if (event.type === "compaction_completed") compactEvents.push("completed");
    },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });

  await agent.runTurn("recover");
  assert.equal(createCalls, 2);
  assert.equal(compactCalls, 1);
  assert.deepEqual(compactEvents, ["started", "completed"]);
  assert.equal(inputs[1]?.[0]?.type, "compaction");
});

test("agent does not compact ordinary bad requests or retry a second context failure", async () => {
  let createCalls = 0;
  let compactCalls = 0;
  const ordinary = new ReactAgent({
    model: "ordinary-error-test",
    client: { responses: {
      async create() {
        throw Object.assign(new Error("invalid request"), { status: 400, code: "invalid_request" });
      },
      async compact() { compactCalls += 1; return { output: [] }; },
    } },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await assert.rejects(ordinary.runTurn("bad"), /invalid request/);
  assert.equal(compactCalls, 0);

  const repeated = new ReactAgent({
    model: "repeated-context-test",
    client: { responses: {
      async create() {
        createCalls += 1;
        throw Object.assign(new Error("maximum context length"), { status: 400, code: "context_length_exceeded" });
      },
      async compact() { compactCalls += 1; return { output: [{ type: "compaction" }] }; },
    } },
    io: { async confirmBash() { return true; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await assert.rejects(repeated.runTurn("again"), /maximum context length/);
  assert.equal(createCalls, 2);
  assert.equal(compactCalls, 1);
});

test("agent applies guidance by stopping sampling and continuing with durable context", async () => {
  let request = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const inputs: Array<Record<string, unknown>[]> = [];
  const agent = new ReactAgent({
    model: "steering-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream(params, options) {
          inputs.push(params.input as Record<string, unknown>[]);
          request++;
          if (request === 1) {
            started();
            await new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
            });
          }
          yield { type: "response.completed", response: { id: `response-${request}`, output: [], output_text: "corrected" } };
        },
      },
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });
  const turn = agent.runTurn("start");
  await ready;
  assert.equal(agent.requestSteering("use the safer approach"), true);
  await turn;
  assert.ok(inputs[1]?.some((item) => item.role === "user" && item.content === "use the safer approach"));
});

test("guidance submitted before Ctrl+C is checkpointed for the next turn", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let request = 0;
  let nextInput: Record<string, unknown>[] = [];
  const agent = new ReactAgent({
    model: "steering-cancel-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream(params, options) {
          request++;
          if (request === 1) {
            started();
            await new Promise<never>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
            });
          }
          nextInput = params.input as Record<string, unknown>[];
          yield { type: "response.completed", response: { id: "done", output: [], output_text: "done" } };
        },
      },
    },
    io: {
      async confirmBash() { return true; },
      async runBash() { return bashResult(""); },
      writeAssistant() {},
    },
  });
  const turn = agent.runTurn("start", controller.signal);
  await ready;
  agent.requestSteering("keep the correction");
  controller.abort();
  await assert.rejects(turn, /abort/i);
  await agent.runTurn("continue");
  assert.ok(nextInput.some((item) => item.role === "user" && item.content === "keep the correction"));
});

test("provider stream recovery resumes only after an interrupted response", async () => {
  let streamCalls = 0;
  let recoveryCalls = 0;
  const events: string[] = [];
  const agent = new ReactAgent({
    model: "recovery-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream() {
          streamCalls += 1;
          yield { id: "event-1", type: "response.output_text.delta", delta: "partial" };
          throw new Error("connection dropped");
        },
        recovery: {
          async resume(_params, state) {
            recoveryCalls += 1;
            assert.equal(state.lastEventId, "event-1");
            return { id: "recovered", output_text: "complete", output: [], status: "completed" };
          },
        },
      },
    },
    streamRecoveryBudget: 1,
    onEvent(event) {
      if (event.type === "stream_recovery_started") events.push("started");
      if (event.type === "stream_recovery_finished") events.push(event.success === false ? "failed" : "finished");
    },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await agent.runTurn("resume");
  assert.equal(streamCalls, 1);
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(events, ["started", "finished"]);
});

test("recovery failure consumes its budget and falls back to bounded sampling retry", async () => {
  let streamCalls = 0;
  let recoveryCalls = 0;
  const agent = new ReactAgent({
    model: "recovery-failure-test",
    client: {
      responses: {
        async create() { throw new Error("buffered path should not be used"); },
        async *stream() {
          streamCalls += 1;
          yield { id: `event-${streamCalls}`, type: "response.output_text.delta", delta: "partial" };
          throw new Error("connection dropped");
        },
        recovery: {
          async resume() {
            recoveryCalls += 1;
            throw new Error("resume unavailable");
          },
        },
      },
    },
    streamRecoveryBudget: 1,
    samplingRetryBudget: 1,
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await assert.rejects(agent.runTurn("resume"), /resume unavailable|response\.completed/);
  assert.equal(recoveryCalls, 1);
  assert.equal(streamCalls, 2);
});

test("parallel tool calls are opt-in and only change the request flag when enabled", async () => {
  const seen: boolean[] = [];
  const makeAgent = (parallelToolCalls?: boolean) => new ReactAgent({
    model: "parallel-flag-test",
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    client: { responses: {
      async create(params) {
        seen.push(params.parallel_tool_calls as boolean);
        return { id: "done", output_text: "done", output: [] };
      },
    } },
    io: { async confirmBash() { return false; }, async runBash() { return bashResult(""); }, writeAssistant() {} },
  });
  await makeAgent().runTurn("serial");
  await makeAgent(true).runTurn("parallel");
  assert.deepEqual(seen, [false, true]);
});
