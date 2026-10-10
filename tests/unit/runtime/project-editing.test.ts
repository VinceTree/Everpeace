import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { ReactAgent, type AgentResponse } from "../../../src/agent/react-agent.js";
import { createProductionAgent, createProductionWorkflowAgentIO } from "../../../src/runtime/production.js";
import { resolveProviderCapabilities, defaultModelRequestSettings } from "../../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../../src/providers/openai-compatible.js";
import { previewApplyPatch, runApplyPatch } from "../../../src/tools/apply-patch.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { CodingWorkflowRuntime } from "../../../src/workflow/runtime.js";
import { CodingTaskRunner } from "../../../src/workflow/task-runner.js";
import type { PermissionPolicy } from "../../../src/permissions/policy.js";

const model = { id: "offline", model_name: "offline", base_url: "https://api.deepseek.com", api_key: "fixture" };
function call(id: string, name?: string, args?: unknown): AgentResponse { return { id, status: "completed", output_text: name ? "" : "Changed", output: name ? [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] : [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }; }

test("shared production path maps, requires observation, diagnoses exact miss, opts into whitespace, and verifies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-project-editing-"));
  const workspacePath = path.join(root, "workspace");
  const file = "src/index.ts";
  await fs.mkdir(path.join(workspacePath, "src"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, file), "\ufeff\tconst value = 1;  \r\n");
  await fs.writeFile(path.join(workspacePath, "src/AGENTS.md"), "NESTED_RULE_MARKER: preserve literal text");
  await fs.writeFile(path.join(workspacePath, "package.json"), JSON.stringify({ scripts: { typecheck: "check-types", lint: "check-lint", test: "check-tests", build: "check-build" } }));
  await promisify(execFile)("git", ["init", "--quiet"], { cwd: workspacePath });
  const store = new SessionStore({ directory: path.join(root, "sessions") });
  const session = await store.create({ workspacePath, title: "map and edit", titlePending: false, model });
  const workflow = new CodingWorkflowRuntime({ workspacePath, onState: (state) => store.setWorkflow(session.id, state) });
  const patch = (mode?: string) => ({ operations: [{ path: file, action: "update", replace: { oldText: "    const value = 1;", newText: "const value = 2;", ...(mode ? { matchMode: mode } : {}) } }] });
  const steps = [call("map", "project_map", { path: "src" }), call("refresh", "apply_patch", patch()), call("blind", "apply_patch", patch()), call("read", "read_file", { path: file }), call("exact", "apply_patch", patch()), call("tolerant", "apply_patch", patch("line_whitespace")), call("done")];
  const requests: Record<string, unknown>[] = [];
  const capabilities = resolveProviderCapabilities(model.base_url);
  const provider: ProviderRuntime = { sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities), responses: {
    async create() { throw new Error("Unexpected buffered request"); },
    async stream(params) { requests.push(structuredClone(params)); const completed = steps.shift(); assert.ok(completed); return (async function* () { yield { type: "response.completed", response: completed }; })(); },
  } };
  const commands: string[] = [];
  const execute = async (command: string) => { commands.push(command); const fixed = (await fs.readFile(path.join(workspacePath, file), "utf8")) === "\ufeffconst value = 2;\r\n"; return { stdout: fixed ? "passed" : "failed", stderr: "", exitCode: fixed ? 0 : 1, signal: null }; };
  const handle = createProductionAgent({ model, workspacePath, sessionStore: store, sessionId: () => session.id,
    io: createProductionWorkflowAgentIO({ workspacePath, workflow, execute, policy: () => ({ mode: "workspace-write", web: false }) }),
    providerRuntime: provider, skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null,
    restore: { onHistoryAppend: (items) => store.appendContext(session.id, items) },
  });
  try {
    const runner = new CodingTaskRunner({ agent: handle.agent, workflow, host: { executeVerification: execute, async getGoal() { return undefined; }, async addGoalTime() { return undefined; } } });
    const result = await runner.run({ text: "Locate and fix value", source: "user" });
    assert.equal(result.workflowResult?.state.result, "verified");
    assert.equal(steps.length, 0);
    const loaded = await store.load(session.id);
    const output = (id: string) => JSON.parse(String(loaded.context.find((item) => item.type === "function_call_output" && item.call_id === id)?.output));
    assert.ok(output("map").data.locations.entryCandidates.includes(file));
    assert.equal(output("refresh").errorCode, "RULES_REFRESH_REQUIRED");
    assert.equal(output("blind").errorCode, "FILE_NOT_OBSERVED");
    assert.equal(output("exact").errorCode, "REPLACEMENT_NOT_FOUND");
    assert.equal(output("tolerant").files[0].matchMode, "line_whitespace");
    assert.deepEqual(output("tolerant").files[0].matchedLines, { start: 1, end: 1 });
    assert.equal(JSON.stringify(requests[1]?.input).includes("NESTED_RULE_MARKER"), false, "map scope must not load rule bodies on the next request");
    assert.deepEqual(result.workflowResult?.verificationSuite?.results.map((item) => item.command.id), ["node:typecheck", "node:lint", "node:test", "node:build"]);
  } finally { await handle.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test("Plan advertises project_map and retains read-only behavior", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-map-plan-"));
  try {
    await fs.writeFile(path.join(root, "README.md"), "contents should not be loaded");
    const steps = [call("map", "project_map", {}), call("done")];
    const requests: Record<string, unknown>[] = [];
    const agent = new ReactAgent({ model: "offline", workspacePath: root, client: { responses: { async create(params) { requests.push(params); return steps.shift()!; } } }, io: { async confirmBash() { return false; }, async runBash() { throw new Error("No shell"); }, writeAssistant() {} } });
    await agent.runTurn("Explore the project", undefined, { mode: "plan" });
    const tools = (requests[0]!.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(tools.includes("project_map"));
    assert.equal(tools.includes("apply_patch"), false);
    assert.match(JSON.stringify(requests[1]?.input), /Workspace data only/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("whitespace approval explicitly shows mode/range and binds bytes even when approval mutates the file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-whitespace-approval-"));
  const target = path.join(root, "file.ts");
  try {
    await fs.writeFile(target, "\tvalue\n");
    const steps = [call("read", "read_file", { path: "file.ts" }), call("patch", "apply_patch", { operations: [{ path: "file.ts", action: "update", replace: { oldText: "  value", newText: "changed", matchMode: "line_whitespace" } }] }), call("done")];
    const requests: Record<string, unknown>[] = [];
    const agent = new ReactAgent({ model: "offline", workspacePath: root, client: { responses: { async create(params) { requests.push(params); return steps.shift()!; } } }, io: {
      getPermissions: () => ({ mode: "ask", web: false }), async confirmBash() { return false; }, async runBash() { throw new Error("No shell"); }, writeAssistant() {},
      previewPatch: (ops) => previewApplyPatch(ops, root), runApplyPatch: (ops) => runApplyPatch(ops, root),
      async confirmPatch(summary) { assert.match(summary, /line_whitespace match, lines 1-1/u); await fs.writeFile(target, "user change\n"); return true; },
    } });
    await agent.runTurn("Edit");
    assert.equal(await fs.readFile(target, "utf8"), "user change\n");
    assert.match(JSON.stringify(requests[2]?.input), /STALE_VERSION/u);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("explicit whitespace editing respects denied approval and permission changes during review", async (context) => {
  for (const scenario of ["denied", "policy-changed"]) await context.test(scenario, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "everpeace-whitespace-policy-"));
    const file = path.join(root, "file.ts");
    try {
      await fs.writeFile(file, "\tvalue\n");
      let policy: PermissionPolicy = { mode: "ask", web: false };
      let writes = 0;
      const requests: Record<string, unknown>[] = [];
      const steps = [call("read", "read_file", { path: "file.ts" }), call("patch", "apply_patch", { operations: [{ path: "file.ts", action: "update", replace: { oldText: "  value", newText: "changed", matchMode: "line_whitespace" } }] }), call("done")];
      const agent = new ReactAgent({ model: "offline", workspacePath: root, client: { responses: { async create(params) { requests.push(params); return steps.shift()!; } } }, io: {
        getPermissions: () => policy, async confirmBash() { return false; }, async runBash() { throw new Error("No shell"); }, writeAssistant() {},
        previewPatch: (ops) => previewApplyPatch(ops, root), async runApplyPatch(ops) { writes++; return runApplyPatch(ops, root); },
        async confirmPatch() { if (scenario === "denied") return false; policy = { mode: "read-only", web: false }; return true; },
      } });
      await agent.runTurn("Edit");
      assert.equal(writes, 0);
      assert.equal(await fs.readFile(file, "utf8"), "\tvalue\n");
      assert.match(JSON.stringify(requests[2]?.input), /POLICY_DENIED/u);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
