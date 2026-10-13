import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import React from "react";
import { render } from "ink-testing-library";
import { EverpeaceApp } from "../../../src/tui/app/app.js";
import type { TuiDependencies } from "../../../src/tui/app/types.js";
import type { AgentResponse } from "../../../src/agent/react-agent.js";
import { createProductionAgent, type ProductionAgentHandle } from "../../../src/runtime/production.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { createWorkflowState } from "../../../src/workflow/types.js";

const model = { id: "offline", model_name: "offline", base_url: "https://compatible.invalid/v1", api_key: "fixture" };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (check()) return; await tick(); }
  assert.fail("Timed out waiting for the production Plan fixture");
}
function call(id: string, name?: string, args?: unknown): AgentResponse {
  return { id, status: "completed", output_text: name ? "" : "Implementation finished", output: name ? [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] : [], usage: { input_tokens: 2, output_tokens: 1 } };
}

test("production TUI plans, records revision, waits for explicit execution, and verifies a fork's debt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-plan-execution-"));
  const workspacePath = path.join(root, "workspace");
  await fs.mkdir(workspacePath);
  const target = path.join(workspacePath, "value.ts");
  await fs.writeFile(target, "const value = 1;\n");
  await fs.writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ scripts: { typecheck: "check-types", lint: "check-lint", test: "check-tests", build: "check-build" } }));
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: workspacePath });
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const parent = await store.create({ title: "Parent", workspacePath, titlePending: false, model });
  // A fork must retain the parent's debt through planning and explicit execution.
  await store.setWorkflow(parent.id, {
    ...createWorkflowState("parent-task"), phase: "done", result: "unverified", result_reason: "prior_unverified",
    pending_verification: true, changed_paths: ["value.ts"],
  });
  const child = await store.fork(parent.id, { title: "Plan child" });
  const replacement = "Change value.ts from 1 to 2 using an observed exact replacement.\nRun typecheck, lint, test, and build.\nFINAL_PLAN_MARKER";
  const steps = [
    call("map", "project_map", {}),
    call("inspect", "read_file", { path: "value.ts" }),
    call("question", "request_user_input", { questions: [{ id: "scope", header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "Change the value" }, { label: "Large", description: "Refactor the module" }] }] }),
    call("draft", "submit_plan", { title: "Draft", plan: "Change the value" }),
    call("replacement", "submit_plan", { title: "Final plan", plan: replacement }),
    call("read-current", "read_file", { path: "value.ts" }),
    call("patch", "apply_patch", { operations: [{ path: "value.ts", action: "update", replace: { oldText: "const value = 1;", newText: "const value = 2;" } }] }),
    call("done"),
  ];
  const requests: Record<string, unknown>[] = [];
  const capabilities = resolveProviderCapabilities(model.base_url);
  const provider: ProviderRuntime = { sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities), responses: {
    async create() { throw new Error("No buffered provider requests"); },
    async stream(params) {
      const loaded = await store.load(child.id);
      if (requests.length === 4) {
        const feedback = loaded.context.find((item) => item.type === "function_call_output" && item.call_id === "draft");
        assert.deepEqual(JSON.parse(String(feedback?.output)), { decision: "continue", feedback: "Include all final verification checks" });
      }
      if (requests.length === 5) assert.match(JSON.stringify(params.input), /FINAL_PLAN_MARKER/u);
      requests.push(structuredClone(params));
      const response = steps.shift();
      assert.ok(response, "no unplanned provider request");
      return (async function* () { yield { type: "response.completed", response }; })();
    },
  } };
  const commands: string[] = [];
  const starts: Array<{ mode: string; source: string }> = [];
  const handles: ProductionAgentHandle[] = [];
  const dependencies: TuiDependencies = {
    version: "offline", workspacePath, sessionStore: store,
    registry: { async resolveAll() { return { available: [model], missing: [] }; }, async listStatuses() { return []; }, async registerMany() { throw new Error("No registration"); }, async removeMany() { throw new Error("No credentials"); } },
    async listModels() { return []; }, async generateSessionTitle() { return "Offline"; }, async changeWorkspace(value) { return value; },
    async loadPermissions() { return { mode: "workspace-write", web: false }; },
    createAgent(selected, io, restore) {
      const handle = createProductionAgent({ model: selected, workspacePath, io, sessionStore: store, sessionId: io.getSessionId!, providerRuntime: provider, skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null,
        restore: {
          ...(restore?.initialContext ? { initialHistory: restore.initialContext } : {}),
          ...(restore?.initialTaskProgress ? { initialTaskProgress: restore.initialTaskProgress } : {}),
          ...(restore?.onContextAppend ? { onHistoryAppend: restore.onContextAppend } : {}),
          ...(restore?.onContextCompacted ? { onContextCompacted: restore.onContextCompacted } : {}),
          ...(restore?.onUsage ? { onUsage: restore.onUsage } : {}),
        },
      });
      handles.push(handle);
      const begin = handle.agent.beginTask.bind(handle.agent);
      handle.agent.beginTask = async (input) => { starts.push({ mode: input.mode, source: input.source }); await begin(input); };
      return handle.agent;
    },
    async runBash(command) {
      commands.push(command);
      const fixed = await fs.readFile(target, "utf8") === "const value = 2;\n";
      return { stdout: fixed ? "passed" : "failed", stderr: "", exitCode: fixed ? 0 : 1, signal: null };
    },
    async runTerminalCommand() { throw new Error("No direct shell"); },
  };
  const view = render(<EverpeaceApp dependencies={dependencies} initialModels={{ available: [model], missing: [] }} onReplayOutput={(update) => update()} />);
  const submit = async (text: string) => { view.stdin.write(text); await tick(); view.stdin.write("\r"); };
  try {
    await tick();
    await submit("/resume");
    await waitFor(() => (view.lastFrame() ?? "").includes("Scope: This workspace"));
    await tick(); view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Plan child") && (view.lastFrame() ?? "").includes("Enter"));
    await tick(); view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
    await submit("/plan change the value");
    await waitFor(() => (view.lastFrame() ?? "").includes("Which scope?"));
    await tick(); view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Approve plan"));
    await tick(); view.stdin.write("\u001b[B"); await tick(); view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Describe the changes"));
    await tick();
    await submit("Include all final verification checks");
    await waitFor(() => (view.lastFrame() ?? "").includes("FINAL_PLAN_MARKER"));
    await tick(); view.stdin.write("\r");
    await waitFor(() => (view.lastFrame() ?? "").includes("Plan approved. Run /plan execute to start."));
    assert.equal(requests.length, 5);
    assert.equal(commands.length, 0);
    assert.equal(await fs.readFile(target, "utf8"), "const value = 1;\n");
    assert.equal((await store.load(child.id)).forkPendingResume, true);
    assert.equal((await store.load(child.id)).workflow?.pending_verification, true);
    await submit("/plan execute");
    await waitFor(() => (view.lastFrame() ?? "").includes("Verification execution basis changed"));
    await tick(); view.stdin.write("y");
    await waitFor(() => (view.lastFrame() ?? "").includes("Implementation finished"));
    await waitFor(() => (view.lastFrame() ?? "").includes("Ask Everpeace"));
    const loaded = await store.load(child.id);
    assert.equal(loaded.workflow?.result, "verified");
    assert.equal(loaded.forkPendingResume, false);
    assert.equal(await fs.readFile(target, "utf8"), "const value = 2;\n");
    assert.equal(steps.length, 0);
    assert.deepEqual(starts, [{ mode: "plan", source: "user" }, { mode: "default", source: "session_resume" }]);
    assert.deepEqual(commands.slice(-4), [`pnpm${process.platform === "win32" ? ".cmd" : ""} run typecheck`, `pnpm${process.platform === "win32" ? ".cmd" : ""} run lint`, `pnpm${process.platform === "win32" ? ".cmd" : ""} run test`, `pnpm${process.platform === "win32" ? ".cmd" : ""} run build`]);
  } catch (error) {
    throw new Error(`${String(error)}\n${view.lastFrame()}`, { cause: error });
  } finally {
    view.unmount();
    await Promise.allSettled(handles.map((handle) => handle.dispose()));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
