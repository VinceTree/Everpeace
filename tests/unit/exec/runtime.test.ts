import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentResponse } from "../../../src/agent/react-agent.js";
import { deterministicExecTitle, runExec, selectExecModel } from "../../../src/exec/runtime.js";
import type { ExecDependencies, ExecEvent } from "../../../src/exec/types.js";
import type { PermissionPolicy } from "../../../src/permissions/policy.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { createProductionAgent } from "../../../src/runtime/production.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import type { BashResult } from "../../../src/tools/bash.js";
import { McpRuntime } from "../../../src/mcp/runtime.js";
import { McpTrustStore } from "../../../src/mcp/trust.js";
import { MemoryAuthStorage } from "../../fixtures/mcp-trust.js";

test("headless startup trust requires interaction before any model request, including Plan and full-access", async (t) => {
  for (const transport of ["stdio", "http"] as const) for (const plan of [false, true]) {
    const provider = fakeProvider(() => { throw new Error("Model must not be called before startup trust"); });
    const f = await fixture(provider, { mode: "full-access", web: true }); t.after(() => f.cleanup());
    const mcp = new McpRuntime({ workspacePath: f.workspacePath, trustStore: new McpTrustStore({ path: path.join(f.root, "trust.json"), authStorage: new MemoryAuthStorage() }), async loadConfig() {
      return [{ name: "untrusted", enabled: true, transport: transport === "stdio" ? { type: "stdio", command: process.execPath, args: ["-e", "throw new Error('must not start')"] } : { type: "streamable_http", url: "http://127.0.0.1:1/mcp" } }];
    } }); t.after(() => mcp.close());
    f.dependencies.createAgent = (options) => createProductionAgent({ ...options, providerRuntime: provider, mcp, skills: null, learnedMemoryStore: null, codeNavigation: null });
    const events: ExecEvent[] = [];
    const result = await runExec({ prompt: "inspect", workspacePath: f.workspacePath, plan, onEvent(event) { events.push(event); } }, f.dependencies);
    assert.equal(result.classification, "interaction_required"); assert.equal(result.exitCode, 5);
    assert.equal(result.interaction?.tool, transport === "stdio" ? "mcp_start" : "mcp_http"); assert.equal(provider.calls, 0);
    assert.ok(events.some((event) => event.type === "interaction_required"));
    assert.equal(mcp.snapshot().tools.length, 0);
  }
});

const model = {
  id: "registration-1",
  model_name: "offline-model",
  base_url: "https://compatible.invalid/v1",
  api_key: "fixture-key",
};

