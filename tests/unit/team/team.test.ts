import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RequestExecutor } from "../../../src/agent/request-executor.js";
import { TeamLedger } from "../../../src/team/ledger.js";
import { TeamRuntime } from "../../../src/team/runtime.js";
import { TeamStore } from "../../../src/team/store.js";
import { createTeamWorkspace, workspaceOperations, removeTeamWorkspace, git } from "../../../src/team/workspace.js";
import { runApplyPatch, previewApplyPatch } from "../../../src/tools/apply-patch.js";
import { defaultPermissions } from "../../../src/permissions/policy.js";
import { StepToolCatalog } from "../../../src/agent/step-tool-catalog.js";
import { parseArgs } from "../../../src/cli/args.js";
import { ExecJsonlEmitter } from "../../../src/cli/exec-output.js";
import { SessionStore } from "../../../src/storage/session-store.js";
import { verifyTeamIsolation } from "../../../src/team/isolation.js";
import { createProductionAgent } from "../../../src/runtime/production.js";
import { runExec } from "../../../src/exec/runtime.js";
import { SkillManager } from "../../../src/skills/manager.js";
import { SkillCatalog } from "../../../src/skills/catalog.js";
import { projectInsights } from "../../../src/tools/project-insights.js";
import { runOfflineComparison } from "../../fixtures/team-comparison.js";
import type { TeamSnapshot } from "../../../src/team/types.js";
import type { SessionGoal } from "../../../src/storage/session-store.js";

const usage = { input_tokens: 4, output_tokens: 6, total_tokens: 10, output_tokens_details: { reasoning_tokens: 3 } };
const model = { id: "registered", model_name: "raw-model", base_url: "https://api.example.test/v1", api_key: "fixture" };
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function temporary(run: (directory: string) => Promise<void>) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ep-team-test-")); try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); } }
async function repository(directory: string) {
  await git(directory, ["init"]);
  await fs.writeFile(path.join(directory, ".gitignore"), "node_modules/\nignored.txt\n");
  await fs.writeFile(path.join(directory, "a.ts"), "\ufeffexport const a = 1;\r\n");
  await fs.writeFile(path.join(directory, "b.ts"), "export const b = 1;\n");
  await git(directory, ["add", "."]); await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
}

test("team scopes cannot reset total usage, track owners, and keep unknown sticky", async () => {
  let stopped = false;
  const ledger = new TeamLedger({ maxAttempts: 96, deadline: Date.now() + 1000, onStop: () => { stopped = true; } });
  const a = ledger.scope("a", "model-a"); const b = ledger.scope("b", "model-b");
  await new RequestExecutor(a).execute("coding", async () => ({ status: "completed", usage }));
  b.reset(); assert.equal(ledger.snapshot().inputTokens + ledger.snapshot().outputTokens, 10);
  assert.equal(ledger.snapshot().attempts[0]!.agentId, "a");
  await new RequestExecutor(b).execute("summary", async () => ({ status: "completed" }));
  assert.equal(stopped, true); assert.equal(a.usageComplete, false);
  await assert.rejects(new RequestExecutor(a).execute("coding", async () => ({ usage })), /incomplete/);
  assert.equal(ledger.snapshot().inputTokens + ledger.snapshot().outputTokens, 10);
});

test("concurrent request reservations wait, then settle exactly once before another request starts", async () => {
  const first = deferred(); const entered = deferred(); let secondStarted = false; const persisted: number[] = [];
  const ledger = new TeamLedger({ tokenBudget: 100, maxAttempts: 4, deadline: Date.now() + 3000, onStop() {} });
  ledger.setPersistence(async () => { persisted.push(ledger.openRequests); });
  const a = new RequestExecutor(ledger.scope("a", "m")); const b = new RequestExecutor(ledger.scope("b", "m"));
  const one = a.execute("coding", async () => { entered.resolve(); await first.promise; return { usage }; }, { reservation: 80 });
  await entered.promise;
  const two = b.execute("coding", async () => { secondStarted = true; return { usage }; }, { reservation: 80 });
  await Promise.resolve(); assert.equal(secondStarted, false); first.resolve(); await Promise.all([one, two]);
  assert.equal(secondStarted, true); assert.equal(ledger.snapshot().inputTokens + ledger.snapshot().outputTokens, 20);
  assert.equal(persisted[0], 1); assert.equal(ledger.openRequests, 0);
});

