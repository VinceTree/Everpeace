import assert from "node:assert/strict";
import { test } from "node:test";
import { CandidateRepairPolicy } from "../../../src/benchmark/repair-policy.js";
import { createWorkflowState } from "../../../src/workflow/types.js";
import { createBenchmarkCampaignPlan } from "../../../src/benchmark/campaign.js";
import { parseCampaignConfig } from "../../../src/benchmark/campaign-cli.js";

test("paired plans retain every task and alternate matched arms without replacement", () => {
  const tasks = Array.from({ length: 19 }, (_, i) => ({ id: String(i), prompt: "synthetic", workspacePath: process.cwd() }));
  const harnesses = ["baseline", "candidate"].map((name) => ({ name, async run() {} }));
  const plan = createBenchmarkCampaignPlan(tasks, harnesses, 3, 11, "paired");
  assert.equal(plan.length, 114); assert.equal(new Set(plan.map((v) => `${v.taskId}:${v.repetition}:${v.harness}`)).size, 114);
  for (let i = 0; i < plan.length; i += 2) { assert.equal(plan[i]?.taskId, plan[i + 1]?.taskId); assert.equal(plan[i]?.repetition, plan[i + 1]?.repetition); assert.notEqual(plan[i]?.harness, plan[i + 1]?.harness); }
  assert.deepEqual(plan, createBenchmarkCampaignPlan(tasks, harnesses, 3, 11, "paired"));
});
test("candidate repair allocation treats authorization as a stop, and unchanged evidence is bounded", () => {
  const policy = new CandidateRepairPolicy(); const state = createWorkflowState("fixture", undefined, "benchmark"); state.workspace_revision = "one";
  state.last_verification = { command: { id: "node:typecheck", label: "Typecheck", command: "pnpm typecheck", tier: "fast", timeoutMs: 30000 }, passed: false, exitCode: 1, stdout: "type error", stderr: "", durationMs: 2, timedOut: false };
  assert.equal(policy.decision(state), undefined); assert.match(policy.decision(state)!, /unchanged/u);
  state.workspace_revision = "two"; state.repair_attempts = 2; assert.match(policy.decision(state)!, /allocation/u);
  state.repair_attempts = 0; state.last_verification.error = "POLICY_DENIED"; assert.match(policy.decision(state)!, /authorization/u);
  assert.equal(state.max_repair_attempts, 3);
});
test("named production arms cannot silently collapse into one adapter", () => {
  const config = { campaignId: "fixture", catalogPath: "tasks.json", fixtureRoot: ".", runsRoot: "runs", artifactsRoot: "artifacts", sessionsRoot: "sessions", modelId: "fixture", seed: 1, repetitions: 3, taskTokenBudget: 1000, campaignTokenBudget: 6000, ordering: "paired", harnesses: [{ kind: "everpeace", name: "baseline", repairStrategy: "baseline" }, { kind: "everpeace", name: "candidate", repairStrategy: "candidate" }] };
  assert.equal(parseCampaignConfig(config, "config.json").harnesses.length, 2);
  assert.throws(() => parseCampaignConfig({ ...config, ordering: "invalid" }, "config.json"));
});