function response(
  id: string,
  output: Array<Record<string, unknown> & { type: string }> = [],
  outputText = "",
  usage: Record<string, number> | undefined = { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
): AgentResponse {
  return {
    id,
    status: "completed",
    output,
    output_text: outputText,
    ...(usage === undefined ? {} : { usage }),
  };
}

function assistant(id: string, text: string, usage?: Record<string, number>): AgentResponse {
  return response(id, [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], text, usage);
}

function fakeProvider(
  next: (params: Record<string, unknown>, signal: AbortSignal | undefined, call: number) => Promise<AgentResponse> | AgentResponse,
): ProviderRuntime & { calls: number } {
  const capabilities = resolveProviderCapabilities(model.base_url, model.model_name);
  const runtime: ProviderRuntime & { calls: number } = {
    calls: 0,
    sdk: {} as ProviderRuntime["sdk"],
    capabilities,
    settings: defaultModelRequestSettings(capabilities),
    responses: {
      async create() { throw new Error("The buffered provider path must not run"); },
      async stream(params, options) {
        const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
        // Match the SDK: an abort may already have fired during async admission/storage.
        signal?.throwIfAborted();
        runtime.calls += 1;
        const completed = await next(params, signal, runtime.calls);
        return (async function* () {
          yield { type: "response.completed", response: completed };
        })();
      },
    },
  };
  return runtime;
}

async function fixture(provider: ProviderRuntime, policy: PermissionPolicy = { mode: "workspace-write", web: false }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-exec-"));
  const workspacePath = path.join(root, "workspace");
  await fs.mkdir(workspacePath);
  const sessionStore = new SessionStore({ directory: path.join(root, "sessions") });
  let observedPolicy: unknown;
  let observedMaxSteps: number | undefined;
  const dependencies: ExecDependencies = {
    registry: { async resolveAll() { return { available: [model], missing: [] }; } },
    sessionStore,
    async loadPermissionPolicy() { return policy; },
    createAgent(options: Parameters<typeof createProductionAgent>[0]) {
      observedPolicy = options.learnedMemoryPolicy;
      observedMaxSteps = options.maxSteps;
      return createProductionAgent({
        ...options,
        providerRuntime: provider,
        skills: null,
        mcp: null,
        learnedMemoryStore: null,
        codeNavigation: null,
      });
    },
  };
  return {
    root,
    workspacePath,
    sessionStore,
    dependencies,
    observed: () => ({ policy: observedPolicy, maxSteps: observedMaxSteps }),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function verificationResult(passed: boolean): BashResult {
  return {
    stdout: passed ? "verification passed\n" : "expected fixed content\n",
    stderr: "",
    exitCode: passed ? 0 : 1,
    signal: null,
  };
}

test("bounded exec preserves safe provider failure diagnostics without retrying or exposing error payloads", async () => {
  const provider = fakeProvider(() => {
    throw Object.assign(new Error("relay rejected fixture-key private-response-body"), {
      status: 403,
      headers: { authorization: "Bearer fixture-key" },
    });
  });
  const f = await fixture(provider);
  try {
    const events: ExecEvent[] = [];
    const result = await runExec({ prompt: "inspect", workspacePath: f.workspacePath, tokenBudget: 100,
      onEvent(event) { events.push(event); } }, f.dependencies);
    assert.equal(result.exitCode, 4);
    assert.equal(result.stopReason, "usage_limited");
    assert.equal(result.usageComplete, false);
    assert.equal(result.error, "Provider request failed (HTTP 403; permanent).");
    assert.equal(provider.calls, 1);
    const session = await f.sessionStore.load(result.sessionId!);
    const diagnostic = session.timeline.find((entry) => entry.kind === "system" && entry.text.includes("HTTP 403"));
    assert.ok(diagnostic);
    const serialized = JSON.stringify({ result, events, session });
    assert.ok(!serialized.includes("fixture-key"));
    assert.ok(!serialized.includes("private-response-body"));
  } finally { await f.cleanup(); }
});

test("exec selects registration IDs before unique model names and rejects ambiguous defaults", () => {
  const first = { ...model, id: "same", model_name: "shared" };
  const second = { ...model, id: "other", model_name: "shared" };
  const missing = {
    id: "missing-id",
    model_name: "shared-with-missing",
    base_url: model.base_url,
    auth_ref: "model:missing-id",
    created_at: "2026-10-02T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
  };
  const namedLikeMissingId = { ...model, id: "available-id", model_name: "missing-id" };
  const namedLikeMissingName = { ...model, id: "available-name", model_name: "shared-with-missing" };
  assert.equal(selectExecModel({ available: [first, second], missing: [] }, "same").model.id, "same");
  assert.throws(() => selectExecModel({ available: [first, second], missing: [] }, "shared"), /ambiguous/u);
  assert.throws(() => selectExecModel({ available: [first, second], missing: [] }), /Multiple models/u);
  assert.equal(selectExecModel({ available: [first], missing: [] }).selector, "only");
  assert.throws(
    () => selectExecModel({ available: [namedLikeMissingId], missing: [missing] }, "missing-id"),
    /no available credential/u,
  );
  assert.throws(
    () => selectExecModel({ available: [namedLikeMissingName], missing: [missing] }, "shared-with-missing"),
    /ambiguous/u,
  );
  assert.equal(deterministicExecTitle("  Fix the build\nwith details"), "Exec: Fix the build");
});

test("exec distinguishes startup configuration errors from Session persistence failures", async (t) => {
  await t.test("provider startup", async () => {
    const provider = fakeProvider(() => assistant("unused", "unused"));
    const testFixture = await fixture(provider);
    testFixture.dependencies.createAgent = () => { throw new Error("invalid provider configuration"); };
    try {
      const run = await runExec({ prompt: "work", workspacePath: testFixture.workspacePath }, testFixture.dependencies);
      assert.equal(run.exitCode, 2);
      assert.equal(run.classification, "configuration_error");
      assert.match(run.error ?? "", /invalid provider configuration/u);
    } finally { await testFixture.cleanup(); }
  });

  await t.test("Session create", async () => {
    const provider = fakeProvider(() => assistant("unused", "unused"));
    const testFixture = await fixture(provider);
    testFixture.sessionStore.create = async () => { throw new Error("session disk unavailable"); };
    try {
      const run = await runExec({ prompt: "work", workspacePath: testFixture.workspacePath }, testFixture.dependencies);
      assert.equal(run.exitCode, 1);
      assert.equal(run.classification, "runtime_error");
      assert.match(run.error ?? "", /session disk unavailable/u);
    } finally { await testFixture.cleanup(); }
  });
});

test("exec persists a normal Session and shares one workflow across verification repair", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const provider = fakeProvider((params, _signal, call) => {
    requests.push(params);
    if (call === 1) return response("create-broken", [{
      type: "function_call",
      name: "apply_patch",
      call_id: "patch-broken",
      arguments: JSON.stringify({ operations: [{ path: "result.txt", action: "create", content: "broken\n" }] }),
    }]);
    if (call === 2) return assistant("initial", "Initial implementation complete.");
    if (call === 3) return response("repair", [{
      type: "function_call",
      name: "apply_patch",
      call_id: "patch-fixed",
      arguments: JSON.stringify({ operations: [{ path: "result.txt", action: "update", content: "fixed\n" }] }),
    }]);
    if (call === 4) return assistant("fixed", "Repair verified.");
    throw new Error(`Unexpected provider call ${call}`);
  });
  const testFixture = await fixture(provider);
  const events: ExecEvent[] = [];
  let verifications = 0;
  testFixture.dependencies.createCommandExecutor = () => async () => {
    verifications += 1;
    const contents = await fs.readFile(path.join(testFixture.workspacePath, "result.txt"), "utf8");
    return verificationResult(contents === "fixed\n");
  };
  await fs.writeFile(path.join(testFixture.workspacePath, "package.json"), JSON.stringify({ scripts: { test: "node verify.mjs" } }), "utf8");
  try {
    const result = await runExec({
      prompt: "Fix result.txt and verify it",
      workspacePath: testFixture.workspacePath,
      maxSteps: 6,
      onEvent(event) { events.push(event); },
    }, testFixture.dependencies);
    assert.equal(result.exitCode, 0);
    assert.equal(result.classification, "success");
    assert.equal(result.workflowResult, "verified");
    assert.equal(result.assistantText, "Repair verified.");
    assert.equal(result.usage?.inputTokens, 8);
    assert.equal(result.usage?.outputTokens, 4);
    assert.equal(verifications, 2);
    assert.equal(provider.calls, 4);
    assert.match(JSON.stringify(requests[2]?.input), /Verification failed/u);
    assert.deepEqual(testFixture.observed(), {
      policy: { readExisting: true, captureFuture: false },
      maxSteps: 6,
    });
    assert.equal(await fs.readFile(path.join(testFixture.workspacePath, "result.txt"), "utf8"), "fixed\n");
    assert.ok(result.sessionId);
    const loaded = await testFixture.sessionStore.load(result.sessionId);
    assert.equal(loaded.summary.title, "Exec: Fix result.txt and verify it");
    assert.deepEqual(loaded.memoryPolicy, { readExisting: true, captureFuture: false });
    assert.equal(loaded.workflow?.result, "verified");
    assert.equal(loaded.workflow?.task_source, "exec");
    assert.match(JSON.stringify(loaded.context), /expected fixed content/u);
    assert.ok(events.findIndex((event) => event.type === "session_started") < events.findIndex((event) => event.type === "tool_started"));
    const workflowEvent = [...events].reverse().find((event) => event.type === "workflow_updated");
    assert.equal(workflowEvent?.type, "workflow_updated");
    if (workflowEvent?.type === "workflow_updated") {
      assert.equal(workflowEvent.result, "verified");
      assert.equal(workflowEvent.repairAttempts, 1);
      assert.equal(workflowEvent.maxRepairAttempts, 3);
      assert.equal(workflowEvent.pendingVerification, false);
      assert.deepEqual(workflowEvent.changedPaths, ["result.txt"]);
      assert.ok(workflowEvent.taskId);
    }
  } finally {
    await testFixture.cleanup();
  }
});

test("an explicit step limit is shared with automatic repair rounds", async () => {
  const provider = fakeProvider((_params, _signal, call) => {
    if (call === 1) return response("create-broken", [{
      type: "function_call",
      name: "apply_patch",
      call_id: "patch-broken",
      arguments: JSON.stringify({ operations: [{ path: "result.txt", action: "create", content: "broken\n" }] }),
    }]);
    if (call === 2) return assistant("initial", "Initial implementation complete.", {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    });
    throw new Error(`The repair round exceeded the shared step limit at provider call ${call}`);
  });
  const testFixture = await fixture(provider);
  let verifications = 0;
  testFixture.dependencies.createCommandExecutor = () => async () => {
    verifications += 1;
    return verificationResult(false);
  };
  await fs.writeFile(path.join(testFixture.workspacePath, "package.json"), JSON.stringify({ scripts: { test: "node verify.mjs" } }), "utf8");
  try {
    const result = await runExec({
      prompt: "Fix result.txt",
      workspacePath: testFixture.workspacePath,
      maxSteps: 2,
    }, testFixture.dependencies);
    assert.equal(result.exitCode, 4);
    assert.equal(result.stopReason, "step_limit");
    assert.equal(provider.calls, 2);
    assert.equal(verifications, 1);
  } finally {
    await testFixture.cleanup();
  }
});

test("changed work without a bindable verification result exits 3 as unverified", async () => {
  const provider = fakeProvider((_params, _signal, call) => {
    if (call === 1) return response("create-file", [{
      type: "function_call",
      name: "apply_patch",
      call_id: "patch-file",
      arguments: JSON.stringify({ operations: [{ path: "result.txt", action: "create", content: "done\n" }] }),
    }]);
    if (call === 2) return assistant("finished", "Implementation complete.");
    throw new Error(`Unexpected provider call ${call}`);
  });
  const testFixture = await fixture(provider);
  try {
    const result = await runExec({ prompt: "Create result.txt", workspacePath: testFixture.workspacePath }, testFixture.dependencies);
    assert.equal(result.exitCode, 3);
    assert.equal(result.classification, "verification_failed");
    assert.equal(result.workflowResult, "unverified");
    assert.ok(result.sessionId);
    assert.equal((await testFixture.sessionStore.load(result.sessionId)).workflow?.pending_verification, true);
  } finally {
    await testFixture.cleanup();
  }
});

test("structured questions and approvals persist interaction_required outputs before exit 5", async (t) => {
  await t.test("question", async () => {
    const provider = fakeProvider((_params, _signal, call) => {
      if (call > 1) throw new Error("Exec must stop before another provider request");
      return response("question", [{
        type: "function_call",
        name: "request_user_input",
        call_id: "question-1",
        arguments: JSON.stringify({ questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "Small" }, { label: "Large", description: "Large" }] }] }),
      }]);
    });
    const testFixture = await fixture(provider);
    try {
      const result = await runExec({ prompt: "Ask me", workspacePath: testFixture.workspacePath }, testFixture.dependencies);
      assert.equal(result.exitCode, 5);
      assert.equal(result.classification, "interaction_required");
      assert.deepEqual(result.interaction, { kind: "question", tool: "request_user_input", prompt: "Which scope?" });
      assert.ok(result.sessionId);
      const loaded = await testFixture.sessionStore.load(result.sessionId);
      assert.match(JSON.stringify(loaded.context), /interaction_required/u);
      assert.match(JSON.stringify(loaded.context), /question-1/u);
      assert.equal(provider.calls, 1);
    } finally {
      await testFixture.cleanup();
    }
  });

  await t.test("approval", async () => {
    const provider = fakeProvider(() => response("approval", [{
      type: "function_call",
      name: "bash",
      call_id: "bash-1",
      arguments: JSON.stringify({ command: "git clean -fd" }),
    }]));
    const testFixture = await fixture(provider, { mode: "ask", web: false });
    let executions = 0;
    testFixture.dependencies.createCommandExecutor = () => async () => {
      executions += 1;
      return verificationResult(true);
    };
    try {
      const result = await runExec({ prompt: "Clean generated files", workspacePath: testFixture.workspacePath }, testFixture.dependencies);
      assert.equal(result.exitCode, 5);
      assert.equal(result.interaction?.kind, "approval");
      assert.equal(result.interaction?.tool, "bash");
      assert.equal(executions, 0);
      assert.ok(result.sessionId);
      assert.match(JSON.stringify((await testFixture.sessionStore.load(result.sessionId)).context), /interaction_required/u);
    } finally {
      await testFixture.cleanup();
    }
  });
});