test("attempt cap includes concurrently admitted scopes and rejected calls spend no tokens", async () => {
  const ledger = new TeamLedger({ maxAttempts: 1, deadline: Date.now() + 1000, onStop() {} });
  const responses = await Promise.allSettled(["a", "b"].map((id) => new RequestExecutor(ledger.scope(id, "m")).execute("coding", async () => ({ usage }))));
  assert.equal(responses.filter((value) => value.status === "fulfilled").length, 1);
  assert.equal(ledger.snapshot().inputTokens + ledger.snapshot().outputTokens, 10);
});

test("dirty workspaces snapshot current bytes, preserve index, and integrate only unchanged baselines", async () => temporary(async (directory) => {
  await repository(directory);
  await fs.writeFile(path.join(directory, "a.ts"), "\ufeffexport const a = 2;\r\n"); await git(directory, ["add", "a.ts"]);
  await fs.writeFile(path.join(directory, "b.ts"), "export const b = 2;\n");
  await fs.writeFile(path.join(directory, "新文件.ts"), "export const c = 1;\n"); await fs.writeFile(path.join(directory, "ignored.txt"), "private");
  const index = await git(directory, ["diff", "--cached"]);
  const workspace = await createTeamWorkspace(directory);
  try {
    assert.equal(await fs.readFile(path.join(workspace.workspace, "新文件.ts"), "utf8"), "export const c = 1;\n");
    await assert.rejects(fs.stat(path.join(workspace.workspace, "ignored.txt")));
    assert.equal(await git(directory, ["diff", "--cached"]), index);
    await fs.writeFile(path.join(workspace.workspace, "a.ts"), "\ufeffexport const a = 3;\r\n");
    const changes = await workspaceOperations(workspace, ["a.ts"]); assert.deepEqual(changes.conflicts, []);
    assert.equal((await runApplyPatch(changes.operations, directory)).status, "applied");
    assert.deepEqual((await workspaceOperations(workspace, ["a.ts"])).operations, []);
    await fs.writeFile(path.join(directory, "a.ts"), "user concurrently changed it\n");
    assert.deepEqual((await workspaceOperations(workspace, ["a.ts"])).conflicts, ["a.ts"]);
    assert.equal(await git(directory, ["diff", "--cached"]), index);
  } finally { await removeTeamWorkspace(workspace); }
}));

test("member edits outside declared scope remain conflicts and are never applied", async () => temporary(async (directory) => {
  await repository(directory); const workspace = await createTeamWorkspace(directory);
  try { await fs.writeFile(path.join(workspace.workspace, "b.ts"), "changed\n"); assert.deepEqual((await workspaceOperations(workspace, ["a.ts"])).conflicts, ["b.ts"]); assert.equal(await fs.readFile(path.join(directory, "b.ts"), "utf8"), "export const b = 1;\n"); }
  finally { await removeTeamWorkspace(workspace); }
}));

test("team schedules only two children, routes model IDs, and cancellation awaits ownership", async () => temporary(async (directory) => {
  const release = deferred(); const both = deferred(); let active = 0; let maximum = 0; let count = 0;
  const secondary = { ...model, id: "review-model" };
  const team = new TeamRuntime({ config: { models: { reviewer: secondary.id } }, model, models: [model, secondary], workspacePath: directory, sessionId: () => "root", store: new TeamStore(path.join(directory, "state")), io: { getPermissions: defaultPermissions, confirmBash: async () => false, runBash: async () => { throw new Error("unused"); }, writeAssistant() {} },
    async executeMember(input) { active++; count++; maximum = Math.max(active, maximum); if (count === 2) both.resolve(); assert.equal(input.model.id, secondary.id); try { await release.promise; input.signal.throwIfAborted(); return { summary: "source evidence" }; } finally { active--; } },
  });
  await team.begin("default"); team.setRootInput("investigate");
  const args = JSON.stringify({ role: "reviewer", goal: "inspect", acceptance: "report evidence", paths: ["."], dependencies: [] });
  for (let i = 0; i < 3; i++) await team.dispatch("spawn_agent", args, "default");
  await both.promise; assert.equal(maximum, 2);
  const cleanup = team.cancel(); await Promise.resolve(); assert.equal(active, 2); release.resolve(); await cleanup;
  assert.equal(active, 0); assert.equal(count, 2); await team.end();
}));

