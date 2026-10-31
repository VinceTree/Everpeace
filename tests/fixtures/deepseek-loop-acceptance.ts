// Explicit development fixture. prepare/offline never load credentials or call a provider.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProductionAgent } from "../../src/runtime/production.js";
import { SessionStore } from "../../src/storage/session-store.js";
import { ModelRegistry } from "../../src/storage/model-registry.js";
import { SystemAuthStorage } from "../../src/storage/auth-storage.js";
import { CodingTaskRunner } from "../../src/workflow/task-runner.js";
import { CodingWorkflowRuntime } from "../../src/workflow/runtime.js";
import { RequestAttemptLedger } from "../../src/agent/request-attempt-ledger.js";
import { captureBenchmarkCheckoutIdentity, assertBenchmarkCheckoutIdentity } from "../../src/benchmark/checkout.js";
import { createBenchmarkMetricsCollector } from "../../src/benchmark/metrics.js";
import { projectBenchmarkEvent } from "../../src/benchmark/event-projection.js";
import { captureBenchmarkEvaluationDigest } from "../../src/benchmark/evaluation-identity.js";
import type { RegisteredModel } from "../../src/storage/model-registry.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [action, rootArg, ...args] = process.argv.slice(2);
assert.ok(rootArg && ["prepare", "offline", "live"].includes(action!), "Use prepare|offline|live <external-root>");
const root = path.resolve(rootArg);
const relative = path.relative(repo, root);
assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Use an external isolated root");
const argument = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
let baseUrl = args.includes("--official") ? "https://api.deepseek.com" : "https://cc2.caaa.tech/v1";
let modelName = argument("--raw-model") ?? (args.includes("--official") ? "REQUIRES_RAW_MODEL_ID" : "deepseek-flash");
const registrationId = argument("--model-id") ?? modelName;
const cases = [
  { id: "text", prompt: "Reply OK only." },
  { id: "reasoning-tools", prompt: "Read first.txt, follow its instruction to read the next workspace file, and report that file's hidden marker. Do not edit files or run commands." },
];
const save = (file: string, value: unknown) => writeFile(path.join(root, file), JSON.stringify(value, null, 2), { flag: "wx" });
const harnessDigest = createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
if (action === "prepare") {
  await mkdir(root); // Exclusive ownership: existing reports are never overwritten.
  const identity = await captureBenchmarkCheckoutIdentity(repo, path.join(repo, "dist/benchmark/production.js"));
  for (const item of cases) {
    const workspace = path.join(root, item.id, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "first.txt"), "Next file: second.txt. Read its hidden marker.\n");
    await writeFile(path.join(workspace, "second.txt"), `MARKER_${randomUUID()}\n`);
  }
  const expected = { model: modelName, reasoning: "high", maxOutputTokens: 32_768 };
  const harnesses = ["baseline", "candidate"].map((strategy) => ({ kind: "everpeace-checkout", name: strategy, loopStrategy: strategy, sourceRoot: repo, entryPath: identity.entryPath, revision: identity.revision, sourceDigest: identity.sourceDigest, buildDigest: identity.buildDigest, expected }));
  const common = { catalogPath: path.join(repo, "docs/benchmark/DEEPSEEK_NODE_TASKS.json"), fixtureRoot: path.join(repo, "docs/benchmark/fixtures"), modelId: registrationId, modelBaseUrl: baseUrl, responsesProfile: "deepseek", seed: 20261009, taskTokenBudget: 100_000, harnesses };
  const evaluationDigest = await captureBenchmarkEvaluationDigest(common.catalogPath, common.fixtureRoot);
  const catalog = JSON.parse(await readFile(common.catalogPath, "utf8")) as { tasks: Array<{ id: string }> };
  // Keep Git's workspace metadata below Windows path limits; reports stay external.
  const runRoot = await mkdtemp(path.join(tmpdir(), "ep-ds-"));
  const campaignSuffix = randomUUID().slice(0, 8);
  for (const stage of ["smoke", "comparison"]) {
    await save(`${stage}.json`, { ...common, evaluationDigest, campaignId: `ds-${stage}-${campaignSuffix}`, runsRoot: path.join(runRoot, stage), artifactsRoot: path.join(root, stage, "artifacts"), sessionsRoot: path.join(root, stage, "sessions"), repetitions: stage === "smoke" ? 1 : 3, campaignTokenBudget: stage === "smoke" ? 600_000 : 6_000_000, ...(stage === "smoke" ? { taskIds: catalog.tasks.slice(0, 3).map((task) => task.id) } : {}) });
  }
  await save("plan.json", { identity, harnessDigest, registrationId, model: modelName, baseUrl, responsesProfile: "deepseek", authorization: "prepared only; each live phase requires separate explicit numerical budget authorization", taskTokenBudget: 10_000, campaignTokenBudget: 20_000, maxOutputTokens: 1024, cases });
  console.log(JSON.stringify({ prepared: root, liveRequests: 0 }));
} else {
  const plan = JSON.parse(await readFile(path.join(root, "plan.json"), "utf8"));
  baseUrl = plan.baseUrl; modelName = plan.model;
  assert.equal(plan.harnessDigest, harnessDigest);
  await assertBenchmarkCheckoutIdentity({ sourceRoot: repo, ...plan.identity });
  if (action === "live") assert.ok(args.includes("--token-budget") && args[args.indexOf("--token-budget") + 1] === "20000", "Live compatibility requires the separately authorized phase budget: --token-budget 20000");
  await save(`${action}-started.json`, { startedAt: new Date().toISOString(), identity: plan.identity });
  let model: RegisteredModel = { id: "offline", model_name: modelName, base_url: baseUrl, api_key: "offline-dummy", responses_profile: "deepseek", request_settings: { reasoningEffort: "high", maxOutputTokens: 1024 } };
  if (action === "live") {
    assert.ok(!modelName.startsWith("REQUIRES_"), "Prepare a new reviewed plan with the supplier's actual raw model ID before live execution");
    const resolved = await new ModelRegistry({ authStorage: new SystemAuthStorage() }).resolveAll();
    const matches = resolved.available.filter((entry) => (!plan.registrationId || entry.id === plan.registrationId) && entry.model_name === modelName && entry.base_url.replace(/\/+$/u, "") === baseUrl);
    assert.equal(matches.length, 1, "Register exactly one matching model in the local login UI");
    model = { ...matches[0]!, responses_profile: "deepseek", request_settings: model.request_settings! };
  }
  const originalFetch = globalThis.fetch;
  const results: Array<{ id: string; passed: boolean; usage: ReturnType<RequestAttemptLedger["snapshot"]>; error: string | null }> = [];
  let stopped = false;
  try {
    for (const item of plan.cases as typeof cases) {
      if (stopped) break;
      const workspace = path.join(root, item.id, "workspace");
      const first = await readFile(path.join(workspace, "first.txt"), "utf8"), marker = await readFile(path.join(workspace, "second.txt"), "utf8");
      let requestCount = 0;
      if (action === "offline") globalThis.fetch = async (_url, init) => {
        assert.equal(String(_url), `${baseUrl}/responses`);
        const request = JSON.parse(String(init?.body));
        assert.deepEqual(request.reasoning, { effort: "high" });
        assert.equal(request.model, modelName);
        assert.equal(request.max_output_tokens, 1024);
        const n = ++requestCount;
        assert.equal(request.input.filter((entry: { type: string }) => entry.type === "reasoning").length, n - 1);
        const reasoning = { type: "reasoning", id: `r${n}`, content: [{ type: "reasoning_text", text: "Offline fixture reasoning." }] };
        const calls = item.id === "reasoning-tools" && n <= 2 ? [{ type: "function_call", call_id: `call-${n}`, id: `item-${n}`, name: "read_file", arguments: JSON.stringify({ path: n === 1 ? "first.txt" : "second.txt" }) }] : [];
        const text = calls.length ? "" : item.id === "text" ? "OK" : marker.trim();
        const response = { id: `resp-${n}`, status: "completed", output: [reasoning, ...calls, ...(text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] : [])], output_text: text, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } } };
        return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      };
      const store = new SessionStore({ directory: path.join(root, action!, item.id, "sessions") });
      const session = await store.create({ title: item.id, titlePending: false, workspacePath: workspace, model });
      const ledger = new RequestAttemptLedger({ tokenBudget: 10_000 });
      const metrics = createBenchmarkMetricsCollector();
      let assistant = "", error: string | null = null, passed = false;
      const handle = createProductionAgent({ model, workspacePath: workspace, sessionStore: store, sessionId: () => session.id, requestAttemptLedger: ledger, skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null,
        io: { getSessionId: () => session.id, getPermissions: () => ({ mode: "read-only", web: false }), async confirmBash() { return false; }, async runBash() { throw new Error("Shell is unavailable in compatibility checks"); }, writeAssistant(text) { assistant += text; } },
        restore: { onHistoryAppend: (items) => store.appendContext(session.id, items), onUsage: (usage) => store.appendUsage(session.id, usage), onEvent(event) { const projected = projectBenchmarkEvent(event); if (projected) metrics.onEvent(projected); } },
      });
      try {
        const runner = new CodingTaskRunner({ agent: handle.agent, workflow: new CodingWorkflowRuntime({ workspacePath: workspace }), host: { async executeVerification() { throw new Error("No checks exist in this read-only fixture"); }, async getGoal() { return undefined; }, async addGoalTime() { return undefined; } } });
        const result = await runner.run({ text: item.prompt, source: "benchmark", signal: AbortSignal.timeout(15 * 60_000) });
        assert.equal(result.disposition, "completed");
        assert.equal(result.agentResult.stopReason, undefined);
        assert.ok(ledger.snapshot().complete);
        const saved = await store.load(session.id);
        const calls = saved.context.filter((entry) => entry.type === "function_call"), outputs = saved.context.filter((entry) => entry.type === "function_call_output");
        assert.equal(calls.length, outputs.length);
        for (const call of calls) assert.equal(outputs.filter((output) => output.call_id === call.call_id).length, 1);
        if (item.id === "text") assert.equal(assistant.trim(), "OK");
        else {
          assert.ok(calls.some((call) => call.name === "read_file" && JSON.parse(String(call.arguments)).path === "first.txt"));
          assert.ok(calls.some((call) => call.name === "read_file" && JSON.parse(String(call.arguments)).path === "second.txt"));
          assert.ok(assistant.includes(marker.trim()));
          assert.ok(saved.context.some((entry) => entry.type === "reasoning" && Array.isArray(entry.content) && entry.content.some((part) => part && typeof part === "object" && (part as { text?: string }).text?.trim())), "Relay did not return observable Responses reasoning content");
        }
        assert.equal(await readFile(path.join(workspace, "first.txt"), "utf8"), first);
        assert.equal(await readFile(path.join(workspace, "second.txt"), "utf8"), marker);
        passed = true;
      } catch { error = "Compatibility assertions or request failed; inspect the isolated Session and metrics."; }
      finally { try { await handle.dispose(); } catch { error = "Resource cleanup failed"; passed = false; } }
      const usage = ledger.snapshot();
      results.push({ id: item.id, passed, usage, error });
      await save(`${action}-${item.id}.json`, { passed, usage, metrics: metrics.snapshot(), error });
      stopped = !passed || !usage.complete || results.reduce((sum, run) => sum + run.usage.inputTokens + run.usage.outputTokens, 0) >= 20_000;
    }
  } finally { globalThis.fetch = originalFetch; }
  await save(`${action}-result.json`, { planned: cases.map((item) => item.id), results, skipped: cases.filter((item) => !results.some((run) => run.id === item.id)).map((item) => item.id), paidRequests: action === "offline" ? 0 : results.reduce((sum, run) => sum + run.usage.attempts.filter((attempt) => attempt.status !== "rejected").length, 0) });
  console.log(JSON.stringify({ action, passed: results.length === 2 && results.every((run) => run.passed), root }));
  if (results.length !== 2 || results.some((run) => !run.passed)) process.exitCode = 1;
}