test("exec reports token, unknown-usage, step, and deadline stops with exit 4", async (t) => {
  await t.test("token budget", async () => {
    const provider = fakeProvider(() => assistant("budget", "too expensive"));
    const testFixture = await fixture(provider);
    try {
      const result = await runExec({ prompt: "work", workspacePath: testFixture.workspacePath, tokenBudget: 1 }, testFixture.dependencies);
      assert.equal(result.exitCode, 4);
      assert.equal(result.stopReason, "budget_limited");
    } finally { await testFixture.cleanup(); }
  });

  await t.test("unknown usage", async () => {
    const provider = fakeProvider(() => {
      const value = assistant("unknown", "unknown");
      delete value.usage;
      return value;
    });
    const testFixture = await fixture(provider);
    try {
      const result = await runExec({ prompt: "work", workspacePath: testFixture.workspacePath }, testFixture.dependencies);
      assert.equal(result.exitCode, 4);
      assert.equal(result.stopReason, "usage_limited");
      assert.equal(result.usageComplete, false);
    } finally { await testFixture.cleanup(); }
  });

  await t.test("step budget", async () => {
    const provider = fakeProvider(() => response("step", [{ type: "function_call", name: "list_directory", call_id: "list", arguments: '{"path":"."}' }]));
    const testFixture = await fixture(provider);
    try {
      const result = await runExec({ prompt: "inspect", workspacePath: testFixture.workspacePath, maxSteps: 1 }, testFixture.dependencies);
      assert.equal(result.exitCode, 4);
      assert.equal(result.stopReason, "step_limit");
      assert.equal(provider.calls, 1);
    } finally { await testFixture.cleanup(); }
  });

  await t.test("task deadline", async () => {
    const provider = fakeProvider(async (_params, signal) => {
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      throw new Error("unreachable");
    });
    const testFixture = await fixture(provider);
    try {
      const result = await runExec({ prompt: "wait", workspacePath: testFixture.workspacePath, timeoutMs: 20 }, testFixture.dependencies);
      assert.equal(result.exitCode, 4);
      assert.equal(result.stopReason, "deadline_exceeded");
    } finally { await testFixture.cleanup(); }
  });

  await t.test("task deadline while credentials are stalled", async () => {
    const provider = fakeProvider(() => assistant("unexpected", "must not run"));
    const testFixture = await fixture(provider);
    testFixture.dependencies.registry = {
      async resolveAll() { return new Promise<never>(() => {}); },
    };
    try {
      const result = await runExec({ prompt: "wait", workspacePath: testFixture.workspacePath, timeoutMs: 20 }, testFixture.dependencies);
      assert.equal(result.exitCode, 4);
      assert.equal(result.stopReason, "deadline_exceeded");
      assert.equal(result.sessionId, undefined);
      assert.equal(provider.calls, 0);
    } finally { await testFixture.cleanup(); }
  });
});

