import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, type ToolCall, type AgentLoopOptions } from "../../../src/agent/agent-loop.js";
import { ReactAgent, type AgentResponse, type AgentIO } from "../../../src/agent/react-agent.js";
import { repairToolContext } from "../../../src/agent/repair-context.js";
import { GoalRuntime } from "../../../src/goal/runtime.js";
import { PersistenceError } from "../../../src/storage/persistence-error.js";
import type { SessionGoal } from "../../../src/storage/session-store.js";

const call = (id: string, name = "read_file", args: unknown = {}): ToolCall => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) });
const response = (output: ToolCall[] = []): AgentResponse => ({ id: "response", output, output_text: "" });
const io: AgentIO = {
  confirmBash: async () => true,
  runBash: async () => ({ stdout: "", stderr: "", exitCode: 0, signal: null }),
  writeAssistant() {},
};
const loop = (overrides: Partial<AgentLoopOptions>): AgentLoopOptions => ({
  sample: async () => response(), record: async () => {}, dispatch: async () => "ok", assistant() {}, ...overrides,
});

test("assistant delivery blocks tools and the next sample until output drains", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  let samples = 0;
  const running = runAgentLoop(loop({
    sample: async () => {
      order.push("sample");
      return samples++ === 0 ? { ...response([call("one")]), output_text: "large answer" } : response();
    },
    assistant: async () => { order.push("assistant"); await blocked; },
    dispatch: async () => { order.push("dispatch"); return "ok"; },
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["sample", "assistant"]);
  release();
  await running;
  assert.deepEqual(order, ["sample", "assistant", "dispatch", "sample"]);
});

test("assistant output failure closes durable calls without dispatch or retry", async () => {
  const recorded: Record<string, unknown>[] = [];
  const failure = new Error("output closed");
  let samples = 0;
  await assert.rejects(runAgentLoop(loop({
    sample: async () => { samples++; return { ...response([call("one"), call("two")]), output_text: "answer" }; },
    record: async (items) => { recorded.push(...items); },
    assistant: async () => { throw failure; },
    dispatch: async () => { assert.fail("output failure must prevent dispatch"); },
  })), (error) => error === failure);
  assert.equal(samples, 1);
  assert.deepEqual(recorded.filter((item) => item.type === "function_call_output").map((item) => item.call_id), ["one", "two"]);
  for (const item of recorded.filter((item) => item.type === "function_call_output")) {
    assert.equal(JSON.parse(item.output as string).reason, "output_delivery_failed");
  }
});

test("tool delivery failure preserves the committed result and closes remaining calls", async () => {
  const recorded: Record<string, unknown>[] = [];
  const failure = new Error("tool delivery failed");
  const dispatched: string[] = [];
  await assert.rejects(runAgentLoop(loop({
    sample: async () => response([call("one"), call("two")]),
    record: async (items) => { recorded.push(...items); },
    dispatch: async (item) => { dispatched.push(item.call_id); return "completed"; },
    onToolEvent: async (event) => { if (event.type === "tool_finished") throw failure; },
  })), (error) => error === failure);
  assert.deepEqual(dispatched, ["one"]);
  const outputs = recorded.filter((item) => item.type === "function_call_output");
  assert.deepEqual(outputs.map((item) => item.call_id), ["one", "two"]);
  assert.equal(outputs[0]?.output, "completed");
  assert.equal(JSON.parse(outputs[1]?.output as string).status, "skipped");
});

async function goalFixture() {
  let goal: SessionGoal | undefined;
  const runtime = new GoalRuntime({ getGoal: async () => goal, setGoal: async (value) => { goal = value; } });
  await runtime.create({ objective: "bounded work", tokenBudget: 3 });
  return { runtime, get: () => goal! };
}

test("invalid loop and adapter budgets are rejected before requests", async () => {
  for (const value of [NaN, Infinity, -1, 1.5]) {
    for (const key of ["maxSteps", "maxParallelTools", "maxRetries"] as const) {
      await assert.rejects(runAgentLoop(loop({ [key]: value })), RangeError);
    }
    for (const key of ["maxSteps", "maxParallelTools", "samplingRetryBudget", "streamRecoveryBudget", "contextRecoveryBudget", "recoveryCacheMaxBytes"] as const) {
      assert.throws(() => new ReactAgent({ model: "test", io, client: { responses: { create: async () => response() } }, [key]: value }), RangeError);
    }
  }
});

test("response-boundary guidance consumes steps and refreshes snapshots", async () => {
  let samples = 0, prepared = 0, pending = false;
  const result = await runAgentLoop(loop({
    maxSteps: 2,
    prepareStep: async () => { prepared++; },
    sample: async () => { samples++; return response(); },
    onEvent(event) { if (event.type === "response_received") pending = true; },
    hasPendingSteering: () => pending,
    applySteering: async () => { pending = false; return 1; },
  }));
  assert.equal(result.stopReason, "step_limit");
  assert.equal(samples, 2);
  assert.equal(prepared, 2);
});

test("turn deadlines stop sampling and expose a structured reason", async () => {
  let requests = 0;
  const result = await runAgentLoop(loop({
    maxTurnDurationMs: 10,
    sample: async (signal) => {
      requests += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1_000);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
      return response();
    },
  }));
  assert.equal(requests, 1);
  assert.equal(result.stopReason, "deadline_exceeded");
  assert.equal(result.steps, 1);
});