test("Plan denies worker delegation and team tools are absent from ordinary requests", async () => temporary(async (directory) => {
  assert.equal(new StepToolCatalog({ mode: "default" }).has("spawn_agent"), false);
  assert.equal(new StepToolCatalog({ mode: "plan", team: true }).has("integrate_agent"), false);
  const team = new TeamRuntime({ config: {}, model, models: [model], workspacePath: directory, sessionId: () => "root", store: new TeamStore(directory), io: { confirmBash: async () => false, runBash: async () => { throw new Error("unused"); }, writeAssistant() {} }, executeMember: async () => ({ summary: "unused" }) });
  await team.begin("plan"); try { assert.equal(JSON.parse(await team.dispatch("spawn_agent", JSON.stringify({ role: "worker", goal: "change", acceptance: "tests", paths: ["."], dependencies: [] }), "plan")).status, "denied"); } finally { await team.end(); }
}));

test("team Session reference is durable and does not propagate through ordinary forks", async () => temporary(async (directory) => {
  const store = new SessionStore({ directory }); const root = await store.create({ title: "team", titlePending: false, workspacePath: directory, model: { id: model.id, model_name: model.model_name, base_url: model.base_url } });
  const teamId = randomUUID(); await store.setTeam(root.id, { teamId, state: "stopped", members: [] }); assert.equal((await store.load(root.id)).summary.team?.teamId, teamId);
  const child = await store.fork(root.id); assert.equal((await store.load(child.id)).summary.team, undefined);
}));

test("CLI team role selectors and schema v2 coexist with unchanged single-Agent v1", async () => {
  const parsed = parseArgs(["exec", "task", "--team", "--worker-model", "raw-registration", "--max-agents", "2"]);
  assert.equal(parsed.command, "exec"); if (parsed.command === "exec") { assert.equal(parsed.team?.models?.worker, "raw-registration"); assert.equal(parsed.team?.maxAgents, 2); }
  const lines: string[] = []; const emitter = new ExecJsonlEmitter({ schemaVersion: 2, write: (line) => { lines.push(line); } });
  await emitter.emit({ type: "agent_updated", teamId: "team", agentId: "agent", taskId: "task", state: "running" });
  await emitter.emit({ type: "assistant_message", text: "done" }); assert.equal(JSON.parse(lines[0]!).schema_version, 2); assert.equal(JSON.parse(lines.join("").trim().split("\n")[1]!).schema_version, 2);
  const old: string[] = []; await new ExecJsonlEmitter({ write: (line) => { old.push(line); } }).emit({ type: "assistant_message", text: "one" }); assert.equal(JSON.parse(old.join("")).schema_version, 1);
});

test("native team sandbox proves root/state/Git denial before coding, or fails closed", {
  skip: process.env.GITHUB_ACTIONS === "true" && process.platform === "win32" ? "Hosted Windows cannot initialize nested sandbox" : false,
}, async () => temporary(async (directory) => {
  await repository(directory); const workspace = await createTeamWorkspace(directory);
  try { await verifyTeamIsolation(workspace, defaultPermissions()); }
  finally { await removeTeamWorkspace(workspace); }
}));