test("an EPIPE event sink cancels execution and still disposes the production handle", async () => {
  const provider = fakeProvider(() => assistant("unexpected", "must not run"));
  const testFixture = await fixture(provider);
  const createAgent = testFixture.dependencies.createAgent!;
  let disposed = 0;
  testFixture.dependencies.createAgent = (options) => {
    const handle = createAgent(options);
    const dispose = handle.dispose.bind(handle);
    return {
      ...handle,
      async dispose() {
        disposed += 1;
        await dispose();
      },
    };
  };
  try {
    const result = await runExec({
      prompt: "work",
      workspacePath: testFixture.workspacePath,
      onEvent(event) {
        if (event.type === "session_started") throw Object.assign(new Error("pipe closed"), { code: "EPIPE" });
      },
    }, testFixture.dependencies);
    assert.equal(result.classification, "cancelled");
    assert.equal(result.stopReason, "output_closed");
    assert.equal(provider.calls, 0);
    assert.equal(disposed, 1);
  } finally {
    await testFixture.cleanup();
  }
});

for (const stop of ["completed", "cancelled", "deadline"] as const) {
  test(`exec reports stream cleanup failure after ${stop} through the production handle`, { timeout: 10_000 }, async (t) => {
    const controller = new AbortController();
    const deadlineMs = 1_234_567;
    let expireDeadline: (() => void) | undefined;
    if (stop === "deadline") {
      // Fire the actual exec deadline only after the iterator is owned;
      // registry/session disk latency must not turn this into startup timeout.
      // Other tests cover the real elapsed deadline during startup.
      const originalSetTimeout = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
        if (milliseconds === deadlineMs) expireDeadline = () => callback(...args);
        return originalSetTimeout(callback, milliseconds, ...args);
      }) as typeof globalThis.setTimeout);
    }
    const provider = fakeProvider(() => assistant("unused", "unused"));
    provider.responses.stream = async (_params, options) => {
      provider.calls++;
      const signal = options?.signal instanceof AbortSignal ? options.signal : undefined;
      return { [Symbol.asyncIterator]() { return {
        async next() {
          if (stop === "deadline") {
            assert.ok(expireDeadline, "The real exec deadline must be armed");
            expireDeadline();
          }
          if (stop === "deadline") await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { done: false, value: { type: "response.completed", response: assistant("terminal", "done") } };
        },
        async return() {
          if (stop === "cancelled") controller.abort();
          throw new Error("stream cleanup fixture refused");
        },
      }; } };
    };
    const testFixture = await fixture(provider);
    try {
      const result = await runExec({
        prompt: "work", workspacePath: testFixture.workspacePath, signal: AbortSignal.any([controller.signal, t.signal]),
        ...(stop === "deadline" ? { timeoutMs: deadlineMs } : {}),
      }, testFixture.dependencies);
      assert.equal(result.exitCode, 1);
      assert.equal(result.classification, "runtime_error");
      assert.equal(result.status, "cleanup_failed");
      assert.match(result.error ?? "", /stream cleanup fixture refused/u);
      assert.equal(result.usageComplete, true);
      assert.deepEqual(result.usage?.attempts.map((attempt) => attempt.status), ["failed"]);
      assert.equal(result.usage?.inputTokens, 2);
      assert.equal(result.usage?.outputTokens, 1);
      assert.equal(provider.calls, 1);
      assert.ok(result.sessionId);
      const session = await testFixture.sessionStore.load(result.sessionId);
      assert.equal(session.workflow?.result, "unverified");
      assert.equal(session.workflow?.pending_verification, true);
      assert.equal(JSON.stringify(session.workflow).includes("stream cleanup fixture refused"), false);
    } finally { await testFixture.cleanup(); }
  });
}