test("parallel reads use a sliding bounded window without waiting for the whole first group", async () => {
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  let requests = 0;
  const turn = runAgentLoop(loop({
    maxParallelTools: 2,
    sample: async () => ++requests === 1 ? response([call("a"), call("b"), call("c")]) : response(),
    canRunInParallel: () => true,
    dispatch: async (tool) => {
      started.push(tool.call_id);
      if (tool.call_id === "a" || tool.call_id === "b") {
        await new Promise<void>((resolve) => gates.set(tool.call_id, resolve));
      }
      return tool.call_id;
    },
  }));
  for (let attempt = 0; attempt < 20 && started.length < 2; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b"]);
  assert.equal(started.includes("c"), false);
  gates.get("b")?.();
  for (let attempt = 0; attempt < 20 && !started.includes("c"); attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b", "c"]);
  gates.get("a")?.();
  await turn;
});

test("Plan rejects unadvertised side-effect tools in buffered and SSE responses", async () => {
  for (const stream of [false, true]) {
    let samples = 0, mutations = 0;
    const outputs: Record<string, unknown>[] = [];
    const fixture = await goalFixture();
    const next = () => ({ ...(++samples === 1 ? response([
      call("patch", "apply_patch", { operations: [{ path: "mock.txt", action: "create", content: "mock" }] }),
      call("shell", "bash", { command: "mock" }),
      call("goal", "update_goal", { status: "complete" }),
      call("create", "create_goal", { objective: "unadvertised" }),
      call("mcp", "mcp__server__write"),
    ]) : response()), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
    const agent = new ReactAgent({ model: "test", goalRuntime: fixture.runtime,
      client: { responses: { create: async () => next(), ...(stream ? { async *stream() { yield { type: "response.completed", response: next() }; } } : {}) } },
      io: { ...io, runBash: async () => { mutations++; return io.runBash("mock"); }, runApplyPatch: async () => { mutations++; return { status: "applied", files: [], diffSummary: "" }; }, confirmGoal: async () => { mutations++; return true; } },
      onHistoryAppend: async (items) => { outputs.push(...items); },
    });
    await agent.runTurn("plan only", undefined, { mode: "plan" });
    assert.equal(mutations, 0);
    assert.equal(fixture.get().status, "active");
    const results = outputs.filter((item) => item.type === "function_call_output");
    assert.equal(results.length, 5);
    assert.ok(results.every((item) => JSON.parse(String(item.output)).status === "denied"));
  }
});

test("steering closes calls before user input and resumes with a new skill snapshot", async () => {
  let agent: ReactAgent, requests = 0;
  const history: Record<string, unknown>[] = [], skillInputs: string[] = [];
  agent = new ReactAgent({ model: "test", io, client: { responses: { create: async () => ++requests === 1 ? response([call("a", "bash", { command: "mock" })]) : response() } },
    skills: { prepareTurn: async (input) => { skillInputs.push(input); return { instructions: "", explicitInstructions: "", skills: [], explicitNames: [], errors: [], conflictedNames: [] }; }, read: async () => "" },
    onHistoryAppend: async (items) => {
      history.push(...items);
      if (items.some((item) => item.type === "function_call")) agent.requestSteering("use $new-skill");
    },
  });
  await agent.runTurn("start");
  const interaction = history.filter((item) => !(
    item.type === "message"
    && item.role === "developer"
    && String(item.content).startsWith("Host-maintained project rule snapshot revision ")
  ));
  assert.deepEqual(interaction.map((item) => item.type ?? item.role), ["user", "function_call", "function_call_output", "user"]);
  assert.deepEqual(repairToolContext(history), history);
  assert.deepEqual(skillInputs, ["start", "start\nuse $new-skill"]);
});

test("guidance received during final assistant delivery prevents premature completion", async () => {
  let agent: ReactAgent, requests = 0;
  agent = new ReactAgent({ model: "test", client: { responses: { create: async (params) => {
    requests++;
    if (requests === 2) assert.match(JSON.stringify(params.input), /one more thing/);
    return { ...response(), output_text: "answer" };
  } } }, io: { ...io, writeAssistant() { if (requests === 1) agent.requestSteering("one more thing"); } } });
  await agent.runTurn("start");
  assert.equal(requests, 2);
});

test("usage and Goal persistence failures cannot retry sampling or execute tools", async () => {
  for (const failGoal of [false, true]) {
    let requests = 0, writes = 0, executions = 0;
    const fixture = await goalFixture();
    const runtime = failGoal ? new GoalRuntime({ getGoal: async () => fixture.get(), setGoal: async () => { writes++; throw new Error("network storage timeout"); } }) : undefined;
    const agent = new ReactAgent({ model: "test", ...(runtime ? { goalRuntime: runtime } : {}), client: { responses: { create: async () => { requests++; return { ...response([call("s", "bash", { command: "mock" })]), usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }; } } },
      io: { ...io, runBash: async () => { executions++; return io.runBash("mock"); } },
      ...(!failGoal ? { onUsage: async () => { writes++; throw new Error("network storage timeout"); } } : {}),
    });
    await assert.rejects(agent.runTurn("start"), PersistenceError);
    assert.equal(requests, 1); assert.equal(writes, 1); assert.equal(executions, 0);
  }
});

test("budget and unknown usage stop before tools, retries, and false completion", async () => {
  for (const usage of [{ input_tokens: 2, output_tokens: 1, total_tokens: 3 }, undefined]) {
    for (const failed of [false, true]) {
      const fixture = await goalFixture();
      let requests = 0, executed = 0;
      const records: Record<string, unknown>[] = [], phases: string[] = [];
      const agent = new ReactAgent({ model: "test", goalRuntime: fixture.runtime,
        client: { responses: { create: async () => { requests++; return { ...response([call("s", "bash", { command: "mock" })]), ...(usage ? { usage } : {}), ...(failed ? { status: "failed", error: { code: "server_error" } } : {}) }; } } },
        io: { ...io, runBash: async () => { executed++; return io.runBash("mock"); } },
        onHistoryAppend: async (items) => { records.push(...items); }, onPhase: (phase) => { phases.push(phase); },
      });
      const result = await agent.runTurn("start");
      assert.equal(result.stopReason, usage ? "budget_limited" : "usage_limited");
      assert.equal(requests, 1); assert.equal(executed, 0);
      assert.ok(!phases.includes("completed"));
      if (!failed) assert.match(String(records.find((item) => item.type === "function_call_output")?.output), /skipped/);
      assert.equal(fixture.get().tokens_used, usage?.total_tokens ?? 0);
    }
  }
});

test("MCP hints never parallelize approval or dispatch", async () => {
  let requests = 0, active = 0, peak = 0;
  const names = ["mcp__a__read", "mcp__b__read"];
  const agent = new ReactAgent({ model: "test", parallelToolCalls: true, parallelReadTools: true,
    client: { responses: { create: async () => ++requests === 1 ? response(names.map((name, index) => call(String(index), name))) : response() } },
    mcp: {
      ensureReady: async () => ({ tools: names.map((name) => ({ type: "function", name, description: "read", parameters: { type: "object" } })), instructions: "", servers: [] }),
      toolInfo: (name) => ({ callableName: name, serverName: name, toolName: "read", annotations: { readOnlyHint: true, idempotentHint: true } }),
      call: async () => "ok",
    },
    io: { ...io, confirmMcp: async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return true; } },
  });
  await agent.runTurn("read");
  assert.equal(peak, 1);
});

test("Agent catalog parallelizes local reads but keeps MCP as an ordered barrier", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "everpeace-step-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.txt"), "first file");
  await writeFile(join(root, "b.txt"), "second file");
  let requests = 0, active = 0, peak = 0;
  const name = "mcp__fixture__read";
  const order: string[] = [], recorded: Record<string, unknown>[] = [];
  const agent = new ReactAgent({
    workspacePath: root, model: "offline", parallelReadTools: true, maxParallelTools: 2,
    client: { responses: { async create() {
      return ++requests === 1 ? response([
        call("a", "read_file", { path: "a.txt" }),
        call("b", "read_file", { path: "b.txt" }),
        call("mcp", name),
        call("c", "read_file", { path: "a.txt" }),
      ]) : response();
    } } },
    io: { ...io, getPermissions: () => ({ mode: "full-access", web: false }) },
    mcp: {
      async ensureReady() {
        return { tools: [{ type: "function", name, description: "fixture", parameters: { type: "object" } }],
          toolInfo: [{ callableName: name, serverName: "fixture", toolName: "read", binding: "step-binding" }], instructions: "", servers: [] };
      },
      toolInfo() { throw new Error("Live metadata lookup is forbidden"); },
      async call(_name, _args, binding) {
        assert.equal(active, 1);
        assert.equal(binding, "step-binding");
        return "MCP complete";
      },
    },
    async onToolEvent(event) {
      if (event.type === "tool_started") {
        active++;
        peak = Math.max(peak, active);
        order.push(event.call.call_id);
        if (event.call.name === "read_file") await new Promise<void>((resolve) => setImmediate(resolve));
      } else active--;
    },
    async onHistoryAppend(items) { recorded.push(...items); },
  });
  t.after(() => agent.dispose());
  await agent.runTurn("Inspect both files, call MCP, then inspect again.");
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(order, ["a", "b", "mcp", "c"]);
  const results = recorded.filter((item) => item.type === "function_call_output");
  assert.deepEqual(results.map((item) => item.call_id), order);
  assert.match(String(results[0]?.output), /first file/u);
  assert.match(String(results[1]?.output), /second file/u);
  assert.equal(requests, 2);
});

