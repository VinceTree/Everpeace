import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { AgentResponse } from "../../../src/agent/react-agent.js";
import { resolveProviderCapabilities, defaultModelRequestSettings } from "../../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { createProductionAgent, createProductionWorkflowAgentIO } from "../../../src/runtime/production.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";
import { CodingTaskRunner } from "../../../src/workflow/task-runner.js";
import { checkpointText } from "../../fixtures/conversation-checkpoint.js";

const exec = promisify(execFile);
const model = { id: "offline-ds", model_name: "offline-ds", base_url: "https://api.deepseek.com", api_key: "fixture" };
function response(id: string, name?: string, args?: unknown): AgentResponse {
  return { id, status: "completed", output_text: name ? "" : "Continue the repair", output: name ? [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] : [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } };
}
function provider(next: (params: Record<string, unknown>) => AgentResponse): ProviderRuntime {
  const capabilities = resolveProviderCapabilities(model.base_url);
  return { sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities), responses: {
    async create(params) { assert.equal(params.tool_choice, "none"); return { ...response("summary"), output_text: checkpointText("Fix src/中文.ts to value 2, preserve CRLF and public API", "Fast typecheck failed after the first patch; the task is not verified") }; },
    async stream(params) { const completed = next(params); return (async function* () { yield { type: "response.completed", response: completed }; })(); },
  } };
}