test("context persistence and cleanup failures return runtime failure after disposing resources", async (t) => {
  await t.test("context persistence", async () => {
    const provider = fakeProvider(() => assistant("unexpected", "must not run"));
    const testFixture = await fixture(provider);
    const createAgent = testFixture.dependencies.createAgent!;
    let disposed = 0;
    testFixture.dependencies.createAgent = (options) => {
      const handle = createAgent(options);
      const dispose = handle.dispose.bind(handle);
      return {
        ...handle,
        async dispose() {
          disposed += 1;
          await dispose();
        },
      };
    };
    testFixture.sessionStore.appendContext = async () => { throw new Error("context disk unavailable"); };
    try {
      const result = await runExec({ prompt: "work", workspacePath: testFixture.workspacePath }, testFixture.dependencies);
      assert.equal(result.exitCode, 1);
      assert.equal(result.classification, "runtime_error");
      assert.match(result.error ?? "", /Context persistence failed/u);
      assert.ok(result.sessionId);
      assert.equal(provider.calls, 0);
      assert.equal(disposed, 1);
    } finally {
      await testFixture.cleanup();
    }
  });

  await t.test("resource cleanup", async () => {
    const provider = fakeProvider(() => assistant("complete", "done"));
    const testFixture = await fixture(provider);
    const createAgent = testFixture.dependencies.createAgent!;
    let disposed = 0;
    testFixture.dependencies.createAgent = (options) => {
      const handle = createAgent(options);
      const dispose = handle.dispose.bind(handle);
      return {
        ...handle,
        async dispose() {
          disposed += 1;
          await dispose();
          throw new Error("cleanup fixture failure");
        },
      };
    };
    try {
      const result = await runExec({ prompt: "work", workspacePath: testFixture.workspacePath }, testFixture.dependencies);
      assert.equal(result.exitCode, 1);
      assert.equal(result.status, "cleanup_failed");
      assert.match(result.error ?? "", /cleanup fixture failure/u);
      assert.ok(result.sessionId);
      assert.equal(disposed, 1);
    } finally {
      await testFixture.cleanup();
    }
  });
});
test("exec resume forks the parent, reuses the saved model, and clears fork_pending_resume after success", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const provider = fakeProvider((params) => {
    requests.push(params);
    return assistant("continued", "Resumed and verified.");
  });
  const testFixture = await fixture(provider);
  try {
    const parent = await testFixture.sessionStore.create({
      title: "exec resume parent",
      titlePending: false,
      workspacePath: testFixture.workspacePath,
      model: {
        id: model.id,
        model_name: model.model_name,
        base_url: model.base_url,
      },
    });
    await testFixture.sessionStore.appendContext(parent.id, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "original requirement" }] },
    ]);

    const events: ExecEvent[] = [];
    const result = await runExec({
      prompt: "finish the original requirement",
      workspacePath: testFixture.workspacePath,
      resume: parent.id,
      onEvent(event) { events.push(event); },
    }, testFixture.dependencies);

    assert.equal(result.exitCode, 0, result.error);
    assert.equal(result.classification, "success");
    assert.equal(result.workflowResult, "no_changes");
    assert.equal(result.assistantText, "Resumed and verified.");
    assert.ok(result.sessionId);
    assert.notEqual(result.sessionId, parent.id);
    assert.equal(provider.calls, 1);
    assert.match(JSON.stringify(requests[0]?.input), /original requirement/u);
    assert.match(JSON.stringify(requests[0]?.input), /finish the original requirement/u);

    const started = events.find((event) => event.type === "session_started");
    assert.equal(started?.type, "session_started");
    if (started?.type === "session_started") {
      assert.equal(started.sessionId, result.sessionId);
      assert.equal(started.parentSessionId, parent.id);
    }

    const child = await testFixture.sessionStore.load(result.sessionId!);
    assert.equal(child.summary.lineage?.parent_session_id, parent.id);
    assert.equal(child.forkPendingResume, false);
    assert.equal(child.summary.model.id, model.id);
    assert.equal(child.workflow?.task_source, "session_resume");
    assert.match(JSON.stringify(child.context), /original requirement/u);

    const source = await testFixture.sessionStore.load(parent.id);
    assert.equal(source.summary.model.id, model.id);
    assert.doesNotMatch(JSON.stringify(source.context), /finish the original requirement/u);
  } finally {
    await testFixture.cleanup();
  }
});