test("production SDK requests route reviewer model with independent tools/context and one shared total", async (t) => temporary(async (directory) => {
  let rootCalls = 0; let childCalls = 0;
  const secondary = { ...model, id: "review-registration", model_name: "review-raw-id", responses_profile: "deepseek" as const };
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>; requests.push(request);
    let output: unknown[] = []; let text = "";
    if (request.model === secondary.model_name) {
      childCalls++; text = "Reviewed evidence.";
      assert.equal((request.tools as Array<{ name: string }>).some((tool) => tool.name === "spawn_agent" || tool.name === "apply_patch"), false);
      assert.equal(JSON.stringify(request.input).includes("root-private-reasoning"), false);
    } else {
      rootCalls++;
      if (rootCalls === 1) output = [{ type: "reasoning", summary: [{ type: "summary_text", text: "root-private-reasoning" }] }, { type: "function_call", id: "spawn", call_id: "spawn", name: "spawn_agent", arguments: JSON.stringify({ role: "reviewer", goal: "Review project", acceptance: "Report source evidence", paths: ["."], dependencies: [] }) }];
      else if (rootCalls === 2) output = [{ type: "function_call", id: "wait", call_id: "wait", name: "wait_agents", arguments: "{}" }];
      else text = "Review complete.";
    }
    const response = { id: `response-${requests.length}`, status: "completed", output, output_text: text, usage };
    return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const sessionStore = new SessionStore({ directory: path.join(directory, "sessions") });
  const result = await runExec({ prompt: "Review this project", model: model.id, workspacePath: directory, team: { models: { reviewer: secondary.id } } }, {
    registry: { resolveAll: async () => ({ available: [model, secondary], missing: [] }) }, sessionStore,
    createAgent: (options) => createProductionAgent({ ...options, teamStore: new TeamStore(path.join(directory, "team-state")), skills: null, mcp: null, learnedMemoryStore: null, codeNavigation: null }),
  });
  assert.equal(result.exitCode, 0, result.error);
  assert.equal(rootCalls, 3); assert.equal(childCalls, 1);
  assert.equal(result.usage!.inputTokens + result.usage!.outputTokens, 40);
  assert.equal(result.team?.members[0]?.modelId, secondary.id);
  assert.equal((await sessionStore.load(result.sessionId!)).summary.team?.teamId, result.team?.teamId);
}));

test("managed Skill previews protect local edits and update/uninstall only after commit", async () => temporary(async (directory) => {
  await fs.mkdir(path.join(directory, ".git"));
  const original = "---\nname: lifecycle\ndescription: Fixture workflow\n---\nOriginal\n";
  let contents = original;
  const manager = new SkillManager({ workspacePath: directory, catalog: new SkillCatalog(directory), lookup: async () => [{ address: "93.184.216.34", family: 4 }], fetch: async () => new Response(contents) });
  try {
    const prepared = await manager.prepareInstall("https://example.test/SKILL.md");
    const installed = await manager.installPrepared(prepared.id, prepared.candidates[0]!.id, "project");
    assert.equal((await manager.list()).find((skill) => skill.name === "lifecycle")?.managed, true);
    contents = original.replace("Original", "Updated");
    const preview = await manager.previewUpdate(installed.directory);
    assert.match(preview.diff, /Updated/); assert.equal(await fs.readFile(path.join(installed.directory, "SKILL.md"), "utf8"), original);
    await manager.commitLifecycle(preview.id); assert.equal(await fs.readFile(path.join(installed.directory, "SKILL.md"), "utf8"), contents);
    const removal = await manager.previewUninstall(installed.directory);
    await fs.writeFile(path.join(installed.directory, "SKILL.md"), `${contents}user edit\n`);
    await assert.rejects(manager.commitLifecycle(removal.id), /local modifications/);
    await fs.writeFile(path.join(installed.directory, "SKILL.md"), contents);
    const confirmed = await manager.previewUninstall(installed.directory); await manager.commitLifecycle(confirmed.id);
    await assert.rejects(fs.stat(installed.directory));
  } finally { await manager.close(); }
}));

test("project insight cache invalidates current bytes and returns only bounded metadata", async () => temporary(async (directory) => {
  await fs.writeFile(path.join(directory, "a.ts"), "import {b} from './b.js';\n");
  await fs.writeFile(path.join(directory, "a.test.ts"), "import './a.js';\n");
  const before = await projectInsights(directory, ["a.ts", "a.test.ts"]);
  assert.equal(before.relationships[0]?.test, "a.test.ts");
  await fs.writeFile(path.join(directory, "a.ts"), "import './c.js';\n");
  const after = await projectInsights(directory, ["a.ts", "a.test.ts"]);
  assert.notEqual(before.modules[0]!.sha256, after.modules[0]!.sha256); assert.deepEqual(after.modules[0]!.imports, ["./c.js"]);
}));

test("staged and unstaged deletions stay deleted without checkout filters or changes to the user index", async () => temporary(async (directory) => {
  await repository(directory); await fs.unlink(path.join(directory, "a.ts")); await git(directory, ["add", "a.ts"]); await fs.unlink(path.join(directory, "b.ts"));
  const index = await git(directory, ["diff", "--cached"]);
  const child = await createTeamWorkspace(directory);
  try { for (const file of ["a.ts", "b.ts"]) await assert.rejects(fs.stat(path.join(child.workspace, file))); assert.deepEqual((await workspaceOperations(child, ["."])).operations, []); assert.equal(await git(directory, ["diff", "--cached"]), index); }
  finally { await removeTeamWorkspace(child); }
}));