test("failed step preparation cannot sample and its catalog cannot authorize a later turn", async () => {
  let preparations = 0, requests = 0, executed = 0;
  const name = "mcp__fixture__read";
  const recorded: Record<string, unknown>[] = [];
  const agent = new ReactAgent({ model: "offline", io: { ...io, getPermissions: () => ({ mode: "full-access", web: false }) },
    client: { responses: { async create(params) {
      requests++;
      if (requests === 1) return response([call("original", name)]);
      assert.equal((params.tools as Array<{ name: string }>).some((tool) => tool.name === name), false);
      return requests === 2 ? response([call("late", name)]) : response();
    } } },
    mcp: {
      async ensureReady() {
        if (++preparations === 2) throw new Error("Catalog source failed");
        return { tools: preparations === 1 ? [{ type: "function", name, description: "fixture", parameters: { type: "object" } }] : [],
          toolInfo: [{ callableName: name, serverName: "fixture", toolName: "read", binding: "old-binding" }], instructions: "", servers: [] };
      },
      toolInfo() { throw new Error("Live metadata lookup is forbidden"); },
      async call() { executed++; return "original result"; },
    },
    async onHistoryAppend(items) { recorded.push(...items); },
  });
  try {
    await assert.rejects(agent.runTurn("first task"), /Catalog source failed/u);
    assert.equal(requests, 1);
    assert.equal(executed, 1);
    await agent.runTurn("new task");
    assert.equal(executed, 1);
    assert.equal(requests, 3);
    assert.match(String(recorded.find((item) => item.type === "function_call_output" && item.call_id === "late")?.output), /TOOL_UNAVAILABLE/u);
  } finally { await agent.dispose(); }
});

