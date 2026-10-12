import assert from "node:assert/strict";
import { test } from "node:test";
import { publicBenchmarkReport, benchmarkMarkdown } from "../../../src/benchmark/report.js";
import { runBenchmarkCampaign } from "../../../src/benchmark/campaign.js";
test("public report preserves the planned denominator and keeps unknown usage orthogonal", async () => {
  const campaign = await runBenchmarkCampaign(["one", "two"].map((id) => ({ id, prompt: "fixture", workspacePath: process.cwd() })), [{ name: "offline", async run(_task, context) { context.requestAttemptLedger?.begin("coding"); return {}; } }], { campaignId: "fixture", seed: 1, repetitions: 1, taskTokenBudget: 10, campaignTokenBudget: 20, liveApi: true, async prepareRun(task) { return task; } });
  const report = publicBenchmarkReport(campaign, { realModelRuns: false });
  assert.equal(report.planned, 2); assert.equal(report.unknownUsage, 1); assert.equal(report.outcomes.skipped, 1); assert.equal(report.realModelRuns, 0); assert.equal(report.evidence, "insufficient");
  const recordedRequest = { ...campaign, results: campaign.results.map((result) => ({ ...result, requestAttempts: 1 })) };
  assert.equal(publicBenchmarkReport(recordedRequest, { realModelRuns: true }).realModelRuns, 1);
  const noRequests = { ...campaign, results: campaign.results.map((result) => ({ ...result, requestAttempts: 0, metrics: { ...result.metrics, samplingAttempts: 0 } })) };
  assert.equal(publicBenchmarkReport(noRequests, { realModelRuns: true }).realModelRuns, 0);
  assert.match(benchmarkMarkdown(report), /Success \/ planned: 0 \/ 2/u);
  assert.throws(() => publicBenchmarkReport({ ...campaign, planned: campaign.planned.slice(0, 1) }, { realModelRuns: false }));
  assert.throws(() => publicBenchmarkReport({ ...campaign, results: [...campaign.results, ...campaign.results] }, { realModelRuns: false }));
  assert.throws(() => publicBenchmarkReport({ ...campaign, skipped: [] }, { realModelRuns: false }));
});
