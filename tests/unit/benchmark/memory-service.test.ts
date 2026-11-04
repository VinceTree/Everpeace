import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryServiceAdmission, memorySampleGate } from "../../../src/benchmark/memory-service.js";
import { memoryServiceFailure } from "../../../src/benchmark/memory-service-errors.js";
import { MemoryRequestGate, jsonFiles, readJson, writeJson, type MemoryRequestRecord } from "../../../src/benchmark/memory-evidence.js";
import { allowFailedPublicUnknown, freezePublicContinuation, verifyPublicContinuation } from "../../../src/benchmark/memory-public-continuation.js";
import { DEFAULT_MEMORY_CONFIG, type MemoryCampaignManifest } from "../../../src/benchmark/memory-campaign.js";
import { digest, type MemoryPlanItem } from "../../../src/benchmark/memory-data.js";
import { memoryReport } from "../../../src/benchmark/memory-report.js";
import type { AgentResponse, ResponsesClientLike } from "../../../src/agent/model-protocol.js";

const response = (): AgentResponse => ({ id: "test", status: "completed", output: [], output_text: "yes", usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
const item: MemoryPlanItem = { key: "q-1-no-memory", questionId: "q", repetition: 1, arm: "no-memory", historyHash: "h" };
const identity = { revision: "r", sourceDigest: "source", buildDigest: "build", node: "22", entryPath: "entry" };
const manifest = (): MemoryCampaignManifest => ({ schema: 1, config: DEFAULT_MEMORY_CONFIG, identity, files: {}, planned: [item], categories: {}, createdAt: "date" });
async function temporary(run: (directory: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), "memory-service-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }

test("service metadata is bounded and excludes secret-bearing provider text", () => {
  const error = Object.assign(new Error("secret-body"), { status: 503, code: "server_error", headers: { "retry-after": "2", authorization: "secret-key" } });
  assert.deepEqual(memoryServiceFailure(error), { category: "unknown", transient: true, httpStatus: 503, code: "server_error", retryAfterSeconds: 2 });
  assert.equal(memoryServiceFailure({ status: 401, message: "invalid api key" }).transient, false);
  assert.equal(memoryServiceFailure({ status: 400 }).transient, false);
  assert.ok(!JSON.stringify(memoryServiceFailure(error)).includes("secret"));
});

test("service pause drains active requests, persists before new admission and preserves global limit", async () => {
  const pauses: unknown[] = []; let fatal = false;
  const admission = new MemoryServiceAdmission({ limit: 2, cooldownMs: 10, maxCooldownMs: 20, persist: async pause => { pauses.push(pause); }, fatal: () => { fatal = true; }, stopReason: () => undefined });
  const signal = new AbortController().signal;
  const a = await admission.enter(signal), b = await admission.enter(signal);
  admission.pause("failed", "usage_unknown"); let entered = false;
  const next = admission.enter(signal).then(release => { entered = true; return release; });
  await delay(30); assert.equal(entered, false); a(); await delay(5); assert.equal(entered, false); b();
  const release = await next; assert.equal(pauses.length, 1); assert.equal(admission.peak, 2); assert.equal(fatal, false); release(); await admission.close();
});

test("pause evidence failure and explicit cancellation prevent new provider admission", async () => {
  let reason: string | undefined;
  const admission = new MemoryServiceAdmission({ limit: 1, cooldownMs: 5, maxCooldownMs: 5, persist: async () => { throw Error("disk"); }, fatal: () => { reason = "storage_failed"; }, stopReason: () => reason });
  admission.pause("q", "service_error"); await assert.rejects(admission.enter(new AbortController().signal)); await admission.close();
  assert.equal(reason, "storage_failed");
  const blocked = new MemoryServiceAdmission({ limit: 1, cooldownMs: 1, maxCooldownMs: 1, persist: async () => {}, fatal: () => {}, stopReason: () => undefined });
  const controller = new AbortController(), release = await blocked.enter(controller.signal), waiting = blocked.enter(controller.signal);
  controller.abort(); await assert.rejects(waiting); release(); await blocked.close();
});

test("a closed unknown sample is never replayed and another independent sample can continue", async () => temporary(async root => {
  const campaign = new MemoryRequestGate(path.join(root, "requests")); let calls = 0;
  const admission = new MemoryServiceAdmission({ limit: 2, cooldownMs: 1, maxCooldownMs: 2, persist: async () => {}, fatal: e => campaign.failStorage(e), stopReason: () => campaign.stopReason });
  const first = memorySampleGate(campaign.directory, item.key, campaign, admission);
  const client: ResponsesClientLike = { responses: { async create() { calls++; if (calls === 1) throw Error("transport"); return response(); } } };
  await assert.rejects(first.request(client, `${item.key}:answer`, "answer", {}));
  assert.equal(first.serviceStopped, true); assert.equal(campaign.stopReason, undefined);
  await assert.rejects(first.request(client, `${item.key}:again`, "answer", {})); assert.equal(calls, 1);
  const second = memorySampleGate(campaign.directory, "other", campaign, admission);
  await second.request(client, "other:answer", "answer", {}); assert.equal(calls, 2);
  await writeJson(path.join(root, "samples", item.key, "result.json"), { ...item, type: "single-session-user", status: "failed", correct: null, durationMs: 1 });
  const unknown = await readJson<MemoryRequestRecord>((await jsonFiles(campaign.directory)).find(file => file.endsWith(`${digest(`${item.key}:answer`)}.json`))!);
  assert.equal(unknown.usage.complete, false);
  await assert.rejects(campaign.validateRecovery());
  await campaign.validateRecovery(record => allowFailedPublicUnknown(root, [item], record));
  await writeJson(path.join(root, "requests", "pending.json"), { ...unknown, state: "pending", openRequests: 1 });
  await assert.rejects(campaign.validateRecovery(async () => true)); await admission.close();
}));

test("authentication remains fatal to independent samples", async () => temporary(async root => {
  const campaign = new MemoryRequestGate(root);
  const admission = new MemoryServiceAdmission({ limit: 2, cooldownMs: 1, maxCooldownMs: 1, persist: async () => {}, fatal: () => {}, stopReason: () => campaign.stopReason });
  const sample = memorySampleGate(root, "q", campaign, admission);
  await assert.rejects(sample.request({ responses: { async create() { throw Object.assign(Error("unauthorized"), { status: 401 }); } } }, "q:answer", "answer", {}));
  assert.equal(campaign.stopReason, "service_authentication"); await admission.close();
}));

test("public continuation freezes completed and failed outcomes and rejects changed or unresolved evidence", async () => temporary(async root => {
  const parent = manifest(), preflight = { manifest: digest(JSON.stringify(parent)), identity };
  await writeJson(path.join(root, "manifest.json"), parent); await writeJson(path.join(root, "preflight.json"), preflight);
  await writeJson(path.join(root, "run-state.json"), { stopReason: "service_error" });
  const { writeFile } = await import("node:fs/promises"); await writeFile(path.join(root, "preflight.sha256"), digest(JSON.stringify(preflight)));
  const resultFile = path.join(root, "samples", item.key, "result.json");
  await writeJson(resultFile, { ...item, type: "single-session-user", status: "failed", correct: null, durationMs: 1 });
  const frozen = await freezePublicContinuation(root, DEFAULT_MEMORY_CONFIG, [item]);
  assert.equal(frozen.results[0]?.retainedSourceDigest, "source"); await verifyPublicContinuation(frozen);
  await writeJson(resultFile, { ...item, status: "completed", correct: false, durationMs: 1, hypothesis: "wrong", retrieval: { text: "", sources: [] } });
  await assert.rejects(verifyPublicContinuation(frozen), /identity/u);
  const completed = await freezePublicContinuation(root, DEFAULT_MEMORY_CONFIG, [item]); assert.equal(completed.results[0]?.correct, false);
  await writeJson(path.join(root, "requests", "pending.json"), { key: `${item.key}:answer`, state: "pending", openRequests: 1, usage: { complete: false } });
  await assert.rejects(freezePublicContinuation(root, DEFAULT_MEMORY_CONFIG, [item]), /unresolved/u);
}));

test("continuation report includes historical public costs once and disables formal inference", async () => temporary(async root => {
  await writeJson(path.join(root, "manifest.json"), { ...manifest(), executionPolicy: "continue-unrun" });
  await writeJson(path.join(root, "references.json"), [{ id: "q", answer: "yes", evidence: [] }]);
  await writeJson(path.join(root, "history.json"), [{ id: "q", question: "question" }]);
  await writeJson(path.join(root, "samples", item.key, "result.json"), { ...item, type: "single-session-user", status: "completed", correct: true, hypothesis: "yes", durationMs: 1 });
  const usage = { attempts: [], inputTokens: 5, outputTokens: 2, reasoningTokens: 0, complete: true };
  const old = { key: `${item.key}:old`, phase: "answer", state: "settled", openRequests: 0, usage };
  await writeJson(path.join(root, "public-continuation.json"), { results: [{}], requests: [old] });
  await writeJson(path.join(root, "continuation.json"), { parentRoot: "old", retained: [], historical: { knownInputOutputTokens: 100, complete: false, unknownRequestCount: 3 } });
  await writeJson(path.join(root, "requests", "new.json"), { ...old, key: `${item.key}:new`, usage: { ...usage, inputTokens: 8 } });
  await writeJson(path.join(root, "coding", "live-result.json"), { records: [], skipped: [], knownTokens: 0, stopReason: null });
  const { writeFile } = await import("node:fs/promises"); await writeFile(path.join(root, "coding/results.jsonl"), "");
  await memoryReport(root);
  const report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
  const total = JSON.parse(await readFile(path.join(root, "campaign-usage.json"), "utf8"));
  assert.equal(report.publicUsage.inputTokens + report.publicUsage.outputTokens, 17);
  assert.equal(total.knownInputOutputTokens, 110); assert.equal(total.unknownRequestCount, 3); assert.equal(total.complete, false);
  assert.equal(report.complete, false); assert.equal(report.mainComparison.interval95, null);
}));