test("exec resume rejects a different workspace, a missing session, an unregistered model, and --model", async (t) => {
  await t.test("different workspace", async () => {
    const provider = fakeProvider(() => assistant("unused", "unused"));
    const testFixture = await fixture(provider);
    try {
      const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-exec-other-"));
      try {
        const parent = await testFixture.sessionStore.create({
          title: "other workspace parent",
          titlePending: false,
          workspacePath: otherRoot,
          model: { id: model.id, model_name: model.model_name, base_url: model.base_url },
        });
        const result = await runExec({
          prompt: "work",
          workspacePath: testFixture.workspacePath,
          resume: parent.id,
        }, testFixture.dependencies);
        assert.equal(result.exitCode, 2);
        assert.equal(result.classification, "configuration_error");
        assert.match(result.error ?? "", /different workspace/u);
        assert.equal(provider.calls, 0);
      } finally { await fs.rm(otherRoot, { recursive: true, force: true }); }
    } finally { await testFixture.cleanup(); }
  });

  await t.test("missing session", async () => {
    const provider = fakeProvider(() => assistant("unused", "unused"));
    const testFixture = await fixture(provider);
    try {
      const result = await runExec({
        prompt: "work",
        workspacePath: testFixture.workspacePath,
        resume: "missing-session",
      }, testFixture.dependencies);
      assert.equal(result.exitCode, 2);
      assert.equal(result.classification, "configuration_error");
      assert.match(result.error ?? "", /could not be loaded/u);
      assert.equal(provider.calls, 0);
    } finally { await testFixture.cleanup(); }
  });

  await t.test("saved model unavailable", async () => {
    const provider = fakeProvider(() => assistant("unused", "unused"));
    const testFixture = await fixture(provider);
    try {
      const parent = await testFixture.sessionStore.create({
        title: "unavailable model parent",
        titlePending: false,
        workspacePath: testFixture.workspacePath,
        model: { id: "gone-registration", model_name: "gone-model", base_url: "https://gone.invalid/v1" },
      });
      const result = await runExec({
        prompt: "work",
        workspacePath: testFixture.workspacePath,
        resume: parent.id,
      }, testFixture.dependencies);
      assert.equal(result.exitCode, 2);
      assert.equal(result.classification, "configuration_error");
      assert.match(result.error ?? "", /model is unavailable/u);
      assert.equal(provider.calls, 0);
    } finally { await testFixture.cleanup(); }
  });

  await t.test("model override", async () => {
    const provider = fakeProvider(() => assistant("unused", "unused"));
    const testFixture = await fixture(provider);
    try {
      const result = await runExec({
        prompt: "work",
        workspacePath: testFixture.workspacePath,
        resume: "parent-1",
        model: model.id,
      }, testFixture.dependencies);
      assert.equal(result.exitCode, 2);
      assert.equal(result.classification, "configuration_error");
      assert.match(result.error ?? "", /cannot be combined/u);
      assert.equal(provider.calls, 0);
    } finally { await testFixture.cleanup(); }
  });
});
test("exec --plan submits a read-only plan, prints it, and never implements", async () => {
  const provider = fakeProvider((_params, _signal, call) => {
    if (call === 1) return response("plan", [{
      type: "function_call",
      name: "submit_plan",
      call_id: "plan-1",
      arguments: JSON.stringify({ title: "Refactor plan", plan: "1. Read src\n2. Edit safely\n" }),
    }]);
    throw new Error(`Unexpected provider call `);
  });
  const testFixture = await fixture(provider);
  const events: ExecEvent[] = [];
  try {
    const result = await runExec({
      prompt: "Plan the refactor",
      workspacePath: testFixture.workspacePath,
      plan: true,
      onEvent(event) { events.push(event); },
    }, testFixture.dependencies);
    assert.equal(result.exitCode, 0, result.error);
    assert.equal(result.classification, "success");
    assert.equal(result.status, "plan");
    assert.equal(result.assistantText, "1. Read src\n2. Edit safely");
    assert.equal(provider.calls, 1);
    const assistantEvent = events.find((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.type, "assistant_message");
    if (assistantEvent?.type === "assistant_message") {
      assert.match(assistantEvent.text, /Read src/u);
    }
    assert.ok(result.sessionId);
    const loaded = await testFixture.sessionStore.load(result.sessionId!);
    assert.equal(loaded.workflow, undefined);
    assert.match(JSON.stringify(loaded.context), /Refactor plan/u);
  } finally {
    await testFixture.cleanup();
  }
});

test("exec --plan stops on a material question and preserves its paired interaction result", async () => {
  const provider = fakeProvider(() => response("question", [{ type: "function_call", name: "request_user_input", call_id: "question", arguments: JSON.stringify({ questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "One module" }, { label: "Large", description: "Several modules" }] }] }) }]));
  const testFixture = await fixture(provider);
  try {
    const result = await runExec({ prompt: "Plan a change", plan: true, workspacePath: testFixture.workspacePath }, testFixture.dependencies);
    assert.equal(result.exitCode, 5);
    assert.equal(result.classification, "interaction_required");
    assert.equal(provider.calls, 1);
    const loaded = await testFixture.sessionStore.load(result.sessionId!);
    const output = loaded.context.find((item) => item.type === "function_call_output" && item.call_id === "question");
    assert.match(String(output?.output), /interaction_required/u);
    assert.equal(loaded.workflow, undefined);
  } finally { await testFixture.cleanup(); }
});
test("exec --permission-mode overrides the tier without weakening saved web restrictions", async () => {
  const provider = fakeProvider(() => assistant("done", "done"));
  const testFixture = await fixture(provider, { mode: "workspace-write", web: false });
  try {
    const result = await runExec({
      prompt: "work",
      workspacePath: testFixture.workspacePath,
      permissionMode: "read-only",
    }, testFixture.dependencies);
    assert.equal(result.exitCode, 0, result.error);
    const loaded = await testFixture.sessionStore.load(result.sessionId!);
    assert.equal(loaded.summary.workspace_path, testFixture.workspacePath);
  } finally {
    await testFixture.cleanup();
  }
});