test("parallel reads are bounded, ordered and cannot cross a write", async () => {
  let requests = 0, active = 0, peak = 0;
  const records: string[] = [], started: string[] = [];
  let releaseFirstPair!: () => void;
  const firstPair = new Promise<void>((resolve) => { releaseFirstPair = resolve; });
  await runAgentLoop(loop({ maxParallelTools: 2,
    sample: async () => ++requests === 1 ? response([call("a"), call("b"), call("c"), call("w", "write"), call("d")]) : response(),
    toolCapabilities: (tool) => ({ readOnly: tool.name !== "write", idempotent: true, parallelSafe: true, resourceKeys: [] }),
    dispatch: async (tool) => {
      started.push(tool.call_id);
      active++;
      peak = Math.max(peak, active);
      if (tool.name === "write") assert.equal(active, 1);
      if (tool.call_id === "a" || tool.call_id === "b") {
        if (active === 2) releaseFirstPair();
        await firstPair;
      }
      active--;
      return tool.call_id;
    },
    record: async (items) => { for (const item of items) if (item.type === "function_call_output") records.push(String(item.call_id)); },
  }));
  assert.equal(peak, 2);
  assert.deepEqual(started, ["a", "b", "c", "w", "d"]);
  assert.deepEqual(records, started);
});