test("in-flight request IDs survive restart as unknown and prevent more requests", async () => temporary(async (directory) => {
  const store = new TeamStore(path.join(directory, "state")); const teamId = randomUUID();
  const snapshot: TeamSnapshot = { version: 1, teamId, rootSessionId: "root", workspacePath: directory, mode: "default", state: "running", options: {}, members: [], startedAt: Date.now(), elapsedMs: 5, openRequests: 1, inFlight: [{ id: 7, purpose: "coding", agentId: "root", modelId: model.id }], usage: { attempts: [], inputTokens: 0, outputTokens: 0, reasoningTokens: 0, complete: false } };
  await store.save(snapshot); const recovered = await store.load(teamId, directory, "root");
  assert.equal(recovered.state, "interrupted"); assert.equal(recovered.usage.attempts[0]!.id, 7); assert.equal(recovered.usage.attempts[0]!.usage, null);
  const ledger = new TeamLedger({ historical: recovered.usage, maxAttempts: 10, deadline: Date.now() + 1000, onStop() {} });
  await assert.rejects(new RequestExecutor(ledger.scope("root", model.id)).execute("coding", async () => ({ usage })), /incomplete/);
  await assert.rejects(store.load(teamId, directory, "other"), /Session/);
}));

test("durable admission failure never starts a provider and live team ownership cannot be stolen", async () => temporary(async (directory) => {
  let called = false; const ledger = new TeamLedger({ maxAttempts: 2, deadline: Date.now() + 1000, onStop() {} }); ledger.setPersistence(async () => { throw new Error("disk unavailable"); });
  await assert.rejects(new RequestExecutor(ledger.scope("root", model.id)).execute("coding", async () => { called = true; return { usage }; }), /disk unavailable/); assert.equal(called, false);
  const store = new TeamStore(directory); const id = randomUUID(); const release = await store.claim(id);
  try { await assert.rejects(new TeamStore(directory).claim(id), /live process/); } finally { await release(); }
  await (await store.claim(id))();
}));

test("permission tightening reaches active members before another root tool call", async () => temporary(async (directory) => {
  let policy = defaultPermissions(); const entered = deferred(); const stopped = deferred();
  const team = new TeamRuntime({ config: {}, model, models: [model], workspacePath: directory, sessionId: () => "root", store: new TeamStore(path.join(directory, "state")), io: { getPermissions: () => policy, confirmBash: async () => false, runBash: async () => { throw new Error("unused"); }, writeAssistant() {} },
    executeMember: async ({ signal }) => { entered.resolve(); await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); stopped.resolve(); signal.throwIfAborted(); return { summary: "late" }; },
  });
  await team.begin("default"); team.setRootInput("read"); await team.dispatch("spawn_agent", JSON.stringify({ role: "explorer", goal: "inspect", acceptance: "report", paths: ["."], dependencies: [] }), "default"); await entered.promise;
  policy = { ...policy, mode: "read-only" }; await stopped.promise; await team.end(); assert.equal(team.snapshot()!.members[0]!.summary, undefined);
}));

