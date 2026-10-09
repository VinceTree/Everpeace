import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runExec } from "../../src/exec/runtime.js";
import { createProductionAgent } from "../../src/runtime/production.js";
import { defaultModelRequestSettings, resolveProviderCapabilities } from "../../src/providers/capabilities.js";
import type { ProviderRuntime } from "../../src/providers/openai-compatible.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { discoverVerificationCommands } from "../../src/workflow/verifier.js";
import { createWorkflowState } from "../../src/workflow/types.js";
import { runBenchmarkVerification } from "../../src/benchmark/runner.js";

const root = path.resolve(process.argv[2] ?? "");
assert.equal(JSON.parse(await readFile(path.join(root, "ownership.json"), "utf8")).kind, "everpeace-readiness");
const config = JSON.parse(await readFile(path.join(root, "personal.json"), "utf8"));
const sessions = path.join(root, "personal-offline-sessions");
await mkdir(sessions, { recursive: true });
const store = new SessionStore({ directory: sessions });
const model = { id: "offline-personal", model_name: "deepseek-flash", base_url: "https://api.deepseek.com", api_key: "offline-not-a-credential" };
const capabilities = resolveProviderCapabilities(model.base_url, model.model_name);
let calls = 0;
function provider(): ProviderRuntime {
  let step = 0;
  return { sdk: {} as ProviderRuntime["sdk"], capabilities, settings: defaultModelRequestSettings(capabilities), responses: {
    async create() { throw new Error("Expected streaming request"); },
    async stream() {
      const id = `personal-${++calls}`;
      const output = ++step === 1
        ? [{ type: "function_call", call_id: `${id}-read`, name: "read_file", arguments: '{"path":"package.json"}' }]
        : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Offline assembly inspection complete." }] }];
      return (async function* () { yield { type: "response.completed", response: { id, status: "completed", output, usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }; })();
    },
  } };
}
const dependencies = {
  registry: { async resolveAll() { return { available: [model], missing: [] }; } }, sessionStore: store,
  async loadPermissionPolicy() { return { mode: "workspace-write" as const, web: false, shellNetwork: "deny" as const }; },
  createAgent(options: Parameters<typeof createProductionAgent>[0]) { return createProductionAgent({ ...options, providerRuntime: provider(), skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null }); },
};
const receipts: Record<string, unknown>[] = [];
for (const task of config.tasks) {
  const commands = await discoverVerificationCommands(task.workspacePath);
  assert.deepEqual(commands.map((command) => command.id), ["node:typecheck", "node:test", "node:build"]);
  const events: unknown[] = [];
  const result = await runExec({ prompt: `Inspect task assembly: ${task.prompt}`, workspacePath: task.workspacePath, tokenBudget: 100, onEvent(event) { events.push(event); } }, dependencies);
  assert.equal(result.exitCode, 0, result.error);
  assert.equal(result.usageComplete, true);
  assert.equal(result.usage?.inputTokens, 10);
  receipts.push({ id: task.id, assembly: "passed", commands, result, events, taskAcceptance: "not_attempted_by_fake_provider" });
}
const workspacePath = config.tasks.find((task: { id: string }) => task.id === "cancel-resume").workspacePath;
await writeFile(path.join(workspacePath, "readiness-result.txt"), "Offline cancellation receipt fixture\n");
const seed = await store.create({ title: "Offline verification debt", titlePending: false, workspacePath, model });
await store.setWorkflow(seed.id, { ...createWorkflowState("offline-cancel-seed"), phase: "review", changed_paths: ["readiness-result.txt"], pending_verification: true, result: "unverified" });
const controller = new AbortController();
let childCleaned = false;
const cancelled = await runExec({ prompt: "Continue verification, then cancel the long check", workspacePath, resume: seed.id, tokenBudget: 100, signal: controller.signal }, {
  ...dependencies,
  createCommandExecutor() { return async (_command: string, signal?: AbortSignal) => {
    const timer = setTimeout(() => controller.abort(new Error("Offline controlled cancellation")), 250);
    try {
      const result = await runBenchmarkVerification({ command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"], timeoutMs: 5000 }, workspacePath, signal ?? controller.signal);
      assert.equal(result.cancelled, true);
      assert.equal(result.cleanupFailed, undefined);
      childCleaned = true;
      return { ...result, signal: null };
    } finally { clearTimeout(timer); }
  }; },
});
assert.equal(childCleaned, true);
assert.equal(cancelled.classification, "cancelled");
assert.equal(cancelled.usageComplete, true);
const restoredStore = new SessionStore({ directory: sessions });
const restored = await restoredStore.load(cancelled.sessionId!);
assert.equal(restored.workflow?.pending_verification, true);
// A read-only restart pass must preserve debt; it does not claim completed checks.
const resumed = await runExec({ prompt: "Inspect resumed verification debt and submit a plan", workspacePath, resume: cancelled.sessionId!, plan: true, tokenBudget: 100 }, { ...dependencies, sessionStore: restoredStore });
assert.notEqual(resumed.sessionId, cancelled.sessionId);
assert.equal((await restoredStore.load(resumed.sessionId!)).workflow?.pending_verification, true);
await writeFile(path.join(root, "personal-offline-preflight.json"), JSON.stringify({ credentialsLoaded: false, calls, receipts, cancellation: { childCleaned, cancelled, restoredDebt: true, resumed }, actualPaidTaskAcceptance: "not_run" }, null, 2));
process.stdout.write("Four personal assemblies, actual request accounting, child cancellation and restart/fork debt passed; fake output does not score model quality.\n");