test("cancellation closes later calls without starting another parallel batch", async () => {
  const controller = new AbortController();
  const started: string[] = [], records: Record<string, unknown>[] = [];
  await assert.rejects(runAgentLoop(loop({ signal: controller.signal, maxParallelTools: 2,
    sample: async () => response([call("a"), call("b"), call("c")]), canRunInParallel: () => true,
    dispatch: async (tool) => { started.push(tool.call_id); await Promise.resolve(); controller.abort(); return "done"; },
    record: async (items) => { records.push(...items); },
  })), /abort/i);
  assert.deepEqual(started, ["a"]);
  assert.match(String(records.find((item) => item.type === "function_call_output" && item.call_id === "b")?.output), /cancelled/);
  assert.match(String(records.find((item) => item.type === "function_call_output" && item.call_id === "c")?.output), /cancelled/);
});

test("workflow persistence failure after a patch cannot become a repairable tool result", async () => {
  let requests = 0, patches = 0;
  const agent = new ReactAgent({ model: "test", client: { responses: { create: async () => { requests++; return response([call("p", "apply_patch", { operations: [{ path: "mock", action: "create", content: "mock" }] }), call("s", "bash", { command: "mock" })]); } } },
    io: { ...io, runApplyPatch: async () => { patches++; return { status: "applied", files: [], diffSummary: "" }; }, afterPatchApplied: async () => { throw new Error("network workflow storage unavailable"); }, runBash: async () => { assert.fail("later shell must not run"); } },
  });
  await assert.rejects(agent.runTurn("patch"), PersistenceError);
  assert.equal(requests, 1); assert.equal(patches, 1);
});

test("automatic compaction occurs once across a sampling retry and leaves occupancy unknown", async () => {
  let compacts = 0, requests = 0, starts = 0;
  const agent = new ReactAgent({ model: "test", contextWindow: 100, initialContextTokens: 90, initialHistory: [{ role: "user", content: "old" }], io,
    client: { responses: {
      compact: async () => { compacts++; return { output: [{ type: "compaction", encrypted_content: "opaque" }], usage: { input_tokens: 90, output_tokens: 5, total_tokens: 95 } }; },
      create: async () => { requests++; if (requests === 1) throw Object.assign(new Error("temporary"), { status: 503 }); return response(); },
    } }, onEvent: (event) => { if (event.type === "sampling_started") starts++; },
  });
  await agent.runTurn("start");
  await agent.runTurn("next");
  assert.equal(compacts, 1); assert.equal(requests, 3); assert.equal(starts, 3);
});

test("recovery cache overflow falls back to whole-request retry without truncating successful responses", async () => {
  for (const complete of [false, true]) {
    let requests = 0, resumes = 0;
    const text = "x".repeat(100);
    const answers: string[] = [];
    const agent = new ReactAgent({ model: "test", recoveryCacheMaxBytes: 16, io: { ...io, writeAssistant: (answer) => { answers.push(answer); } },
      client: { responses: {
        create: async () => { assert.fail("no buffered fallback"); },
        async *stream() {
          requests++;
          yield { type: "response.output_text.delta", delta: text };
          if (complete || requests > 1) yield { type: "response.completed", response: { ...response(), output_text: text } };
        },
        recovery: { resume: async () => { resumes++; return response(); } },
      } },
    });
    await agent.runTurn("start");
    assert.equal(resumes, 0); assert.equal(requests, complete ? 1 : 2); assert.deepEqual(answers, [text]);
  }
});