test("production failure feedback survives compaction, fork, and restart until the runner verifies the corrected file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-coding-continuity-"));
  const workspacePath = path.join(root, "workspace");
  const file = "src/中文.ts";
  await fs.mkdir(path.join(workspacePath, "src"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, file), "export const value = 0;\r\n");
  await fs.writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ name: "offline-continuity", scripts: { typecheck: "check-types", lint: "check-lint", test: "check-tests", build: "check-build" } }));
  await exec("git", ["init", "--quiet"], { cwd: workspacePath });
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const parent = await store.create({ workspacePath, title: "continuity", titlePending: false, model });
  let sessionId = parent.id;
  let handle: ReturnType<typeof createProductionAgent> | undefined;
  const commands: string[] = [];
  const execute = async (command: string) => {
    commands.push(command);
    const fixed = (await fs.readFile(path.join(workspacePath, file), "utf8")).includes("value = 2");
    return { stdout: fixed ? "passed" : "value must be 2", stderr: "", exitCode: fixed ? 0 : 1, signal: null };
  };
  const patch = (oldValue: number, newValue: number) => ({ operations: [{ path: file, action: "update", replace: { oldText: `value = ${oldValue}`, newText: `value = ${newValue}` } }] });
  try {
    let firstCalls = 0;
    const workflow = new CodingWorkflowRuntime({ workspacePath, onState: (state) => store.setWorkflow(sessionId, state) });
    await workflow.beginTurn();
    handle = createProductionAgent({ model, workspacePath, sessionStore: store, sessionId: () => sessionId,
      io: createProductionWorkflowAgentIO({ workspacePath, workflow, execute, policy: () => ({ mode: "workspace-write", web: false }) }),
      providerRuntime: provider(() => {
        firstCalls += 1;
        if (firstCalls === 1) return response("rules-refresh", "apply_patch", patch(0, 1));
        if (firstCalls === 2) return response("blind-patch", "apply_patch", patch(0, 1));
        if (firstCalls === 3) return response("read-current", "read_file", { path: file });
        if (firstCalls === 4) return response("first-patch", "apply_patch", patch(0, 1));
        return response("needs-diagnosis");
      }),
      skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null,
      restore: {
        onHistoryAppend: (items) => store.appendContext(sessionId, items),
        onContextCompacted: (items, automatic, usage) => store.compactContext(sessionId, items, automatic, usage),
      },
    });
    await handle.agent.runTurn(`Fix ${file} to value 2, preserve CRLF and public API. ${"Required behavior and evidence. ".repeat(400)}`);
    assert.equal(firstCalls, 5);
    assert.equal(workflow.state.phase, "diagnose");
    assert.equal(workflow.state.result, "failed");
    assert.equal(workflow.state.pending_verification, true);
    const before = await store.load(parent.id);
    const rejection = before.context.find((item) => item.type === "function_call_output" && item.call_id === "blind-patch");
    assert.equal(JSON.parse(String(rejection?.output)).errorCode, "FILE_NOT_OBSERVED");
    const refresh = JSON.parse(String(before.context.find((item) => item.type === "function_call_output" && item.call_id === "rules-refresh")?.output));
    assert.equal(refresh.errorCode, "RULES_REFRESH_REQUIRED");
    assert.match(refresh.remedy, /refreshed project rules/u);
    assert.ok(before.context.some((item) => item.type === "function_call_output" && String(item.output).includes("value must be 2")));
    await handle.agent.compact();
    await handle.dispose();
    handle = undefined;
    const compacted = await store.load(parent.id);
    assert.ok(compacted.context.some((item) => item.role === "assistant" && JSON.stringify(item.content).includes("Model-generated conversation checkpoint")));
    assert.equal(compacted.workflow?.pending_verification, true);

    const child = await store.fork(parent.id, { title: "continued independently" });
    sessionId = child.id;
    const restored = await store.load(child.id);
    assert.equal(restored.workflow?.pending_verification, true);
    assert.equal(restored.workflow?.repair_attempts, 0);
    const resumed = new CodingWorkflowRuntime({ workspacePath, initialState: restored.workflow, onState: (state) => store.setWorkflow(sessionId, state) });
    let resumedCalls = 0;
    const requests: Record<string, unknown>[] = [];
    handle = createProductionAgent({ model, workspacePath, sessionStore: store, sessionId: () => sessionId,
      io: createProductionWorkflowAgentIO({ workspacePath, workflow: resumed, execute, policy: () => ({ mode: "workspace-write", web: false }) }),
      providerRuntime: provider((params) => {
        requests.push(structuredClone(params));
        resumedCalls += 1;
        if (resumedCalls === 1) return response("restore-rules-refresh", "apply_patch", patch(1, 2));
        if (resumedCalls === 2) return response("restore-blind-patch", "apply_patch", patch(1, 2));
        if (resumedCalls === 3) return response("restore-read", "read_file", { path: file });
        if (resumedCalls === 4) return response("fixed-patch", "apply_patch", patch(1, 2));
        return response("fixed");
      }),
      skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null,
      restore: { initialHistory: restored.context, onHistoryAppend: (items) => store.appendContext(sessionId, items) },
    });
    const runner = new CodingTaskRunner({ agent: handle.agent, workflow: resumed, host: { executeVerification: execute, async getGoal() { return undefined; }, async addGoalTime() { return undefined; } } });
    commands.length = 0;
    const result = await runner.run({ text: "Continue the parser repair", source: "session_resume" });
    assert.equal(result.workflowResult?.state.result, "verified");
    assert.equal(result.workflowResult?.state.pending_verification, false);
    assert.deepEqual(result.workflowResult?.verificationSuite?.results.map((item) => item.command.id), ["node:typecheck", "node:lint", "node:test", "node:build"]);
    assert.equal(await fs.readFile(path.join(workspacePath, file), "utf8"), "export const value = 2;\r\n");
    const dynamic = (requests[0]!.input as Array<{ content: string }>).at(-1)!.content;
    assert.match(dynamic, /"pending_verification":true/u);
    assert.match(JSON.stringify(requests[0]?.input), /session_resume/u);
    const settled = await store.load(child.id);
    assert.equal(JSON.parse(String(settled.context.find((item) => item.call_id === "restore-blind-patch" && item.type === "function_call_output")?.output)).errorCode, "FILE_NOT_OBSERVED");
    assert.equal((await store.load(parent.id)).workflow?.result, "failed");
  } finally {
    await handle?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
