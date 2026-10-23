import assert from "node:assert/strict";
import { test } from "node:test";
import { pairedSuccessInterval } from "../../../src/benchmark/paired-statistics.js";
import { runBenchmarkCampaign } from "../../../src/benchmark/campaign.js";

test("paired intervals cluster repeated measurements by task and reject incomplete pairs", async () => {
  const tasks = ["one", "two"].map(id => ({ id, prompt: "fixture", workspacePath: process.cwd() }));
  const campaign = await runBenchmarkCampaign(tasks, ["a", "b"].map(name => ({ name, async run() { return { usage: { inputTokens: 1, outputTokens: 1, complete: true } }; } })), { campaignId: "clusters", seed: 1, repetitions: 5, ordering: "paired", liveApi: true, taskTokenBudget: 10, campaignTokenBudget: 200, async prepareRun(task) { return task; } });
  const asymmetric = { ...campaign, results: campaign.results.map(run => ({ ...run, status: run.adapter === "b" || run.taskId === "one" ? "passed" as const : "failed" as const })) };
  const interval = pairedSuccessInterval(asymmetric, "a", "b");
  assert.equal(interval.taskClusters, 2); assert.equal(interval.pairedDifference, 0.5); assert.deepEqual(interval.interval95, [0, 1]);
  assert.deepEqual(pairedSuccessInterval(asymmetric, "a", "b"), interval);
  assert.equal(pairedSuccessInterval({ ...asymmetric, results: asymmetric.results.slice(1) }, "a", "b").interval95, null);
});