test("team Goal totals include every member once and unknown stays sticky after budget settlement", async () => temporary(async (directory) => {
  let goal: SessionGoal = { goal_id: randomUUID(), objective: "fixture", status: "active", token_budget: 100, tokens_used: 5, time_used_seconds: 0, usage_complete: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const team = new TeamRuntime({ config: {}, model, models: [model], workspacePath: directory, sessionId: () => "root", store: new TeamStore(path.join(directory, "state")), io: { getGoal: async () => goal, setGoal: async (value) => { goal = value; }, confirmBash: async () => false, runBash: async () => { throw new Error("unused"); }, writeAssistant() {} }, executeMember: async () => ({ summary: "unused" }) });
  await team.begin("default");
  try {
    await new RequestExecutor(team.accounting).execute("coding", async () => ({ usage })); await team.recordGoalUsage({ input_tokens: 4, output_tokens: 6, total_tokens: 10 }); await team.recordGoalUsage({ input_tokens: 4, output_tokens: 6, total_tokens: 10 }); assert.equal(goal.tokens_used, 15);
    await new RequestExecutor(team.accounting).execute("summary", async () => ({ status: "completed" })); await team.recordGoalUsage(null); await team.recordGoalUsage({ input_tokens: 4, output_tokens: 6, total_tokens: 10 }); assert.equal(goal.usage_complete, false); assert.equal(goal.status, "usage_limited"); assert.equal(goal.tokens_used, 15);
  } finally { await team.end(); }
}));

test("member usage changes total consumption without changing root context estimates across Session reload", async () => temporary(async (directory) => {
  const store = new SessionStore({ directory }); const session = await store.create({ title: "scope", titlePending: false, workspacePath: directory, model: { id: model.id, model_name: model.model_name, base_url: model.base_url } });
  await store.appendUsage(session.id, { input_tokens: 20, output_tokens: 30, total_tokens: 50 }); await store.appendUsage(session.id, { input_tokens: 200, output_tokens: 300, total_tokens: 500 }, { preserveContext: true });
  const loaded = await store.load(session.id); assert.equal(loaded.usage.context_tokens, 50); assert.equal(loaded.usage.input_tokens + loaded.usage.output_tokens, 550);
}));

test("two production workers integrate independently and only the root native check determines success", { skip: process.env.GITHUB_ACTIONS === "true" && process.platform === "win32" ? "Hosted Windows cannot initialize nested sandbox" : false }, async () => {
  const report = await runOfflineComparison(true); assert.equal(report.score, 1, JSON.stringify(report)); assert.equal(report.members.length, 2); assert.ok(report.members.every((member) => member.verification?.startsWith("verified") && member.state === "integrated"));
  const failed = await runOfflineComparison(true, true); assert.equal(failed.score, 0); assert.equal(failed.classification, "verification_failed"); assert.ok(failed.members.every((member) => member.verification?.startsWith("verified")));
});


test("overlapping workers and dependencies wait for integration, and individual cancellation preserves independent members", async () => temporary(async (directory) => {
  await repository(directory); const firstDone = deferred(); const secondDone = deferred(); const reviewDone = deferred(); const starts: string[] = [];
  const team = new TeamRuntime({ config: {}, model, models: [model], workspacePath: directory, sessionId: () => "root", store: new TeamStore(path.join(directory, "state")),
    io: { getPermissions: defaultPermissions, confirmBash: async () => false, runBash: async () => { throw new Error("unused"); }, writeAssistant() {}, previewPatch: (operations) => previewApplyPatch(operations, directory), runApplyPatch: (operations) => runApplyPatch(operations, directory) },
    executeMember: async ({ member, workspace, signal }) => { starts.push(member.task.goal); if (member.task.role === "reviewer") { await reviewDone.promise; signal.throwIfAborted(); return { summary: "independent review" }; } await fs.writeFile(path.join(workspace!.workspace, "a.ts"), `\ufeffexport const a = ${member.task.goal === "first" ? 2 : 3};\r\n`); (member.task.goal === "first" ? firstDone : secondDone).resolve(); return { summary: "scoped change", verification: "pending root checks" }; },
  });
  const spawn = async (role: string, goal: string, dependencies: string[] = []) => JSON.parse(await team.dispatch("spawn_agent", JSON.stringify({ role, goal, acceptance: "scoped evidence", paths: ["a.ts"], dependencies }), "default")).result.agentId as string;
  await team.begin("default"); team.setRootInput("edit sequentially and review");
  try {
    const first = await spawn("worker", "first"); await firstDone.promise; await team.dispatch("wait_agents", "{}", "default");
    const second = await spawn("worker", "second", [first]); const reviewer = await spawn("reviewer", "review");
    await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(starts.includes("second"), false);
    await team.dispatch("integrate_agent", JSON.stringify({ agent_id: first }), "default"); await secondDone.promise; await team.dispatch("wait_agents", JSON.stringify({ agent_id: second }), "default");
    await team.cancelMember(second); assert.equal(team.snapshot()!.members.find((member) => member.agentId === reviewer)!.state, "running");
    reviewDone.resolve(); await team.dispatch("wait_agents", JSON.stringify({ agent_id: reviewer }), "default"); assert.equal(team.snapshot()!.members.find((member) => member.agentId === reviewer)!.state, "completed");
  } finally { reviewDone.resolve(); await team.end(); for (const member of team.snapshot()!.members) if (member.workspacePath) await team.cleanupMember(member.agentId); }
}));

test("explicit continuation reconciles already applied bytes without replaying writes or weakening model bindings", async () => temporary(async (directory) => {
  await repository(directory); const store = new TeamStore(path.join(directory, "state")); let writes = 0; let executions = 0;
  const make = (config: { resumeTeamId?: string }, selected = model) => new TeamRuntime({ config, model: selected, models: [selected], workspacePath: directory, sessionId: () => "root", store,
    io: { getPermissions: defaultPermissions, confirmBash: async () => false, runBash: async () => { throw new Error("unused"); }, writeAssistant() {}, previewPatch: (operations) => previewApplyPatch(operations, directory), runApplyPatch: (operations) => { writes++; return runApplyPatch(operations, directory); } },
    executeMember: async ({ workspace }) => { executions++; await fs.writeFile(path.join(workspace!.workspace, "a.ts"), "\ufeffexport const a = 4;\r\n"); return { summary: "complete" }; },
  });
  const team = make({}); await team.begin("default"); team.setRootInput("change a"); const member = JSON.parse(await team.dispatch("spawn_agent", JSON.stringify({ role: "worker", goal: "change", acceptance: "check", paths: ["a.ts"], dependencies: [] }), "default")).result;
  await team.dispatch("wait_agents", "{}", "default"); const record = team.snapshot()!;
  const workspace = await import("../../../src/team/workspace.js").then(({ loadTeamWorkspace }) => loadTeamWorkspace(record.members[0]!.workspacePath!, directory));
  // Simulate a crash after patch application and before integration-result persistence.
  await runApplyPatch((await workspaceOperations(workspace, ["a.ts"])).operations, directory); await team.end();
  const rejected = make({ resumeTeamId: record.teamId }, { ...model, model_name: "changed-raw-model" }); await assert.rejects(rejected.begin("default"), /model\/profile/); await rejected.end();
  const resumed = make({ resumeTeamId: record.teamId }); await resumed.begin("default"); resumed.setRootInput("continue");
  try { await resumed.dispatch("integrate_agent", JSON.stringify({ agent_id: member.agentId }), "default"); assert.equal(writes, 0); assert.equal(executions, 1); assert.equal(resumed.snapshot()!.members[0]!.state, "integrated"); } finally { await resumed.end(); await resumed.cleanupMember(member.agentId); }
}));


test("long Unicode paths preserve raw BOM and CRLF during snapshot and integration", async () => temporary(async (directory) => {
  await repository(directory);
  const name = ["长路径".repeat(25), "nested-".repeat(12), "目录".repeat(40), "模块.ts"].join("/");
  await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
  const original = "\ufeffexport const 中文 = 1;\r\n"; const target = original.replace("1", "2");
  await fs.writeFile(path.join(directory, name), original);
  const child = await createTeamWorkspace(directory);
  try {
    assert.equal(await fs.readFile(path.join(child.workspace, name), "utf8"), original);
    await fs.writeFile(path.join(child.workspace, name), target);
    const changes = await workspaceOperations(child, [name]); assert.deepEqual(changes.conflicts, []);
    assert.equal((await runApplyPatch(changes.operations, directory)).status, "applied");
    assert.equal(await fs.readFile(path.join(directory, name), "utf8"), target);
  } finally { await removeTeamWorkspace(child); }
}));

test("worktree creation stays on the captured commit when the source HEAD advances after snapshot", async () => temporary(async (directory) => {
  await repository(directory);
  const head = (await git(directory, ["rev-parse", "HEAD"])).trim();
  const child = await createTeamWorkspace(directory, undefined, async () => {
    await fs.writeFile(path.join(directory, "later.ts"), "export const later = true;\n");
    await git(directory, ["add", "later.ts"]);
    await git(directory, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "advance fixture"]);
  });
  try {
    assert.notEqual((await git(directory, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal((await git(child.workspace, ["rev-parse", "HEAD"])).trim(), head);
    assert.equal((await git(child.workspace, ["ls-files", "later.ts"])).trim(), "");
    assert.equal(await fs.readFile(path.join(child.workspace, "a.ts"), "utf8"), "\ufeffexport const a = 1;\r\n");
    assert.equal(await fs.readFile(path.join(directory, "later.ts"), "utf8"), "export const later = true;\n");
  } finally { await removeTeamWorkspace(child); }
}));