test("exec --permission-mode read-only turns a shell call into interaction_required instead of running it", async () => {
  const provider = fakeProvider(() => response("shell", [{
    type: "function_call",
    name: "bash",
    call_id: "bash-1",
    arguments: JSON.stringify({ command: "echo hi" }),
  }]));
  const testFixture = await fixture(provider, { mode: "workspace-write", web: true });
  let executions = 0;
  testFixture.dependencies.createCommandExecutor = () => async () => {
    executions += 1;
    return verificationResult(true);
  };
  try {
    const result = await runExec({
      prompt: "echo hi",
      workspacePath: testFixture.workspacePath,
      permissionMode: "read-only",
    }, testFixture.dependencies);
    assert.equal(result.exitCode, 5);
    assert.equal(result.interaction?.kind, "approval");
    assert.equal(result.interaction?.tool, "bash");
    assert.equal(executions, 0);
  } finally {
    await testFixture.cleanup();
  }
});

test("exec --permission-mode workspace-write runs an allowed shell call without interaction", async () => {
  const provider = fakeProvider((_params, _signal, call) => {
    if (call === 1) return response("shell", [{
      type: "function_call",
      name: "bash",
      call_id: "bash-1",
      arguments: JSON.stringify({ command: "echo hi" }),
    }]);
    return assistant("done", "echoed");
  });
  const testFixture = await fixture(provider, { mode: "read-only", web: true });
  let executions = 0;
  testFixture.dependencies.createCommandExecutor = () => async () => {
    executions += 1;
    return verificationResult(true);
  };
  try {
    const result = await runExec({
      prompt: "echo hi",
      workspacePath: testFixture.workspacePath,
      permissionMode: "workspace-write",
    }, testFixture.dependencies);
    // The shell ran without interaction; verification outcome is separate.
    assert.notEqual(result.exitCode, 5);
    assert.equal(result.interaction, undefined);
    assert.equal(executions, 1);
  } finally {
    await testFixture.cleanup();
  }
});