test("retry snapshot is isolated from provider mutation and refreshed after tool follow-up", async () => {
  let requests = 0, prepared = 0;
  const definition = { type: "function" as const, name: "mcp__a__read", description: "original", parameters: { type: "object" } };
  const agent = new ReactAgent({ model: "test", io: { ...io, confirmMcp: async () => true },
    mcp: { ensureReady: async () => { prepared++; return { tools: [definition], instructions: "", servers: [] }; }, toolInfo: (name) => ({ callableName: name, serverName: "a", toolName: "read" }), call: async () => "ok" },
    client: { responses: { create: async (params) => {
      requests++;
      const advertised = (params.tools as typeof definition[]).find((item) => item.name === definition.name)!;
      if (requests === 1) { definition.description = "new"; advertised.description = "mutated"; throw Object.assign(new Error("temporary"), { status: 503 }); }
      assert.equal(advertised.description, requests === 2 ? "original" : "new");
      return requests === 2 ? response([call("m", definition.name)]) : response();
    } } },
  });
  await agent.runTurn("read");
  assert.equal(prepared, 2); assert.equal(requests, 3);
});

test("tool result persistence failure prevents subsequent dispatch and sampling", async () => {
  let samples = 0;
  const executed: string[] = [];
  await assert.rejects(runAgentLoop(loop({
    sample: async () => { samples++; return response([call("a"), call("b")]); },
    record: async (items) => { if (items.some((item) => item.type === "function_call_output")) throw new PersistenceError("save", new Error("network timeout")); },
    dispatch: async (tool) => { executed.push(tool.call_id); return "ok"; },
  })), PersistenceError);
  assert.equal(samples, 1); assert.deepEqual(executed, ["a"]);
});

test("guidance during a parallel batch closes unstarted calls before the user message", async () => {
  const history: Record<string, unknown>[] = [], started: string[] = [];
  let pending = false, samples = 0;
  await runAgentLoop(loop({ maxParallelTools: 2,
    sample: async () => ++samples === 1 ? response([call("a"), call("b"), call("c")]) : response(),
    canRunInParallel: () => true,
    dispatch: async (tool) => { started.push(tool.call_id); pending = true; return "ok"; },
    record: async (items) => { history.push(...items); },
    hasPendingSteering: () => pending,
    applySteering: async () => { pending = false; history.push({ role: "user", content: "correction" }); return 1; },
  }));
  assert.deepEqual(started, ["a"]);
  assert.deepEqual(repairToolContext(history), history);
  assert.equal(history.at(-1)?.role, "user");
  assert.match(String(history.find((item) => item.type === "function_call_output" && item.call_id === "c")?.output), /steered/);
});

test("failed guidance persistence leaves accepted messages pending for recovery", async () => {
  let agent: ReactAgent, requests = 0, fail = true;
  const history: Record<string, unknown>[] = [];
  agent = new ReactAgent({ model: "test", io,
    client: { responses: { create: async () => { requests++; return { ...response(), output_text: "done" }; } } },
    onHistoryAppend: async (items) => {
      if (fail && items.some((item) => item.content === "correction")) throw new Error("disk full");
      history.push(...items);
    },
    onEvent(event) { if (event.type === "response_received" && requests === 1) agent.requestSteering("correction"); },
  });
  await assert.rejects(agent.runTurn("start"), PersistenceError);
  fail = false;
  await agent.runTurn("retry after storage recovery");
  assert.deepEqual(history.filter((item) => item.role === "user").map((item) => item.content), ["start", "correction", "retry after storage recovery"]);
});

test("compaction usage and an unknown failed request both stop a bounded goal", async () => {
  for (const recovery of [false, true]) {
    const fixture = await goalFixture();
    let requests = 0, compacts = 0;
    const agent = new ReactAgent({ model: "test", goalRuntime: fixture.runtime, contextWindow: 100,
      initialContextTokens: recovery ? 0 : 90, initialHistory: [{ role: "user", content: "old" }], io,
      client: { responses: {
        compact: async () => { compacts++; return { output: [{ type: "compaction", encrypted_content: "opaque" }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }; },
        create: async () => { requests++; throw Object.assign(new Error("maximum context length exceeded"), { status: 400 }); },
      } },
    });
    assert.equal((await agent.runTurn("start")).stopReason, recovery ? "usage_limited" : "budget_limited");
    assert.equal(compacts, recovery ? 0 : 1); assert.equal(requests, recovery ? 1 : 0);
  }
});

test("streams without a recovery adapter do not serialize a redundant event log", async () => {
  const agent = new ReactAgent({ model: "test", io, client: { responses: {
    create: async () => response(),
    async *stream() {
      yield { type: "response.output_text.delta", delta: "hello", toJSON() { throw new Error("event log must not be serialized"); } };
      yield { type: "response.completed", response: { ...response(), output_text: "hello" } };
    },
  } } });
  await agent.runTurn("start");
});
